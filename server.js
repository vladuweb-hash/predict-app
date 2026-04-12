require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

/** HTML не кэшировать (Telegram WebView иначе держит старый index). */
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

app.get('/api/build', (req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  res.json({
    ok: true,
    version: process.env.APP_VERSION || require('./package.json').version,
    node: process.version,
    db_host: dbUrl ? new URL(dbUrl).hostname : 'MISSING',
    db_ssl: String(process.env.DATABASE_SSL || 'auto'),
    uptime: Math.round(process.uptime()),
  });
});

/** Telegram Bot API JSON (node-telegram-bot-api 0.66 has no createInvoiceLink) */
async function telegramBotApi(method, body) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN missing');
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || String(j.error_code) || 'Telegram API error');
  return j.result;
}

let bot = null;
let botUsername = '';

function initBot() {
  try {
    bot = require('./bot');
    return bot;
  } catch (e) {
    console.error('[Server] Bot import failed:', e.message);
    return null;
  }
}

// --- Telegram validation ---

function validateTelegramData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN || '').digest();
    const checkHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    if (checkHash !== hash) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (e) { return null; }
}

function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.query.initData;
  const tgUser = validateTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  req.tgUser = tgUser;
  db.touchActivity(tgUser.id).catch(() => {});
  next();
}

// --- Auth ---

