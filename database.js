const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') || process.env.DATABASE_URL?.includes('neon.tech')
    ? { rejectUnauthorized: false } : false
});

// --- Schema ---

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      is_premium BOOLEAN DEFAULT false,
      premium_until TIMESTAMPTZ,
      streak_5of5 INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      total_rounds INTEGER DEFAULT 0,
      total_5of5 INTEGER DEFAULT 0,
      duel_wins INTEGER DEFAULT 0,
      duel_losses INTEGER DEFAULT 0,
      duel_draws INTEGER DEFAULT 0,
      notifications BOOLEAN DEFAULT true,
      chat_id BIGINT,
      referred_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      resolve_after TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      correct_count INTEGER DEFAULT 0,
      total_answered INTEGER DEFAULT 0,
      is_complete BOOLEAN DEFAULT false,
      is_resolved BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS round_questions (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL,
      question_index INTEGER NOT NULL,
      asset TEXT NOT NULL,
      asset_label TEXT NOT NULL,
      asset_emoji TEXT DEFAULT '',
      price_at_start DOUBLE PRECISION NOT NULL,
      price_at_resolve DOUBLE PRECISION,
      user_answer TEXT,
      correct_answer TEXT,
      is_correct BOOLEAN,
      answered_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS duels (
      id SERIAL PRIMARY KEY,
      invite_code TEXT UNIQUE NOT NULL,
      creator_id BIGINT NOT NULL,
      opponent_id BIGINT,
      creator_correct INTEGER DEFAULT 0,
      opponent_correct INTEGER DEFAULT 0,
      winner_id BIGINT,
      is_draw BOOLEAN DEFAULT false,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      resolve_after TIMESTAMPTZ,
      both_answered BOOLEAN DEFAULT false,
      is_resolved BOOLEAN DEFAULT false,
      resolved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS duel_questions (
      id SERIAL PRIMARY KEY,
      duel_id INTEGER NOT NULL,
      question_index INTEGER NOT NULL,
      asset TEXT NOT NULL,
      asset_label TEXT NOT NULL,
      asset_emoji TEXT DEFAULT '',
      price_at_start DOUBLE PRECISION NOT NULL,
      price_at_resolve DOUBLE PRECISION,
      correct_answer TEXT,
      creator_answer TEXT,
      opponent_answer TEXT,
      creator_correct BOOLEAN,
      opponent_correct BOOLEAN
    );

    CREATE TABLE IF NOT EXISTS raffle_tickets (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      week_key TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS raffles (
      id SERIAL PRIMARY KEY,
      week_key TEXT UNIQUE NOT NULL,
      prize_stars INTEGER DEFAULT 500,
      winner_id BIGINT,
      total_tickets INTEGER DEFAULT 0,
      drawn_at TIMESTAMPTZ,
      paid BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS premium_grants (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      week_key TEXT NOT NULL,
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, week_key)
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      type TEXT NOT NULL,
      unlocked_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, type)
    );
  `);
  console.log('[DB] Schema ready');
}

// --- Assets ---

const ASSETS = [
  { id: 'bitcoin', symbol: 'BTC', label: 'Bitcoin', emoji: '₿' },
  { id: 'ethereum', symbol: 'ETH', label: 'Ethereum', emoji: 'Ξ' },
  { id: 'the-open-network', symbol: 'TON', label: 'Toncoin', emoji: '💎' },
  { id: 'dogecoin', symbol: 'DOGE', label: 'Dogecoin', emoji: '🐕' },
  { id: 'solana', symbol: 'SOL', label: 'Solana', emoji: '◎' },
];

const DRAW_THRESHOLD = 0.0005; // ±0.05%

function pickRandomAssets(count = 5) {
  const shuffled = [...ASSETS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function getWeekKey() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// --- Price fetching (3 sources) ---

async function fetchJSON(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fetchPricesCoinGecko(ids) {
  const idStr = ids.join(',');
  const data = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${idStr}&vs_currencies=usd`);
  const prices = {};
  for (const id of ids) {
    if (data[id]?.usd) prices[id] = data[id].usd;
  }
  return prices;
}

