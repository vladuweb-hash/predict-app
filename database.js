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

  // Migration: add option_c if missing
  try {
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_c TEXT');
    await pool.query('ALTER TABLE room_questions ADD COLUMN IF NOT EXISTS option_c TEXT');
  } catch (e) { /* column already exists */ }

  const { rows } = await pool.query('SELECT COUNT(*) as c FROM questions');
  if (parseInt(rows[0].c) === 0) {
    const seed = [
      ['Курс доллара вырастет завтра?', 'Вырастет', 'Упадёт', 'finance', 'tomorrow'],
      ['Завтра будет солнечно в Москве?', 'Да, солнце', 'Нет, облачно/дождь', 'general', 'tomorrow'],
      ['Bitcoin вырастет за завтрашний день?', 'Вырастет', 'Упадёт', 'crypto', 'tomorrow'],
      ['Какая команда победит в матче Лиги Чемпионов?', 'Хозяева', 'Гости', 'sport', 'tomorrow'],
      ['Акции Tesla вырастут завтра?', 'Да', 'Нет', 'finance', 'tomorrow'],
      ['Какой фильм будет #1 в прокате на этой неделе?', 'Marvel/DC', 'Другой фильм', 'movies', 'week'],
      ['Золото подорожает за эту неделю?', 'Подорожает', 'Подешевеет', 'finance', 'week'],
      ['Илон Маск напишет больше 20 постов в X за неделю?', 'Больше 20', 'Меньше 20', 'tech', 'week'],
      ['Биткоин будет выше $90K к концу недели?', 'Да, выше', 'Нет, ниже', 'crypto', 'week'],
      ['Выйдет ли громкий скандал в шоу-бизнесе на этой неделе?', 'Да, выйдет', 'Тихая неделя', 'general', 'week'],
      ['Bitcoin превысит $100K до конца месяца?', 'Да, превысит', 'Нет, не дойдёт', 'crypto', 'month'],
      ['Tesla выпустит бюджетную модель до $25K?', 'Да, объявят', 'Нет', 'tech', 'month'],
      ['AI-стартап привлечёт раунд больше $1B в этом месяце?', 'Да', 'Нет', 'tech', 'month'],
      ['Telegram выпустит крупное обновление в этом месяце?', 'Да, выпустит', 'Нет', 'tech', 'month'],
      ['Нефть будет дороже $80 к концу месяца?', 'Да, дороже', 'Нет, дешевле', 'finance', 'month'],
    ];
    for (const [text, a, b, cat, tf] of seed) {
      await pool.query(
        'INSERT INTO questions (text, option_a, option_b, category, timeframe) VALUES ($1,$2,$3,$4,$5)',
        [text, a, b, cat, tf]
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

async function addQuestion({ text, option_a, option_b, option_c, category, timeframe, autoCheck }) {
  const { rows } = await pool.query(
    `INSERT INTO questions (text, option_a, option_b, option_c, category, timeframe, auto_check)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [text, option_a, option_b, option_c || null, category || 'general', timeframe || 'tomorrow', autoCheck ? JSON.stringify(autoCheck) : null]
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
};
