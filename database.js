const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') || process.env.DATABASE_URL?.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : false
});

// --- Init schema ---

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      score INTEGER DEFAULT 0,
      correct INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      daily_streak INTEGER DEFAULT 0,
      best_daily_streak INTEGER DEFAULT 0,
      last_active_date TEXT,
      streak_freezes INTEGER DEFAULT 1,
      is_premium BOOLEAN DEFAULT false,
      referred_by BIGINT,
      notifications BOOLEAN DEFAULT true,
      chat_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT,
      category TEXT DEFAULT 'general',
      timeframe TEXT DEFAULT 'tomorrow',
      is_active BOOLEAN DEFAULT true,
      correct_answer TEXT,
      resolved BOOLEAN DEFAULT false,
      auto_check JSONB
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      question_id INTEGER NOT NULL,
      answer TEXT NOT NULL,
      is_correct BOOLEAN,
      points_earned INTEGER DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '🎯',
      owner_id BIGINT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL,
      user_id BIGINT NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS room_questions (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      author_id BIGINT NOT NULL,
      correct_answer TEXT,
      resolved BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS room_predictions (
      id SERIAL PRIMARY KEY,
      room_question_id INTEGER NOT NULL,
      user_id BIGINT NOT NULL,
      answer TEXT NOT NULL,
      is_correct BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room_question_id, user_id)
    );
  `);

  // Migrations
  try {
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_c TEXT');
    await pool.query('ALTER TABLE room_questions ADD COLUMN IF NOT EXISTS option_c TEXT');
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()');
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false');
  } catch (e) { /* columns already exist */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      type TEXT NOT NULL,
      unlocked_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, type)
    )
  `);

  const { rows } = await pool.query('SELECT COUNT(*) as c FROM questions');
  if (parseInt(rows[0].c) === 0) {
    const seed = [
      ['⚽ Кто победит в ближайшем топ-матче Лиги Чемпионов?', 'Фаворит', 'Андердог', 'Ничья в основное время', 'sport', 'tomorrow'],
      ['🏀 NBA: фаворит победит в матче дня?', 'Да, уверенно', 'Нет, апсет!', 'Победа с разницей 1–3 очка', 'sport', 'tomorrow'],
      ['🎬 Какой жанр будет #1 в кинопрокате в эти выходные?', 'Боевик / фантастика', 'Комедия / драма', 'Анимация / мультфильм', 'movies', 'tomorrow'],
      ['🤖 Выйдет ли завтра громкая новость про ИИ?', 'Да, будет бомба', 'Нет, тихий день', 'Новость будет, но не громкая', 'tech', 'tomorrow'],
      ['🎵 Какой жанр сейчас #1 в мировом Spotify?', 'Поп', 'Хип-хоп / рэп', 'Латино / другой', 'music', 'tomorrow'],
      ['📊 S&P 500 завтра закроется в плюсе?', 'Да, зелёный день', 'Нет, красный', 'Почти без изменений (±0.2%)', 'finance', 'week'],
      ['💎 Кто покажет лучший рост за неделю: Bitcoin или Ethereum?', 'Bitcoin', 'Ethereum', 'Примерно одинаково (±1%)', 'crypto', 'week'],
      ['🏎 Формула 1: кто возьмёт поул на ближайшем Гран-при?', 'Red Bull', 'Ferrari / McLaren', 'Другая команда — сенсация', 'sport', 'week'],
      ['📺 Новый эпизод топ-сериала получит на IMDb:', 'Выше 8.5 — шедевр', 'Ниже 7.0 — разочарование', '7.0–8.5 — нормально', 'movies', 'week'],
      ['🔥 Илон Маск напишет пост с 1M+ лайков на этой неделе?', 'Конечно да', 'Нет, не в этот раз', 'Напишет, но не наберёт 1M', 'tech', 'week'],
      ['⚽ Сборная России выиграет ближайший матч?', 'Да, победа', 'Нет, проиграют', 'Ничья', 'sport', 'month'],
      ['🚀 SpaceX совершит успешный запуск в этом месяце?', 'Да, и не один', 'Нет / перенесут', 'Один запуск, но с проблемами', 'tech', 'month'],
      ['💰 Золото обновит исторический максимум в этом месяце?', 'Да, новый рекорд', 'Нет, не дотянет', 'Подойдёт близко (±1%)', 'finance', 'month'],
      ['🎮 Выйдет ли игра с оценкой 90+ на Metacritic в этом месяце?', 'Да, будет хит', 'Нет, всё средне', 'Выйдет 85–89 — почти хит', 'tech', 'month'],
      ['🌍 Главная тема мировых новостей в этом месяце будет:', 'Политика / конфликты', 'Экономика / рынки', 'Технологии / наука / другое', 'general', 'month'],
    ];
    for (const [text, a, b, c, cat, tf] of seed) {
      await pool.query(
        'INSERT INTO questions (text, option_a, option_b, option_c, category, timeframe) VALUES ($1,$2,$3,$4,$5,$6)',
        [text, a, b, c, cat, tf]
      );
    }
    console.log('[DB] Seeded 15 default questions');
  }
}