async function fetchPricesBinance(symbols) {
  const prices = {};
  for (const sym of symbols) {
    const map = { bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT', dogecoin: 'DOGEUSDT', 'the-open-network': 'TONUSDT' };
    const pair = map[sym];
    if (!pair) continue;
    try {
      const data = await fetchJSON(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
      if (data?.price) prices[sym] = parseFloat(data.price);
    } catch (e) { /* skip */ }
  }
  return prices;
}

async function fetchPricesCryptoCompare(symbols) {
  const prices = {};
  const map = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', dogecoin: 'DOGE', 'the-open-network': 'TON' };
  const fsyms = symbols.map(s => map[s]).filter(Boolean).join(',');
  if (!fsyms) return prices;
  try {
    const data = await fetchJSON(`https://min-api.cryptocompare.com/data/pricemulti?fsyms=${fsyms}&tsyms=USD`);
    for (const [sym, id] of Object.entries(map)) {
      if (symbols.includes(sym) && data[id]?.USD) prices[sym] = data[id].USD;
    }
  } catch (e) { /* skip */ }
  return prices;
}

async function fetchCurrentPrices(assetIds) {
  let prices = {};
  try { prices = await fetchPricesCoinGecko(assetIds); } catch (e) { console.error('[Price] CoinGecko failed:', e.message); }

  const missing = assetIds.filter(id => !prices[id]);
  if (missing.length > 0) {
    try {
      const backup = await fetchPricesBinance(missing);
      Object.assign(prices, backup);
    } catch (e) { console.error('[Price] Binance failed:', e.message); }
  }

  const stillMissing = assetIds.filter(id => !prices[id]);
  if (stillMissing.length > 0) {
    try {
      const backup2 = await fetchPricesCryptoCompare(stillMissing);
      Object.assign(prices, backup2);
    } catch (e) { console.error('[Price] CryptoCompare failed:', e.message); }
  }

  return prices;
}

async function fetchSparkline(assetId) {
  try {
    const data = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${assetId}/market_chart?vs_currency=usd&days=1`);
    if (data?.prices) return data.prices.map(p => p[1]);
  } catch (e) { /* skip */ }
  return null;
}

// --- Users ---

async function getUser(telegramId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return rows[0] || null;
}

async function createUser(tgUser, referredBy) {
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, referred_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [tgUser.id, tgUser.username || '', tgUser.first_name || '', referredBy || null]
  );
  return getUser(tgUser.id);
}

async function saveUser(u) {
  await pool.query(`
    UPDATE users SET username=$1, first_name=$2, is_premium=$3, premium_until=$4,
      streak_5of5=$5, best_streak=$6, total_rounds=$7, total_5of5=$8,
      duel_wins=$9, duel_losses=$10, duel_draws=$11, notifications=$12, chat_id=$13
    WHERE telegram_id=$14
  `, [u.username, u.first_name, u.is_premium, u.premium_until,
      u.streak_5of5, u.best_streak, u.total_rounds, u.total_5of5,
      u.duel_wins, u.duel_losses, u.duel_draws, u.notifications, u.chat_id, u.telegram_id]);
}

function isPremiumActive(user) {
  if (!user) return false;
  if (!user.is_premium) return false;
  if (!user.premium_until) return false;
  return new Date(user.premium_until) > new Date();
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT * FROM users');
  return rows;
}

// --- Rounds ---

async function canStartRound(userId) {
  const user = await getUser(userId);
  if (!user) return { ok: false, error: 'User not found' };

  const premium = isPremiumActive(user);
  const cooldownMs = premium ? 3600000 : 7200000; // 1h or 2h

  const { rows } = await pool.query(
    'SELECT started_at FROM rounds WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1', [userId]
  );
  if (rows.length > 0) {
    const elapsed = Date.now() - new Date(rows[0].started_at).getTime();
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
      return { ok: false, error: 'cooldown', remaining, premium };
    }
  }
  return { ok: true, premium };
}

async function createRound(userId) {
  const assets = pickRandomAssets(5);
  const assetIds = assets.map(a => a.id);
  const prices = await fetchCurrentPrices(assetIds);

  for (const a of assets) {
    if (!prices[a.id]) return { ok: false, error: `Could not fetch price for ${a.symbol}` };
  }

  const resolveAfter = new Date(Date.now() + 3600000); // +1 hour

  const { rows } = await pool.query(
    'INSERT INTO rounds (user_id, resolve_after) VALUES ($1, $2) RETURNING id, started_at',
    [userId, resolveAfter]
  );
  const roundId = rows[0].id;

  for (let i = 0; i < assets.length; i++) {
    await pool.query(
      `INSERT INTO round_questions (round_id, question_index, asset, asset_label, asset_emoji, price_at_start)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [roundId, i, assets[i].id, assets[i].label, assets[i].emoji, prices[assets[i].id]]
    );
  }

  return {
    ok: true,
    round_id: roundId,
    started_at: rows[0].started_at,
    resolve_after: resolveAfter,
    questions: assets.map((a, i) => ({
      index: i, asset: a.id, label: a.label, emoji: a.emoji,
      symbol: a.symbol, price: prices[a.id]
    }))
  };
}

async function getRound(roundId) {
  const { rows } = await pool.query('SELECT * FROM rounds WHERE id=$1', [roundId]);
  return rows[0] || null;
}

async function getRoundQuestions(roundId) {
  const { rows } = await pool.query('SELECT * FROM round_questions WHERE round_id=$1 ORDER BY question_index', [roundId]);
  return rows;
}

async function getActiveRound(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM rounds WHERE user_id=$1 AND is_resolved=false ORDER BY started_at DESC LIMIT 1`, [userId]
  );
  return rows[0] || null;
}

async function answerRoundQuestion(roundId, questionIndex, answer) {
  if (!['up', 'down'].includes(answer)) return { ok: false, error: 'Invalid answer' };

  const { rows } = await pool.query(
    `UPDATE round_questions SET user_answer=$1, answered_at=NOW()
     WHERE round_id=$2 AND question_index=$3 AND user_answer IS NULL RETURNING *`,
    [answer, roundId, questionIndex]
  );
  if (rows.length === 0) return { ok: false, error: 'Already answered or not found' };

  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) as c FROM round_questions WHERE round_id=$1 AND user_answer IS NOT NULL', [roundId]
  );
  const answered = parseInt(countRows[0].c);

  await pool.query('UPDATE rounds SET total_answered=$1 WHERE id=$2', [answered, roundId]);

  if (answered >= 5) {
    await pool.query('UPDATE rounds SET is_complete=true WHERE id=$1', [roundId]);
  }

  return { ok: true, answered, is_complete: answered >= 5 };
}

async function resolveRound(roundId) {
  const round = await getRound(roundId);
  if (!round || round.is_resolved) return null;
  if (!round.is_complete) return null;

  const questions = await getRoundQuestions(roundId);
  const assetIds = questions.map(q => q.asset);
  const prices = await fetchCurrentPrices(assetIds);

  let correctCount = 0;

  for (const q of questions) {
    const currentPrice = prices[q.asset];
    if (!currentPrice) continue;

    const change = (currentPrice - q.price_at_start) / q.price_at_start;
    let correctAnswer;
    if (Math.abs(change) <= DRAW_THRESHOLD) {
      correctAnswer = 'draw';
    } else {
      correctAnswer = change > 0 ? 'up' : 'down';
    }

    const isCorrect = correctAnswer === 'draw' || q.user_answer === correctAnswer;
    if (isCorrect) correctCount++;

    await pool.query(
      `UPDATE round_questions SET price_at_resolve=$1, correct_answer=$2, is_correct=$3 WHERE id=$4`,
      [currentPrice, correctAnswer, isCorrect, q.id]
    );
  }

  await pool.query(
    `UPDATE rounds SET is_resolved=true, resolved_at=NOW(), correct_count=$1 WHERE id=$2`,
    [correctCount, roundId]
  );

  const user = await getUser(round.user_id);
  if (user) {
    user.total_rounds = (user.total_rounds || 0) + 1;

    if (correctCount === 5) {
      user.streak_5of5 = (user.streak_5of5 || 0) + 1;
      user.total_5of5 = (user.total_5of5 || 0) + 1;
      if (user.streak_5of5 > (user.best_streak || 0)) user.best_streak = user.streak_5of5;

      const weekKey = getWeekKey();
      await addRaffleTicket(user.telegram_id, weekKey, 'solo_5of5');

      const { rows: grantCheck } = await pool.query(
        'SELECT id FROM premium_grants WHERE user_id=$1 AND week_key=$2', [user.telegram_id, weekKey]
      );
      let premiumGranted = false;
      if (grantCheck.length === 0) {
        user.is_premium = true;
        user.premium_until = new Date(Date.now() + 3 * 24 * 3600000); // +3 days
        await pool.query(
          'INSERT INTO premium_grants (user_id, week_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [user.telegram_id, weekKey]
        );
        premiumGranted = true;
      }
      await saveUser(user);
      return { roundId, correctCount, is5of5: true, premiumGranted, streak: user.streak_5of5, user };
    } else {
      user.streak_5of5 = 0;
      await saveUser(user);
    }
  }

  return { roundId, correctCount, is5of5: false, premiumGranted: false, streak: 0, user };
}

async function getPendingRounds() {
  const { rows } = await pool.query(
    `SELECT * FROM rounds WHERE is_complete=true AND is_resolved=false AND resolve_after <= NOW()`
  );
  return rows;
}

async function getRecentRounds(userId, limit = 10) {
  const { rows } = await pool.query(
    'SELECT * FROM rounds WHERE user_id=$1 ORDER BY started_at DESC LIMIT $2', [userId, limit]
  );
  return rows;
}

// --- Duels ---

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function canCreateDuel(userId) {
  const user = await getUser(userId);
  if (!user) return { ok: false, error: 'User not found' };
  const premium = isPremiumActive(user);

  if (!premium) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT COUNT(*) as c FROM duels WHERE creator_id=$1 AND started_at::date=$2::date`, [userId, today]
    );
    if (parseInt(rows[0].c) >= 1) return { ok: false, error: 'Free users: 1 duel/day. Get Premium for unlimited!' };
  }
  return { ok: true };
}

