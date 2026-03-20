require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  next();
}

// --- Auth ---

app.post('/api/auth', async (req, res) => {
  try {
    const { initData, ref } = req.body;
    const tgUser = validateTelegramData(initData);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

    let user = await db.getUser(tgUser.id);
    const isNew = !user;
    if (!user) {
      user = await db.createUser(tgUser, ref || null);
    }

    if (req.body.chatId) {
      user.chat_id = req.body.chatId;
      await db.saveUser(user);
    }

    res.json({
      ok: true, user, isNew, botUsername,
      premium: db.isPremiumActive(user),
      weekKey: db.getWeekKey()
    });
  } catch (e) {
    console.error('[Auth]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Rounds ---

app.get('/api/round/check', authMiddleware, async (req, res) => {
  try {
    const userId = req.tgUser.id;
    const active = await db.getActiveRound(userId);
    if (active && !active.is_resolved) {
      const questions = await db.getRoundQuestions(active.id);
      return res.json({
        ok: true, status: active.is_complete ? 'waiting' : 'in_progress',
        round: active, questions
      });
    }
    const canStart = await db.canStartRound(userId);
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

app.post('/api/duel/join', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const duel = await db.getDuelByCode(code);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });

    const result = await db.joinDuel(duel.id, req.tgUser.id);
    if (!result.ok) return res.status(400).json(result);

    const questions = await db.getDuelQuestions(duel.id);
    res.json({ ok: true, duel_id: duel.id, questions, resolve_after: duel.resolve_after });
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
    const duels = await db.getUserDuels(req.tgUser.id, 20);
    res.json({ ok: true, duels });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Premium ---

app.post('/api/premium/buy', authMiddleware, async (req, res) => {
  try {
    res.json({
      ok: true,
      invoiceUrl: null,
      message: 'Use Telegram Stars payment. Send invoice via bot.'
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
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
      raffle
    });
  } catch (e) {
    console.error('[Profile]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Leaderboard ---

app.get('/api/leaderboard', async (req, res) => {
  try {
    const board = await db.getLeaderboard();
    res.json({ ok: true, board });
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

// --- Start ---

async function start() {
  await db.initDB();

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

  const scheduler = require('./scheduler');
  scheduler.setBot(bot);
  scheduler.start();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`[Server] Running on :${PORT}`));
}

start().catch(console.error);

module.exports = { app, getBot: () => bot };