// --- Helpers ---

function getToday() { return new Date().toISOString().slice(0, 10); }

function getYesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getStreakReward(streak) {
  const rewards = { 3: 30, 7: 100, 14: 250, 30: 500, 60: 1000, 100: 2000 };
  return rewards[streak] || 0;
}

function getStreakMilestones() {
  return [
    { days: 3, reward: 30, label: '3 дня' }, { days: 7, reward: 100, label: 'Неделя' },
    { days: 14, reward: 250, label: '2 недели' }, { days: 30, reward: 500, label: 'Месяц' },
    { days: 60, reward: 1000, label: '2 месяца' }, { days: 100, reward: 2000, label: '100 дней' },
  ];
}

// --- Users ---

async function getUser(telegramId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return rows[0] || null;
}

async function saveUser(u) {
  await pool.query(`
    UPDATE users SET username=$1, first_name=$2, score=$3, correct=$4, total=$5, streak=$6,
      best_streak=$7, daily_streak=$8, best_daily_streak=$9, last_active_date=$10,
      streak_freezes=$11, is_premium=$12, notifications=$13, chat_id=$14
    WHERE telegram_id=$15
  `, [u.username, u.first_name, u.score, u.correct, u.total, u.streak,
      u.best_streak, u.daily_streak, u.best_daily_streak, u.last_active_date,
      u.streak_freezes, u.is_premium, u.notifications, u.chat_id, u.telegram_id]);
}

async function createUser(tgUser, referredBy) {
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, referred_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [tgUser.id, tgUser.username || '', tgUser.first_name || '', referredBy || null]
  );
  if (referredBy) {
    await pool.query('UPDATE users SET score = score + 50 WHERE telegram_id = $1', [referredBy]);
  }
  return getUser(tgUser.id);
}

// --- Check-in ---

async function checkIn(telegramId) {
  const user = await getUser(telegramId);
  if (!user) return null;

  const today = getToday();
  const yesterday = getYesterday();

  if (user.last_active_date === today) {
    return { action: 'already', daily_streak: user.daily_streak };
  }

  user.daily_streak = user.last_active_date === yesterday ? user.daily_streak + 1 : 1;
  user.last_active_date = today;
  if (user.daily_streak > user.best_daily_streak) user.best_daily_streak = user.daily_streak;

  const reward = getStreakReward(user.daily_streak);
  if (reward > 0) user.score += reward;

  await saveUser(user);
  return { action: 'checked_in', daily_streak: user.daily_streak, best_daily_streak: user.best_daily_streak, reward, streak_freezes: user.streak_freezes };
}

// --- Streak freeze ---