app.post('/api/auth', async (req, res) => {
  try {
    const { initData, ref } = req.body;
    const tgUser = validateTelegramData(initData);
    if (!tgUser) {
      console.error('[Auth] Validation failed. initData length:', initData?.length, 'BOT_TOKEN set:', !!process.env.BOT_TOKEN);
      return res.json({ ok: false, error: 'auth_validation_failed' });
    }

    let user = await db.getUser(tgUser.id);
    const isNew = !user;
    if (!user) {
      user = await db.createUser(tgUser, ref || null);
    }

    if (req.body.chatId && user) {
      try {
        user.chat_id = req.body.chatId;
        await db.saveUser(user);
      } catch (saveErr) {
        console.error('[Auth] saveUser failed:', saveErr.message);
      }
    }

    // Фоном: полный резолв нельзя await — блокирует вход (много раундов + API цен = таймаут Telegram)
    setImmediate(() => {
      try {
        const scheduler = require('./scheduler');
        scheduler.resolveRounds().catch(e => console.error('[Auth] resolveRounds:', e.message));
        scheduler.resolveDuels().catch(e => console.error('[Auth] resolveDuels:', e.message));
      } catch (e) { console.error('[Auth] Resolve bg:', e.message); }
    });

    const totalPlayers = await db.getUsersCount();
    res.json({
      ok: true, user, isNew, botUsername,
      premium: db.isPremiumActive(user),
      weekKey: db.getWeekKey(),
      rating: db.computeLeaderboardRating(user),
      leaderboardRank: await db.getLeaderboardRank(user.telegram_id),
      totalPlayers,
    });
  } catch (e) {
    console.error('[Auth]', e.message, e.stack);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Rounds ---

app.get('/api/round/check', authMiddleware, async (req, res) => {
  try {
    const userId = req.tgUser.id;
    let active = await db.getActiveRound(userId);
    let justResolvedId = null;

    // Если час прошёл — резолвим только раунды этого юзера (быстро)
    if (active && !active.is_resolved && active.is_complete) {
      const resolveAt = new Date(active.resolve_after);
      if (resolveAt <= new Date()) {
        try {
          const scheduler = require('./scheduler');
          await scheduler.resolvePendingRoundsForUser(userId);
          justResolvedId = active.id;
          active = await db.getActiveRound(userId);
        } catch (e) { /* continue with current state */ }
      }
    }

    if (active && !active.is_resolved) {
      const questions = await db.getRoundQuestions(active.id);
      return res.json({
        ok: true, status: active.is_complete ? 'waiting' : 'in_progress',
        round: active, questions
      });
    }

    const canStart = await db.canStartRound(userId);

    // Сразу показать итог раунда, который только что закрыли (иначе экран «Начать» без цифр)
    if (justResolvedId) {
      const round = await db.getRound(justResolvedId);
      if (round && round.is_resolved) {
        const questions = await db.getRoundQuestions(justResolvedId);
        return res.json({ ok: true, status: 'show_results', round, questions, canStart });
      }
    }

    res.json({ ok: true, status: 'ready', canStart });
  } catch (e) {
    console.error('[Round/check]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/round/start', authMiddleware, async (req, res) => {
  try {
    const userId = req.tgUser.id;

    const active = await db.getActiveRound(userId);
    if (active && !active.is_resolved) {
      return res.status(400).json({ error: 'You already have an active round' });
    }

    const canStart = await db.canStartRound(userId);
    if (!canStart.ok) return res.status(400).json(canStart);

    const result = await db.createRound(userId);
    if (!result.ok) return res.status(500).json(result);

    res.json(result);
  } catch (e) {
    console.error('[Round/start]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/round/answer', authMiddleware, async (req, res) => {
  try {
    const { roundId, questionIndex, answer } = req.body;
    const userId = req.tgUser.id;

    const round = await db.getRound(roundId);
    if (!round || round.user_id != userId) return res.status(403).json({ error: 'Forbidden' });

    const result = await db.answerRoundQuestion(roundId, questionIndex, answer);
    res.json(result);
  } catch (e) {
    console.error('[Round/answer]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/round/:id/results', authMiddleware, async (req, res) => {
  try {
    const round = await db.getRound(parseInt(req.params.id));
    if (!round) return res.status(404).json({ error: 'Not found' });
    if (round.user_id != req.tgUser.id) return res.status(403).json({ error: 'Forbidden' });

    const questions = await db.getRoundQuestions(round.id);
    res.json({ ok: true, round, questions });
  } catch (e) {
    console.error('[Round/results]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/rounds/history', authMiddleware, async (req, res) => {
  try {
    const rounds = await db.getRecentRounds(req.tgUser.id, 20);
    res.json({ ok: true, rounds });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

/** Текущие цены по списку активов (для «живого» экрана ожидания, до 12 id) */
app.get('/api/prices/live', authMiddleware, async (req, res) => {
  try {
    const raw = String(req.query.ids || '');
    const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 12);
    if (ids.length === 0) return res.json({ ok: true, prices: {} });
    const prices = await db.fetchCurrentPrices(ids);
    res.json({ ok: true, prices });
  } catch (e) {
    console.error('[Prices/live]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/prices/report', authMiddleware, async (req, res) => {
  try {
    const p = req.body?.prices;
    if (p && typeof p === 'object') {
      const validAssets = new Set(db.ASSETS.map(a => a.id));
      for (const [id, price] of Object.entries(p)) {
        if (validAssets.has(id) && typeof price === 'number' && price > 0) {
          db.setCachedPrice(id, price);
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// --- Health (keep-alive: ответ сразу; резолв в фоне чтобы cron не зависал) ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() | 0 });
  setImmediate(() => {
    try {
      const scheduler = require('./scheduler');
      scheduler.resolveRounds().catch(() => {});
      scheduler.resolveDuels().catch(() => {});
    } catch (e) { /* ignore */ }
  });
});

// --- Debug ---
app.get('/api/debug/prices', async (req, res) => {
  try {
    const testIds = ['bitcoin', 'ethereum'];
    const prices = await db.fetchCurrentPrices(testIds);
    res.json({ ok: true, prices, timestamp: new Date().toISOString() });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/status', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    const users = await db.getAllUsers();
    const pendingRounds = await db.getPendingRounds();
    const pendingDuels = await db.getPendingDuels();
    res.json({
      ok: true,
      users: users.map(u => ({ id: u.telegram_id, name: u.first_name, chat_id: u.chat_id, notifications: u.notifications, rounds: u.total_rounds })),
      pending_rounds: pendingRounds.length,
      pending_duels: pendingDuels.length,
      bot_active: !!bot,
      bot_username: botUsername,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --- Sparkline (chart data) ---

app.get('/api/sparkline/:assetId', async (req, res) => {
  try {
    const data = await db.fetchSparkline(req.params.assetId);
    res.json({ ok: true, prices: data || [] });
  } catch (e) {
    res.json({ ok: true, prices: [] });
  }
});

// --- Duels ---

app.post('/api/duel/create', authMiddleware, async (req, res) => {
  try {
    const userId = req.tgUser.id;
    const canCreate = await db.canCreateDuel(userId);
    if (!canCreate.ok) return res.status(400).json(canCreate);

    const result = await db.createDuel(userId);
    if (!result.ok) return res.status(500).json(result);

    res.json(result);
  } catch (e) {
    console.error('[Duel/create]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/duel/matchmaking/join', authMiddleware, async (req, res) => {
  try {
    const r = await db.tryDuelMatchmaking(req.tgUser.id);
    if (r.ok === false) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[Duel/matchmaking/join]', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/duel/matchmaking/poll', authMiddleware, async (req, res) => {
  try {
    const r = await db.pollDuelMatchmaking(req.tgUser.id);
    res.json(r);
  } catch (e) {
    console.error('[Duel/matchmaking/poll]', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/duel/matchmaking/cancel', authMiddleware, async (req, res) => {
  try {
    await db.cancelDuelMatchmaking(req.tgUser.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/duel/cancel', authMiddleware, async (req, res) => {
  try {
    const { duelId } = req.body;
    const result = await db.cancelDuel(duelId, req.tgUser.id);
    res.json(result);
  } catch (e) {
    console.error('[Duel/cancel]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/duel/join', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const duel = await db.getDuelByCode(code);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });

    if (Number(duel.creator_id) === Number(req.tgUser.id)) {
      const questions = await db.getDuelQuestions(duel.id);
      return res.json({
        ok: true,
        duel_id: duel.id,
        creator_id: duel.creator_id,
        questions,
        resolve_after: duel.resolve_after,
        is_own: true,
      });
    }

    const result = await db.joinDuel(duel.id, req.tgUser.id);
    if (!result.ok) return res.status(400).json(result);

    const questions = await db.getDuelQuestions(duel.id);
    res.json({
      ok: true,
      duel_id: duel.id,
      creator_id: duel.creator_id,
      questions,
      resolve_after: duel.resolve_after,
      already_opponent: !!result.already_opponent,
    });
  } catch (e) {
    console.error('[Duel/join]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/duel/answer', authMiddleware, async (req, res) => {
  try {
    const { duelId, questionIndex, answer } = req.body;
    const result = await db.answerDuelQuestion(duelId, req.tgUser.id, questionIndex, answer);
    res.json(result);
  } catch (e) {
    console.error('[Duel/answer]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/duel/:id', authMiddleware, async (req, res) => {
  try {
    const duel = await db.getDuel(parseInt(req.params.id));
    if (!duel) return res.status(404).json({ error: 'Not found' });

    const questions = await db.getDuelQuestions(duel.id);
    res.json({ ok: true, duel, questions });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/duels/history', authMiddleware, async (req, res) => {
  try {
    const raw = await db.getUserDuels(req.tgUser.id, 20);
    const myId = Number(req.tgUser.id);
    const duels = raw.map(d => {
      const isCreator = Number(d.creator_id) === myId;
      const oppName = isCreator
        ? (d.opponent_username ? '@' + d.opponent_username : d.opponent_name || null)
        : (d.creator_username ? '@' + d.creator_username : d.creator_name || null);
      const totalQ = Number(d.total_q) || 5;
      const myAnswered = isCreator ? Number(d.creator_answered) : Number(d.opponent_answered);
      const oppAnswered = isCreator ? Number(d.opponent_answered) : Number(d.creator_answered);
      return {
        id: d.id, creator_id: d.creator_id, opponent_id: d.opponent_id,
        is_resolved: d.is_resolved, is_draw: d.is_draw, winner_id: d.winner_id,
        creator_correct: d.creator_correct, opponent_correct: d.opponent_correct,
        started_at: d.started_at, both_answered: d.both_answered,
        opponent_display: oppName,
        total_q: totalQ, my_answered: myAnswered, opp_answered: oppAnswered,
      };
    });
    res.json({ ok: true, duels });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Friends ---

app.get('/api/friends', authMiddleware, async (req, res) => {
  try {
    const friends = await db.getFriends(req.tgUser.id);
    const requests = await db.getFriendRequests(req.tgUser.id);
    const safe = friends.map(f => ({
      telegram_id: f.telegram_id,
      name: f.username ? '@' + f.username : f.first_name || 'Игрок',
      rating: db.computeLeaderboardRating(f),
      total_5of5: f.total_5of5 ?? 0,
      best_streak: f.best_streak ?? 0,
      duel_wins: f.duel_wins ?? 0,
      total_rounds: f.total_rounds ?? 0,
      avatar_emoji: f.avatar_emoji || '',
      title: f.title || '',
    }));
    const safeReq = requests.map(r => ({
      telegram_id: r.telegram_id,
      name: r.username ? '@' + r.username : r.first_name || 'Игрок',
    }));
    res.json({ ok: true, friends: safe, requests: safeReq });
  } catch (e) {
    console.error('[Friends]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/friends/add', authMiddleware, async (req, res) => {
  try {
    const { friendId } = req.body;
    if (!friendId) return res.status(400).json({ ok: false, error: 'friendId required' });
    const r = await db.sendFriendRequest(req.tgUser.id, friendId);
    res.json(r);
  } catch (e) {
    console.error('[Friends/add]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/friends/accept', authMiddleware, async (req, res) => {
  try {
    const { friendId } = req.body;
    const r = await db.acceptFriendRequest(req.tgUser.id, friendId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/friends/remove', authMiddleware, async (req, res) => {
  try {
    const { friendId } = req.body;
    const r = await db.removeFriend(req.tgUser.id, friendId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Premium ---

app.post('/api/premium/buy', authMiddleware, async (req, res) => {
  try {
    if (!process.env.BOT_TOKEN) return res.status(500).json({ error: 'Сервер без токена бота' });

    let link;
    if (bot && typeof bot.createInvoiceLink === 'function') {
      link = await bot.createInvoiceLink(
        '⭐ Premium — 1 неделя',
        'Раунд каждый час, безлимит дуэлей, больше шансов на призы!',
        'premium_week',
        '',
        'XTR',
        [{ label: 'Premium 1 неделя', amount: 25 }]
      );
    } else {
      link = await telegramBotApi('createInvoiceLink', {
        title: '⭐ Premium — 1 неделя',
        description: 'Раунд каждый час, безлимит дуэлей, больше шансов на призы!',
        payload: 'premium_week',
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Premium 1 неделя', amount: 25 }],
      });
    }
    res.json({ ok: true, invoiceUrl: link });
  } catch (e) {
    console.error('[Premium] Invoice link error:', e.message);
    res.status(500).json({ error: e.message || 'Не удалось создать счёт' });
  }
});

// --- Profile ---

app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUser(req.tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const achievements = await db.getAchievements(user.telegram_id);
    const weekKey = db.getWeekKey();
    const tickets = await db.getUserTickets(user.telegram_id, weekKey);
    const raffle = await db.getRaffle(weekKey);

    res.json({
      ok: true, user,
      premium: db.isPremiumActive(user),
      achievements,
      achievementDefs: db.ACHIEVEMENT_DEFS,
      weekKey,
      tickets: tickets.length,
      raffle,
      rating: db.computeLeaderboardRating(user),
      leaderboardRank: await db.getLeaderboardRank(user.telegram_id),
      totalPlayers: await db.getUsersCount(),
    });
  } catch (e) {
    console.error('[Profile]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

const AVATARS = ['😎','🤠','🦊','🐺','🦁','🐲','🦅','🐬','🎯','🔥','💎','⚡','🌟','👑','🎮','🏆','🦉','🐦','🗿','🏛️','🔮','📜','✨','🎖️','🏃','📢','👥','🤖'];
const FAV_ASSETS = ['BTC','ETH','BNB','SOL','XRP','DOGE','TON','USD/RUB','EUR/USD'];
const STRATEGIES = ['bull','bear','neutral'];
const FRAMES = ['','gold','blue','green','red','purple','rainbow'];

const PROFILE_FIELDS = ['bio','avatar_emoji','title','fav_asset','strategy','profile_frame'];
const POINTS_PER_FIELD = 15;

function countFilledFields(user) {
  let c = 0;
  if (user.bio) c++;
  if (user.avatar_emoji) c++;
  if (user.title) c++;
  if (user.fav_asset) c++;
  if (user.strategy) c++;
  if (user.profile_frame) c++;
  return c;
}

app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUser(req.tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { bio, avatar_emoji, title, fav_asset, strategy, profile_frame } = req.body;

    if (bio !== undefined) user.bio = String(bio).slice(0, 60);
    if (avatar_emoji !== undefined) user.avatar_emoji = AVATARS.includes(avatar_emoji) ? avatar_emoji : '';
    if (title !== undefined) {
      const achievements = await db.getAchievements(user.telegram_id);
      const unlockedBadges = achievements.map(a => {
        const def = db.ACHIEVEMENT_DEFS.find(d => d.type === a.type);
        return def?.badge;
      }).filter(Boolean);
      user.title = (title === '' || unlockedBadges.includes(title)) ? title : user.title;
    }
    if (fav_asset !== undefined) user.fav_asset = FAV_ASSETS.includes(fav_asset) ? fav_asset : '';
    if (strategy !== undefined) user.strategy = STRATEGIES.includes(strategy) ? strategy : '';
    if (profile_frame !== undefined) user.profile_frame = FRAMES.includes(profile_frame) ? profile_frame : '';

    const filled = countFilledFields(user);
    user.bonus_points = filled * POINTS_PER_FIELD;

    await db.saveUser(user);
    res.json({ ok: true, bonus_points: user.bonus_points, filled, total: PROFILE_FIELDS.length });
  } catch (e) {
    console.error('[ProfileUpdate]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/profile/:id', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!targetId) return res.status(400).json({ error: 'Bad id' });

    const user = await db.getUser(targetId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const achievements = await db.getAchievements(user.telegram_id);

    res.json({
      ok: true,
      user: {
        first_name: user.first_name,
        username: user.username,
        total_rounds: user.total_rounds,
        total_5of5: user.total_5of5,
        best_streak: user.best_streak,
        duel_wins: user.duel_wins,
        duel_losses: user.duel_losses,
        bio: user.bio || '',
        avatar_emoji: user.avatar_emoji || '',
        title: user.title || '',
        fav_asset: user.fav_asset || '',
        strategy: user.strategy || '',
        profile_frame: user.profile_frame || '',
      },
      achievements,
      achievementDefs: db.ACHIEVEMENT_DEFS,
      rating: db.computeLeaderboardRating(user),
      leaderboardRank: await db.getLeaderboardRank(user.telegram_id),
      totalPlayers: await db.getUsersCount(),
    });
  } catch (e) {
    console.error('[PublicProfile]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Leaderboard (публичный JSON: без telegram_id; isMe только при валидном initData) ---

function numLeaderboardScore(v) {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function leaderboardDisplayName(row) {
  const u = (row.username || '').trim();
  if (u) return '@' + u.replace(/^@/, '');
  const fn = (row.first_name || '').trim();
  if (fn) return fn;
  return 'Игрок';
}

app.get('/api/leaderboard', async (req, res) => {
  try {
    const raw = await db.getLeaderboard();
    const initData = req.headers['x-telegram-init-data'] || req.query.initData;
    const tgUser = validateTelegramData(initData);
    const myId = tgUser ? Number(tgUser.id) : null;

    const board = raw.map((row, i) => {
      const isMe = myId != null && Number(row.telegram_id) === myId;
      const entry = {
        rank: i + 1,
        name: leaderboardDisplayName(row),
        rating: numLeaderboardScore(row.rating_score),
        total_5of5: row.total_5of5 ?? 0,
        best_streak: row.best_streak ?? 0,
        duel_wins: row.duel_wins ?? 0,
        total_rounds: row.total_rounds ?? 0,
        avatar_emoji: row.avatar_emoji || '',
        title: row.title || '',
        isMe,
      };
      if (myId != null && !isMe) entry.tid = Number(row.telegram_id);
      return entry;
    });

    const payload = {
      ok: true,
      board,
      totalPlayers: await db.getUsersCount(),
      ratingFormula: {
        per5of5: 140,
        perBestStreak: 35,
        perDuelWin: 25,
        perRoundUpTo: db.LB_ROUND_CAP,
        note: 'Очки = 140×идеал + 35×лучшая серия 5/5 + 25×победы в дуэлях + сыгранные раунды (макс. ' + db.LB_ROUND_CAP + ')',
      },
    };
    if (myId != null) {
      const meUser = await db.getUser(myId);
      payload.yourRank = await db.getLeaderboardRank(myId);
      payload.yourRating = db.computeLeaderboardRating(meUser);
      payload.inTop = board.some((r) => r.isMe);
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/leaderboard/weekly', authMiddleware, async (req, res) => {
  try {
    const raw = await db.getWeeklyLeaderboard(50);
    const myId = Number(req.tgUser.id);
    const { monday } = db.getWeekBounds();
    const weekKey = db.getWeekKey();

    const board = raw.map((row, i) => {
      const isMe = Number(row.telegram_id) === myId;
      const entry = { rank: i + 1, name: leaderboardDisplayName(row), points: row.total_pts, avatar_emoji: row.avatar_emoji || '', title: row.title || '', isMe };
      if (!isMe) entry.tid = Number(row.telegram_id);
      return entry;
    });

    const myRank = await db.getWeeklyRank(myId);
    const myEntry = raw.find(r => Number(r.telegram_id) === myId);

    res.json({
      ok: true,
      weekKey,
      weekStart: monday.toISOString(),
      board,
      yourRank: myRank,
      yourPoints: myEntry ? myEntry.total_pts : 0,
    });
  } catch (e) {
    console.error('[WeeklyLB]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Championship ---

app.get('/api/championship', authMiddleware, async (req, res) => {
  try {
    const weekKey = db.getWeekKey();
    const champ = await db.getOrCreateChampionship(weekKey);
    const entries = await db.getChampionshipEntries(champ.id);
    const isParticipant = entries.some(e => Number(e.user_id) === Number(req.tgUser.id));
    const dayNumber = db.getChampionshipDayNumber();
    const champRound = await db.getChampionshipRound(champ.id, dayNumber);

    let todayAnswered = 0;
    let todayTotal = 0;
    let todayQuestions = null;
    let userAnswers = [];

    if (champRound) {
      const questions = await db.getChampRoundQuestions(champRound.id);
      todayTotal = questions.length;
      if (isParticipant) {
        userAnswers = await db.getUserChampAnswers(champRound.id, req.tgUser.id);
        todayAnswered = userAnswers.length;
        todayQuestions = questions.map((q, i) => {
          const ua = userAnswers.find(a => a.question_index === i);
          return {
            index: i,
            asset: q.asset,
            label: q.asset_label,
            emoji: q.asset_emoji,
            price_at_start: q.price_at_start,
            answered: !!ua,
            user_answer: ua?.answer || null,
            is_correct: ua?.is_correct ?? null,
            correct_answer: champRound.is_resolved ? q.correct_answer : null,
            price_at_resolve: champRound.is_resolved ? q.price_at_resolve : null,
          };
        });
      }
    }

    res.json({
      ok: true,
      championship: {
        id: champ.id,
        week_key: champ.week_key,
        entry_fee: champ.entry_fee,
        prize_pool: champ.prize_pool,
        status: champ.status,
        min_players: champ.min_players,
        commission_pct: champ.commission_pct,
        participants: entries.length,
      },
      isParticipant,
      dayNumber,
      todayRound: champRound ? {
        id: champRound.id,
        is_resolved: champRound.is_resolved,
        resolve_after: champRound.resolve_after,
      } : null,
      todayAnswered,
      todayTotal,
      todayQuestions,
      leaderboard: entries.slice(0, 20).map((e, i) => ({
        place: i + 1,
        user_id: e.user_id,
        username: e.username,
        first_name: e.first_name,
        total_score: e.total_score,
        rounds_played: e.rounds_played,
      })),
    });
  } catch (e) {
    console.error('[Championship]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/championship/join', authMiddleware, async (req, res) => {
  try {
    const weekKey = db.getWeekKey();
    const champ = await db.getOrCreateChampionship(weekKey);

    const already = await db.isChampionshipParticipant(champ.id, req.tgUser.id);
    if (already) return res.json({ ok: true, already: true });

    let invoiceUrl;
    const title = `🏆 Чемпионат ${weekKey}`;
    const desc = `Вход в еженедельный чемпионат. Призовой пул растёт с каждым участником!`;
    const payload = `champ_${champ.id}_${req.tgUser.id}`;

    if (bot && typeof bot.createInvoiceLink === 'function') {
      invoiceUrl = await bot.createInvoiceLink(title, desc, payload, '', 'XTR',
        [{ label: `Вход ${champ.entry_fee}⭐`, amount: champ.entry_fee }]);
    } else {
      invoiceUrl = await telegramBotApi('createInvoiceLink', {
        title, description: desc, payload,
        provider_token: '', currency: 'XTR',
        prices: [{ label: `Вход ${champ.entry_fee}⭐`, amount: champ.entry_fee }],
      });
    }
    res.json({ ok: true, invoiceUrl });
  } catch (e) {
    console.error('[Championship/join]', e);
    res.status(500).json({ error: e.message || 'Не удалось создать счёт' });
  }
});

app.post('/api/championship/answer', authMiddleware, async (req, res) => {
  try {
    const { questionIndex, answer } = req.body;
    const weekKey = db.getWeekKey();
    const champ = await db.getChampionship(weekKey);
    if (!champ) return res.status(404).json({ error: 'Чемпионат не найден' });

    const isP = await db.isChampionshipParticipant(champ.id, req.tgUser.id);
    if (!isP) return res.status(403).json({ error: 'Ты не участник чемпионата' });

    const dayNumber = db.getChampionshipDayNumber();
    const champRound = await db.getChampionshipRound(champ.id, dayNumber);
    if (!champRound) return res.status(404).json({ error: 'Раунд на сегодня ещё не создан' });
    if (champRound.is_resolved) return res.status(400).json({ error: 'Раунд уже завершён' });

    const result = await db.answerChampionshipQuestion(champ.id, champRound.id, req.tgUser.id, questionIndex, answer);
    res.json(result);
  } catch (e) {
    console.error('[Championship/answer]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/championship/history', authMiddleware, async (req, res) => {
  try {
    const history = await db.getChampionshipHistory(10);
    const result = [];
    for (const c of history) {
      const entries = await db.getChampionshipEntries(c.id);
      result.push({
        ...c,
        participants: entries.length,
        top3: entries.slice(0, 3).map(e => ({ username: e.username, first_name: e.first_name, total_score: e.total_score })),
      });
    }
    res.json({ ok: true, history: result });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Raffle ---

app.get('/api/raffle', async (req, res) => {
  try {
    const weekKey = db.getWeekKey();
    const tickets = await db.getRaffleTickets(weekKey);
    const raffle = await db.getRaffle(weekKey);

    const userTickets = {};
    for (const t of tickets) {
      userTickets[t.user_id] = (userTickets[t.user_id] || 0) + 1;
    }

    res.json({
      ok: true, weekKey,
      totalTickets: tickets.length,
      uniqueParticipants: Object.keys(userTickets).length,
      raffle,
      prizeStars: raffle?.prize_stars || 500
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Admin ---

app.post('/api/admin/raffle/draw', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });

    const weekKey = req.body.weekKey || db.getWeekKey();
    const result = await db.drawRaffle(weekKey);

    if (result.ok && bot) {
      const winner = await db.getUser(result.winner_id);
      if (winner?.chat_id) {
        await bot.sendMessage(winner.chat_id,
          `🎉 Поздравляем! Ты выиграл(а) ${result.prize_stars}⭐ в розыгрыше недели ${weekKey}!\n` +
          `Из ${result.total_tickets} билетов — твой оказался счастливым!`
        );
      }
    }

    res.json(result);
  } catch (e) {
    console.error('[Admin/raffle]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reset-user', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    const { telegram_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
    const result = await db.resetUser(telegram_id);
    res.json(result);
  } catch (e) {
    console.error('[Admin/reset]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-all', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    const users = await db.getAllUsers();
    let count = 0;
    for (const u of users) {
      await db.resetUser(u.telegram_id);
      count++;
    }
    res.json({ ok: true, message: `Reset ${count} users` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Start ---

process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e));
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Running on :${PORT}`);
  console.log('[Server] Node', process.version);
  console.log('[Server] DATABASE_URL:', process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@') : 'MISSING');
  console.log('[Server] DATABASE_SSL:', process.env.DATABASE_SSL || 'not set');
});

(async () => {
  try {
    await db.initDB();
    await db.warmPriceCache();
    console.log('[Server] DB ready');
  } catch (e) {
    console.error('[Server] initDB failed:', e.message);
  }

  try {
    bot = initBot();
    if (bot) {
      const me = await bot.getMe();
      botUsername = me.username;
      console.log(`[Bot] @${botUsername}`);
    }
  } catch (e) {
    console.error('[Bot] Init failed:', e.message);
  }

  try {
    const scheduler = require('./scheduler');
    scheduler.setBot(bot);
    scheduler.start();
  } catch (e) {
    console.error('[Scheduler] Init failed:', e.message);
  }
})();

module.exports = { app, getBot: () => bot };