async function createDuel(creatorId) {
  const assets = pickRandomAssets(5);
  const assetIds = assets.map(a => a.id);
  const prices = await fetchCurrentPrices(assetIds);

  for (const a of assets) {
    if (!prices[a.id]) return { ok: false, error: `Could not fetch price for ${a.symbol}` };
  }

  const code = generateInviteCode();
  const resolveAfter = new Date(Date.now() + 3600000);

  const { rows } = await pool.query(
    'INSERT INTO duels (invite_code, creator_id, resolve_after) VALUES ($1,$2,$3) RETURNING id',
    [code, creatorId, resolveAfter]
  );
  const duelId = rows[0].id;

  for (let i = 0; i < assets.length; i++) {
    await pool.query(
      `INSERT INTO duel_questions (duel_id, question_index, asset, asset_label, asset_emoji, price_at_start)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [duelId, i, assets[i].id, assets[i].label, assets[i].emoji, prices[assets[i].id]]
    );
  }

  return { ok: true, duel_id: duelId, invite_code: code, resolve_after: resolveAfter,
    questions: assets.map((a, i) => ({ index: i, asset: a.id, label: a.label, emoji: a.emoji, symbol: a.symbol, price: prices[a.id] }))
  };
}

async function getDuel(duelId) {
  const { rows } = await pool.query('SELECT * FROM duels WHERE id=$1', [duelId]);
  return rows[0] || null;
}

async function getDuelByCode(code) {
  const { rows } = await pool.query('SELECT * FROM duels WHERE invite_code=$1', [code]);
  return rows[0] || null;
}

async function getDuelQuestions(duelId) {
  const { rows } = await pool.query('SELECT * FROM duel_questions WHERE duel_id=$1 ORDER BY question_index', [duelId]);
  return rows;
}

async function joinDuel(duelId, userId) {
  const duel = await getDuel(duelId);
  if (!duel) return { ok: false, error: 'Duel not found' };
  if (duel.creator_id === BigInt(userId) || duel.creator_id == userId) return { ok: false, error: 'Cannot duel yourself' };
  if (duel.opponent_id) return { ok: false, error: 'Duel already has an opponent' };

  await pool.query('UPDATE duels SET opponent_id=$1 WHERE id=$2', [userId, duelId]);
  return { ok: true };
}

async function answerDuelQuestion(duelId, userId, questionIndex, answer) {
  if (!['up', 'down'].includes(answer)) return { ok: false, error: 'Invalid answer' };

  const duel = await getDuel(duelId);
  if (!duel) return { ok: false, error: 'Duel not found' };

  const isCreator = duel.creator_id == userId;
  const isOpponent = duel.opponent_id == userId;
  if (!isCreator && !isOpponent) return { ok: false, error: 'Not a participant' };

  const col = isCreator ? 'creator_answer' : 'opponent_answer';

  const { rows } = await pool.query(
    `UPDATE duel_questions SET ${col}=$1
     WHERE duel_id=$2 AND question_index=$3 AND ${col} IS NULL RETURNING *`,
    [answer, duelId, questionIndex]
  );
  if (rows.length === 0) return { ok: false, error: 'Already answered' };

  const { rows: allQ } = await pool.query('SELECT * FROM duel_questions WHERE duel_id=$1', [duelId]);
  const creatorDone = allQ.every(q => q.creator_answer !== null);
  const opponentDone = duel.opponent_id && allQ.every(q => q.opponent_answer !== null);

  if (creatorDone && opponentDone) {
    await pool.query('UPDATE duels SET both_answered=true WHERE id=$1', [duelId]);
  }

  return { ok: true, your_answered: isCreator ? creatorDone : opponentDone };
}

async function resolveDuel(duelId) {
  const duel = await getDuel(duelId);
  if (!duel || duel.is_resolved || !duel.both_answered) return null;

  const questions = await getDuelQuestions(duelId);
  const assetIds = [...new Set(questions.map(q => q.asset))];
  const prices = await fetchCurrentPrices(assetIds);

  let creatorCorrect = 0, opponentCorrect = 0;

  for (const q of questions) {
    const currentPrice = prices[q.asset];
    if (!currentPrice) continue;

    const change = (currentPrice - q.price_at_start) / q.price_at_start;
    let correctAnswer;
    if (Math.abs(change) <= DRAW_THRESHOLD) correctAnswer = 'draw';
    else correctAnswer = change > 0 ? 'up' : 'down';

    const cCorrect = correctAnswer === 'draw' || q.creator_answer === correctAnswer;
    const oCorrect = correctAnswer === 'draw' || q.opponent_answer === correctAnswer;
    if (cCorrect) creatorCorrect++;
    if (oCorrect) opponentCorrect++;

    await pool.query(
      `UPDATE duel_questions SET price_at_resolve=$1, correct_answer=$2, creator_correct=$3, opponent_correct=$4 WHERE id=$5`,
      [currentPrice, correctAnswer, cCorrect, oCorrect, q.id]
    );
  }

  let winnerId = null, isDraw = false;
  if (creatorCorrect > opponentCorrect) winnerId = duel.creator_id;
  else if (opponentCorrect > creatorCorrect) winnerId = duel.opponent_id;
  else isDraw = true;

  await pool.query(
    `UPDATE duels SET is_resolved=true, resolved_at=NOW(), creator_correct=$1, opponent_correct=$2, winner_id=$3, is_draw=$4 WHERE id=$5`,
    [creatorCorrect, opponentCorrect, winnerId, isDraw, duelId]
  );

  const weekKey = getWeekKey();
  if (winnerId) {
    const winner = await getUser(winnerId);
    const loserId = winnerId == duel.creator_id ? duel.opponent_id : duel.creator_id;
    const loser = await getUser(loserId);

    if (winner) { winner.duel_wins = (winner.duel_wins || 0) + 1; await saveUser(winner); }
    if (loser) { loser.duel_losses = (loser.duel_losses || 0) + 1; await saveUser(loser); }

    const { rows: winCount } = await pool.query(
      `SELECT COUNT(*) as c FROM duels WHERE winner_id=$1 AND resolved_at > NOW() - INTERVAL '7 days'`, [winnerId]
    );
    if (parseInt(winCount[0].c) % 2 === 0) {
      await addRaffleTicket(winnerId, weekKey, 'duel_wins');
    }
  } else {
    const creator = await getUser(duel.creator_id);
    const opponent = await getUser(duel.opponent_id);
    if (creator) { creator.duel_draws = (creator.duel_draws || 0) + 1; await saveUser(creator); }
    if (opponent) { opponent.duel_draws = (opponent.duel_draws || 0) + 1; await saveUser(opponent); }
  }

  return { duelId, creatorCorrect, opponentCorrect, winnerId, isDraw };
}

async function getPendingDuels() {
  const { rows } = await pool.query(
    `SELECT * FROM duels WHERE both_answered=true AND is_resolved=false AND resolve_after <= NOW()`
  );
  return rows;
}

async function getUserDuels(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM duels WHERE (creator_id=$1 OR opponent_id=$1) ORDER BY started_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// --- Raffle ---

async function addRaffleTicket(userId, weekKey, source) {
  await pool.query(
    'INSERT INTO raffle_tickets (user_id, week_key, source) VALUES ($1,$2,$3)',
    [userId, weekKey, source]
  );
}

async function getRaffleTickets(weekKey) {
  const { rows } = await pool.query('SELECT * FROM raffle_tickets WHERE week_key=$1', [weekKey]);
  return rows;
}

async function getUserTickets(userId, weekKey) {
  const { rows } = await pool.query(
    'SELECT * FROM raffle_tickets WHERE user_id=$1 AND week_key=$2', [userId, weekKey]
  );
  return rows;
}

async function getRaffle(weekKey) {
  const { rows } = await pool.query('SELECT * FROM raffles WHERE week_key=$1', [weekKey]);
  return rows[0] || null;
}

async function drawRaffle(weekKey, prizeStars = 500) {
  const tickets = await getRaffleTickets(weekKey);
  if (tickets.length === 0) return { ok: false, error: 'No tickets' };

  const winnerTicket = tickets[Math.floor(Math.random() * tickets.length)];

  await pool.query(
    `INSERT INTO raffles (week_key, prize_stars, winner_id, total_tickets, drawn_at)
     VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (week_key) DO UPDATE
     SET winner_id=$3, total_tickets=$4, drawn_at=NOW()`,
    [weekKey, prizeStars, winnerTicket.user_id, tickets.length]
  );

  return { ok: true, winner_id: winnerTicket.user_id, total_tickets: tickets.length, prize_stars: prizeStars };
}

// --- Achievements ---

const ACHIEVEMENT_DEFS = [
  { type: 'first_round', emoji: '🎯', title: 'Первый раунд', desc: 'Сыграй первый раз' },
  { type: 'sniper', emoji: '🎯', title: 'Снайпер', desc: 'Первый 5/5' },
  { type: 'serial_sniper', emoji: '🔥', title: 'Серийный снайпер', desc: 'Серия 3× 5/5 подряд' },
  { type: 'machine', emoji: '🤖', title: 'Машина', desc: 'Серия 5× 5/5 подряд' },
  { type: 'duelist', emoji: '⚔️', title: 'Дуэлянт', desc: 'Первая победа в дуэли' },
  { type: 'dominator', emoji: '👑', title: 'Доминатор', desc: '10 побед в дуэлях' },
  { type: 'top_weekly', emoji: '🏆', title: 'В топе', desc: 'Выиграй розыгрыш недели' },
  { type: 'night_owl', emoji: '🦉', title: 'Ночная сова', desc: 'Сыграй между 00:00–05:00' },
  { type: 'veteran', emoji: '⚡', title: 'Ветеран', desc: '50 раундов сыграно' },
  { type: 'legend', emoji: '🌟', title: 'Легенда', desc: '100 раундов сыграно' },
  { type: 'first_stars', emoji: '⭐', title: 'Звёзды', desc: 'Получи приз в Stars' },
  { type: 'streak_king', emoji: '💎', title: 'Король серий', desc: 'Серия 10× 5/5 подряд' },
];

async function getAchievements(userId) {
  const { rows } = await pool.query('SELECT type, unlocked_at FROM achievements WHERE user_id=$1 ORDER BY unlocked_at DESC', [userId]);
  return rows.map(r => {
    const def = ACHIEVEMENT_DEFS.find(d => d.type === r.type) || {};
    return { ...r, ...def };
  });
}

async function grantAchievement(userId, type) {
  try {
    const { rows } = await pool.query(
      'INSERT INTO achievements (user_id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *', [userId, type]
    );
    return rows[0] || null;
  } catch (e) { return null; }
}

async function checkAchievements(userId) {
  const user = await getUser(userId);
  if (!user) return [];
  const granted = [];

  if (user.total_rounds >= 1) { const r = await grantAchievement(userId, 'first_round'); if (r) granted.push(r); }
  if (user.total_5of5 >= 1) { const r = await grantAchievement(userId, 'sniper'); if (r) granted.push(r); }
  if (user.streak_5of5 >= 3) { const r = await grantAchievement(userId, 'serial_sniper'); if (r) granted.push(r); }
  if (user.streak_5of5 >= 5) { const r = await grantAchievement(userId, 'machine'); if (r) granted.push(r); }
  if (user.streak_5of5 >= 10) { const r = await grantAchievement(userId, 'streak_king'); if (r) granted.push(r); }
  if (user.duel_wins >= 1) { const r = await grantAchievement(userId, 'duelist'); if (r) granted.push(r); }
  if (user.duel_wins >= 10) { const r = await grantAchievement(userId, 'dominator'); if (r) granted.push(r); }
  if (user.total_rounds >= 50) { const r = await grantAchievement(userId, 'veteran'); if (r) granted.push(r); }
  if (user.total_rounds >= 100) { const r = await grantAchievement(userId, 'legend'); if (r) granted.push(r); }

  const hourMSK = (new Date().getUTCHours() + 3) % 24;
  if (hourMSK >= 0 && hourMSK < 5) { const r = await grantAchievement(userId, 'night_owl'); if (r) granted.push(r); }

  return granted;
}

// --- Leaderboard ---

async function getLeaderboard() {
  const { rows } = await pool.query(
    'SELECT telegram_id, username, first_name, total_5of5, best_streak, duel_wins, total_rounds FROM users ORDER BY total_5of5 DESC, best_streak DESC LIMIT 50'
  );
  return rows;
}

module.exports = {
  pool, initDB, ASSETS, DRAW_THRESHOLD, ACHIEVEMENT_DEFS,
  fetchCurrentPrices, fetchSparkline, getWeekKey,
  getUser, createUser, saveUser, isPremiumActive, getAllUsers,
  canStartRound, createRound, getRound, getRoundQuestions, getActiveRound,
  answerRoundQuestion, resolveRound, getPendingRounds, getRecentRounds,
  generateInviteCode, canCreateDuel, createDuel, getDuel, getDuelByCode,
  getDuelQuestions, joinDuel, answerDuelQuestion, resolveDuel, getPendingDuels, getUserDuels,
  addRaffleTicket, getRaffleTickets, getUserTickets, getRaffle, drawRaffle,
  getAchievements, grantAchievement, checkAchievements, getLeaderboard,
};