async function useStreakFreeze(telegramId) {
  const user = await getUser(telegramId);
  if (!user) return { ok: false, error: 'User not found' };
  if (!user.streak_freezes || user.streak_freezes <= 0) return { ok: false, error: 'No freezes left' };

  const today = getToday(); const yesterday = getYesterday();
  if (user.last_active_date === today || user.last_active_date === yesterday) return { ok: false, error: 'Streak is not broken' };
  if (!user.daily_streak) return { ok: false, error: 'No streak to restore' };

  user.streak_freezes -= 1;
  user.last_active_date = yesterday;
  await saveUser(user);
  return { ok: true, daily_streak: user.daily_streak, streak_freezes: user.streak_freezes };
}

// --- Questions ---

async function getActiveQuestions(timeframe) {
  if (timeframe && timeframe !== 'all') {
    const { rows } = await pool.query('SELECT * FROM questions WHERE is_active=true AND timeframe=$1 ORDER BY id DESC', [timeframe]);
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM questions WHERE is_active=true ORDER BY id DESC');
  return rows;
}

async function getQuestion(id) {
  const { rows } = await pool.query('SELECT * FROM questions WHERE id=$1', [id]);
  return rows[0] || null;
}

async function addQuestion({ text, option_a, option_b, option_c, category, timeframe, autoCheck, expires_at }) {
  let expAt = expires_at || null;
  if (!expAt && autoCheck?.check_after) expAt = autoCheck.check_after;
  const { rows } = await pool.query(
    `INSERT INTO questions (text, option_a, option_b, option_c, category, timeframe, auto_check, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [text, option_a, option_b, option_c || null, category || 'general', timeframe || 'tomorrow', autoCheck ? JSON.stringify(autoCheck) : null, expAt]
  );
  return rows[0].id;
}

// --- Predictions ---

async function getPrediction(userId, questionId) {
  const { rows } = await pool.query('SELECT * FROM predictions WHERE user_id=$1 AND question_id=$2', [userId, questionId]);
  return rows[0] || null;
}

async function countVotes(questionId, answer) {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM predictions WHERE question_id=$1 AND answer=$2', [questionId, answer]);
  return parseInt(rows[0].c);
}

async function addPrediction(userId, questionId, answer) {
  await pool.query('INSERT INTO predictions (user_id, question_id, answer) VALUES ($1,$2,$3)', [userId, questionId, answer]);
  await pool.query('UPDATE users SET score = score + 5, total = total + 1 WHERE telegram_id = $1', [userId]);
  return getUser(userId);
}

// --- Resolve ---

async function resolveQuestion(questionId, correctAnswer) {
  const q = await getQuestion(questionId);
  if (!q || q.resolved) return { ok: false };

  await pool.query('UPDATE questions SET correct_answer=$1, resolved=true WHERE id=$2', [correctAnswer, questionId]);

  const { rows: preds } = await pool.query('SELECT * FROM predictions WHERE question_id=$1', [questionId]);
  let winnersCount = 0;

  for (const pred of preds) {
    const isCorrect = pred.answer === correctAnswer;
    await pool.query('UPDATE predictions SET is_correct=$1, points_earned=$2 WHERE id=$3',
      [isCorrect, isCorrect ? pred.points_earned + 20 : pred.points_earned, pred.id]);

    if (isCorrect) {
      await pool.query(
        `UPDATE users SET score=score+20, correct=correct+1, streak=streak+1,
         best_streak=GREATEST(best_streak, streak+1) WHERE telegram_id=$1`, [pred.user_id]);
      winnersCount++;
    } else {
      await pool.query('UPDATE users SET streak=0 WHERE telegram_id=$1', [pred.user_id]);
    }
  }
  return { ok: true, question: q.text, correctAnswer, totalPredictions: preds.length, winnersCount };
}

// --- Leaderboard & Stats ---

async function getLeaderboard() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY score DESC LIMIT 50');
  return rows;
}

async function getUserRank(score) {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM users WHERE score > $1', [score]);
  return parseInt(rows[0].c) + 1;
}

async function getRecentPredictions(userId) {
  const { rows } = await pool.query(`
    SELECT p.*, q.text as question_text, q.option_a, q.option_b, q.resolved
    FROM predictions p LEFT JOIN questions q ON p.question_id = q.id
    WHERE p.user_id=$1 ORDER BY p.created_at DESC LIMIT 10`, [userId]);
  return rows;
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT * FROM users');
  return rows;
}

// --- Scheduler helpers ---

async function getAutoCheckPending() {
  const { rows } = await pool.query(`SELECT * FROM questions WHERE auto_check IS NOT NULL AND resolved=false AND is_active=true`);
  return rows;
}

async function hasAutoQuestionsForDate(date) {
  const { rows } = await pool.query(`SELECT COUNT(*) as c FROM questions WHERE auto_check->>'generated_date' = $1`, [date]);
  return parseInt(rows[0].c) > 0;
}

// --- Rooms ---

async function createRoom(ownerId, name, emoji) {
  const code = generateInviteCode();
  const { rows } = await pool.query(
    `INSERT INTO rooms (name, emoji, owner_id, invite_code) VALUES ($1,$2,$3,$4) RETURNING id`,
    [name.slice(0, 30), emoji || '🎯', ownerId, code]
  );
  const roomId = rows[0].id;
  await pool.query('INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)', [roomId, ownerId]);
  return { id: roomId, name: name.slice(0, 30), emoji: emoji || '🎯', invite_code: code };
}

async function getRoom(roomId) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [roomId]);
  return rows[0] || null;
}

async function getRoomByInvite(code) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE invite_code=$1', [code]);
  return rows[0] || null;
}

async function getUserRooms(userId) {
  const { rows } = await pool.query(`
    SELECT r.*,
      (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id=r.id) as members_count,
      (SELECT COUNT(*) FROM room_questions rq WHERE rq.room_id=r.id) as questions_count
    FROM rooms r JOIN room_members m ON r.id=m.room_id WHERE m.user_id=$1`, [userId]);
  return rows;
}

async function getUserOwnedRoomsCount(userId) {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM rooms WHERE owner_id=$1', [userId]);
  return parseInt(rows[0].c);
}

async function joinRoom(roomId, userId) {
  const room = await getRoom(roomId);
  if (!room) return { ok: false, error: 'Room not found' };
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
  if (parseInt(rows[0].c) > 0) return { ok: false, error: 'Already a member' };
  await pool.query('INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)', [roomId, userId]);
  return { ok: true };
}

async function isRoomMember(roomId, userId) {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
  return parseInt(rows[0].c) > 0;
}

async function addRoomQuestion(roomId, userId, text, optA, optB, optC) {
  const { rows } = await pool.query(
    `INSERT INTO room_questions (room_id, text, option_a, option_b, option_c, author_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [roomId, text.slice(0, 200), optA.slice(0, 60), optB.slice(0, 60), optC ? optC.slice(0, 60) : null, userId]
  );
  return { id: rows[0].id, text: text.slice(0, 200), option_a: optA.slice(0, 60), option_b: optB.slice(0, 60), option_c: optC ? optC.slice(0, 60) : null };
}

async function countRoomQuestionsToday(roomId, userId) {
  const today = getToday();
  const { rows } = await pool.query(
    `SELECT COUNT(*) as c FROM room_questions WHERE room_id=$1 AND author_id=$2 AND created_at::date = $3::date`,
    [roomId, userId, today]
  );
  return parseInt(rows[0].c);
}

async function getRoomQuestions(roomId) {
  const { rows } = await pool.query('SELECT * FROM room_questions WHERE room_id=$1 ORDER BY id DESC', [roomId]);
  return rows;
}

async function getRoomQuestion(roomId, qId) {
  const { rows } = await pool.query('SELECT * FROM room_questions WHERE id=$1 AND room_id=$2', [qId, roomId]);
  return rows[0] || null;
}

async function getRoomPredictions(roomQuestionId) {
  const { rows } = await pool.query('SELECT * FROM room_predictions WHERE room_question_id=$1', [roomQuestionId]);
  return rows;
}

async function getRoomPrediction(roomQuestionId, userId) {
  const { rows } = await pool.query('SELECT * FROM room_predictions WHERE room_question_id=$1 AND user_id=$2', [roomQuestionId, userId]);
  return rows[0] || null;
}

async function roomPredict(roomId, questionId, userId, answer) {
  if (!await isRoomMember(roomId, userId)) return { ok: false, error: 'Not a member' };
  const q = await getRoomQuestion(roomId, questionId);
  if (!q) return { ok: false, error: 'Question not found' };
  if (q.resolved) return { ok: false, error: 'Already resolved' };
  if (await getRoomPrediction(questionId, userId)) return { ok: false, error: 'Already predicted' };

  await pool.query('INSERT INTO room_predictions (room_question_id, user_id, answer) VALUES ($1,$2,$3)', [questionId, userId, answer]);
  await pool.query('UPDATE users SET score=score+5, total=total+1 WHERE telegram_id=$1', [userId]);
  return { ok: true, pointsEarned: 5 };
}

async function resolveRoomQuestion(roomId, questionId, userId, correctAnswer) {
  const room = await getRoom(roomId);
  if (!room) return { ok: false, error: 'Room not found' };
  const q = await getRoomQuestion(roomId, questionId);
  if (!q) return { ok: false, error: 'Question not found' };
  if (q.author_id !== userId && room.owner_id !== userId) return { ok: false, error: 'Only author or owner can resolve' };
  if (q.resolved) return { ok: false, error: 'Already resolved' };

  await pool.query('UPDATE room_questions SET correct_answer=$1, resolved=true WHERE id=$2', [correctAnswer, questionId]);
  const preds = await getRoomPredictions(questionId);
  let winners = 0;
  for (const p of preds) {
    const isCorrect = p.answer === correctAnswer;
    await pool.query('UPDATE room_predictions SET is_correct=$1 WHERE id=$2', [isCorrect, p.id]);
    if (isCorrect) {
      await pool.query('UPDATE users SET score=score+20, correct=correct+1 WHERE telegram_id=$1', [p.user_id]);
      winners++;
    }
  }
  return { ok: true, winners, total: preds.length };
}

async function getRoomLeaderboard(roomId) {
  const { rows: members } = await pool.query('SELECT user_id FROM room_members WHERE room_id=$1', [roomId]);
  const questions = await getRoomQuestions(roomId);

  const stats = {};
  for (const m of members) stats[m.user_id] = { user_id: m.user_id, score: 0, correct: 0, total: 0 };

  for (const q of questions) {
    const preds = await getRoomPredictions(q.id);
    for (const p of preds) {
      if (!stats[p.user_id]) continue;
      stats[p.user_id].total++; stats[p.user_id].score += 5;
      if (q.resolved && p.answer === q.correct_answer) { stats[p.user_id].correct++; stats[p.user_id].score += 20; }
    }
  }

  const result = [];
  for (const s of Object.values(stats)) {
    const user = await getUser(s.user_id);
    result.push({ ...s, username: user?.username, first_name: user?.first_name });
  }
  return result.sort((a, b) => b.score - a.score);
}

// --- Achievements ---

const ACHIEVEMENT_DEFS = [
  { type: 'first_prediction', emoji: '🎯', title: 'Первый прогноз', desc: 'Сделай первое предсказание' },
  { type: 'correct_3', emoji: '🔥', title: 'Горячая серия', desc: '3 верных подряд' },
  { type: 'correct_5', emoji: '💎', title: 'Бриллиантовый ум', desc: '5 верных подряд' },
  { type: 'correct_10', emoji: '🧠', title: 'Провидец', desc: '10 верных подряд' },
  { type: 'total_10', emoji: '📝', title: 'Активный игрок', desc: '10 прогнозов' },
  { type: 'total_50', emoji: '⚡', title: 'Опытный', desc: '50 прогнозов' },
  { type: 'total_100', emoji: '👑', title: 'Легенда', desc: '100 прогнозов' },
  { type: 'streak_3', emoji: '🔥', title: '3 дня подряд', desc: 'Серия 3 дня' },
  { type: 'streak_7', emoji: '🌟', title: 'Неделя подряд', desc: 'Серия 7 дней' },
  { type: 'streak_30', emoji: '🏆', title: 'Месяц подряд', desc: 'Серия 30 дней' },
  { type: 'night_owl', emoji: '🦉', title: 'Ночная сова', desc: 'Прогноз между 00:00–05:00' },
  { type: 'featured_correct', emoji: '⭐', title: 'Звёздный ответ', desc: 'Угадай вопрос дня' },
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
    await pool.query('INSERT INTO achievements (user_id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, type]);
    const { rows } = await pool.query('SELECT * FROM achievements WHERE user_id=$1 AND type=$2', [userId, type]);
    return rows[0] || null;
  } catch (e) { return null; }
}

async function checkAndGrantAchievements(userId) {
  const user = await getUser(userId);
  if (!user) return [];
  const granted = [];

  if (user.total >= 1) { const r = await grantAchievement(userId, 'first_prediction'); if (r) granted.push(r); }
  if (user.total >= 10) { const r = await grantAchievement(userId, 'total_10'); if (r) granted.push(r); }
  if (user.total >= 50) { const r = await grantAchievement(userId, 'total_50'); if (r) granted.push(r); }
  if (user.total >= 100) { const r = await grantAchievement(userId, 'total_100'); if (r) granted.push(r); }
  if (user.streak >= 3) { const r = await grantAchievement(userId, 'correct_3'); if (r) granted.push(r); }
  if (user.streak >= 5) { const r = await grantAchievement(userId, 'correct_5'); if (r) granted.push(r); }
  if (user.streak >= 10) { const r = await grantAchievement(userId, 'correct_10'); if (r) granted.push(r); }
  if (user.daily_streak >= 3) { const r = await grantAchievement(userId, 'streak_3'); if (r) granted.push(r); }
  if (user.daily_streak >= 7) { const r = await grantAchievement(userId, 'streak_7'); if (r) granted.push(r); }
  if (user.daily_streak >= 30) { const r = await grantAchievement(userId, 'streak_30'); if (r) granted.push(r); }

  const hour = new Date().getUTCHours() + 3;
  if (hour >= 0 && hour < 5) { const r = await grantAchievement(userId, 'night_owl'); if (r) granted.push(r); }

  return granted;
}

// --- Weekly stats ---

async function getWeeklyStats(userId) {
  const { rows } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(CASE WHEN is_correct = true THEN 1 END) as correct,
      COALESCE(SUM(points_earned), 0) as points
    FROM predictions WHERE user_id=$1 AND created_at > NOW() - INTERVAL '7 days'
  `, [userId]);
  return rows[0];
}

async function getTotalUsersCount() {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM users');
  return parseInt(rows[0].c);
}

// --- Predictions for notify ---

async function getPredictionsForQuestion(questionId) {
  const { rows } = await pool.query('SELECT * FROM predictions WHERE question_id=$1', [questionId]);
  return rows;
}

module.exports = {
  initDB, pool,
  getUser, createUser, saveUser, checkIn, useStreakFreeze,
  getStreakReward, getStreakMilestones, getToday, getYesterday,
  getActiveQuestions, getQuestion, addQuestion, getPrediction, countVotes,
  addPrediction, resolveQuestion, getLeaderboard, getUserRank, getRecentPredictions, getAllUsers,
  getAutoCheckPending, hasAutoQuestionsForDate,
  createRoom, getRoom, getRoomByInvite, getUserRooms, getUserOwnedRoomsCount,
  joinRoom, isRoomMember, addRoomQuestion, countRoomQuestionsToday,
  getRoomQuestions, getRoomQuestion, getRoomPredictions, getRoomPrediction,
  roomPredict, resolveRoomQuestion, getRoomLeaderboard,
  ACHIEVEMENT_DEFS, getAchievements, grantAchievement, checkAndGrantAchievements,
  getWeeklyStats, getTotalUsersCount, getPredictionsForQuestion,
};
