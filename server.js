require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

// --- Telegram Bot setup ---

let bot;
if (BOT_TOKEN) {
  const isProduction = !!process.env.RENDER || !!process.env.DATABASE_URL;
  if (isProduction && WEBAPP_URL) {
    bot = new TelegramBot(BOT_TOKEN);
    const webhookPath = `/bot${BOT_TOKEN}`;
    app.post(webhookPath, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    console.log('[Bot] Webhook mode');
  } else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('[Bot] Polling mode');
  }
  setupBotHandlers();
}

function setupBotHandlers() {
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const referral = match[1] ? match[1].trim() : '';
    const webAppUrl = referral ? `${WEBAPP_URL}?ref=${referral}` : WEBAPP_URL;

    const user = await db.getUser(msg.from.id);
    if (user) { user.chat_id = chatId; await db.saveUser(user); }

    bot.sendMessage(chatId,
      '🔮 *Предскажи* — проверь свою интуицию!\n\n' +
      'Отвечай на вопросы, набирай очки и соревнуйся с друзьями.\n\n' +
      '⚡ +5 за ответ\n🎯 +20 за верный прогноз\n🔥 Бонусы за серию дней',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎯 Играть', web_app: { url: webAppUrl } }]] } }
    );
  });

  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await db.getUser(msg.from.id);
    if (user) {
      user.chat_id = chatId; await db.saveUser(user);
      const accuracy = user.total > 0 ? Math.round((user.correct / user.total) * 100) : 0;
      bot.sendMessage(chatId,
        `📊 *Твоя статистика*\n\n⚡ Очки: ${user.score}\n🔥 Серия: ${user.daily_streak || 0} дн.\n🎯 Точность: ${accuracy}%\n❄️ Заморозок: ${user.streak_freezes || 0}\n📝 Ответов: ${user.total}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📊 Подробнее', web_app: { url: `${WEBAPP_URL}#stats` } }]] } }
      );
    } else {
      bot.sendMessage(chatId, 'Ты ещё не играл. Нажми /start!');
    }
  });

  bot.onText(/\/top/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await db.getUser(msg.from.id);
    if (user) { user.chat_id = chatId; await db.saveUser(user); }
    const leaders = (await db.getLeaderboard()).slice(0, 10);
    if (!leaders.length) { bot.sendMessage(chatId, 'Пока нет участников!'); return; }
    const medals = ['🥇', '🥈', '🥉'];
    let text = '🏆 *Топ-10 игроков*\n\n';
    leaders.forEach((u, i) => {
      const medal = i < 3 ? medals[i] : `${i + 1}.`;
      const name = u.first_name || u.username || 'Аноним';
      text += `${medal} ${name}${u.telegram_id === msg.from.id ? ' (ты)' : ''} — ${u.score} очков\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/invite/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await db.getUser(msg.from.id);
    if (user) { user.chat_id = chatId; await db.saveUser(user); }
    const botInfo = await bot.getMe();
    const link = `https://t.me/${botInfo.username}?start=${msg.from.id}`;
    bot.sendMessage(chatId, `🔗 *Твоя реферальная ссылка:*\n\n\`${link}\`\n\nЗа каждого друга: *+50 очков*!`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/notify/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await db.getUser(msg.from.id);
    if (user) {
      user.chat_id = chatId; user.notifications = !user.notifications;
      await db.saveUser(user);
      bot.sendMessage(chatId, `Уведомления ${user.notifications ? 'включены ✅' : 'выключены ❌'}`);
    }
  });

  bot.on('pre_checkout_query', (query) => { bot.answerPreCheckoutQuery(query.id, true); });

  bot.on('message', async (msg) => {
    if (!msg.successful_payment) return;
    const userId = msg.from.id;
    const payload = msg.successful_payment.invoice_payload;
    const user = await db.getUser(userId);
    if (!user) return;
    let freezesAdded = payload.startsWith('freeze3_') ? 3 : payload.startsWith('freeze_') ? 1 : 0;
    if (freezesAdded > 0) {
      user.streak_freezes = (user.streak_freezes || 0) + freezesAdded;
      await db.saveUser(user);
      bot.sendMessage(msg.chat.id, `✅ Оплата прошла! Заморозок: *${freezesAdded}*\n❄️ Всего: *${user.streak_freezes}*`, { parse_mode: 'Markdown' });
    }
  });
}

// --- Validate Telegram initData ---

function validateTelegramData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (checkHash !== hash) return null;
  const user = params.get('user');
  return user ? JSON.parse(user) : null;
}

// --- API Routes ---

app.post('/api/auth', async (req, res) => {
  try {
    const { initData, referredBy } = req.body;
    let tgUser = validateTelegramData(initData);
    if (!tgUser) tgUser = { id: Date.now(), username: 'demo_user', first_name: 'Demo' };
    let user = await db.getUser(tgUser.id);
    if (!user) user = await db.createUser(tgUser, referredBy ? parseInt(referredBy) : null);
    const checkin = await db.checkIn(user.telegram_id);
    user = await db.getUser(user.telegram_id);
    res.json({ ok: true, user, checkin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/checkin', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const result = await db.checkIn(userId);
    if (!result) return res.status(404).json({ error: 'User not found' });
    const user = await db.getUser(userId);
    res.json({ ok: true, ...result, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streak/freeze', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const result = await db.useStreakFreeze(userId);
    if (!result.ok) return res.status(400).json(result);
    const user = await db.getUser(userId);
    res.json({ ok: true, ...result, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streak/buy-freeze', async (req, res) => {
  try {
    const { userId } = req.body; if (!userId) return res.status(400).json({ error: 'userId required' });
    const user = await db.getUser(userId); if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.score < 100) return res.status(400).json({ error: 'Not enough points', needed: 100, have: user.score });
    user.score -= 100; user.streak_freezes = (user.streak_freezes || 0) + 1;
    await db.saveUser(user);
    res.json({ ok: true, streak_freezes: user.streak_freezes, score: user.score });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/streak/milestones', (req, res) => { res.json({ ok: true, milestones: db.getStreakMilestones() }); });

app.post('/api/payment/create-invoice', async (req, res) => {
  try {
    const { userId, item } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!BOT_TOKEN) return res.status(400).json({ error: 'Bot not configured' });
    const items = {
      freeze: { title: 'Заморозка серии', description: 'Восстанови серию!', price: 50, payload: `freeze_${userId}_${Date.now()}` },
      freeze_3: { title: '3 заморозки', description: 'Пакет со скидкой', price: 100, payload: `freeze3_${userId}_${Date.now()}` }
    };
    const product = items[item || 'freeze']; if (!product) return res.status(400).json({ error: 'Unknown item' });
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: product.title, description: product.description, payload: product.payload, currency: 'XTR', prices: [{ label: product.title, amount: product.price }] })
    });
    const data = await response.json();
    data.ok ? res.json({ ok: true, invoiceLink: data.result }) : res.status(500).json({ error: data.description });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment/verify', async (req, res) => {
  try {
    const { userId, item } = req.body; if (!userId) return res.status(400).json({ error: 'userId required' });
    const user = await db.getUser(userId); if (!user) return res.status(404).json({ error: 'User not found' });
    const count = item === 'freeze_3' ? 3 : 1;
    user.streak_freezes = (user.streak_freezes || 0) + count; await db.saveUser(user);
    res.json({ ok: true, streak_freezes: user.streak_freezes, added: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/questions', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId); const timeframe = req.query.timeframe || 'all';
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const questions = await db.getActiveQuestions(timeframe);
    const result = [];
    for (const q of questions) {
      const votes_a = await db.countVotes(q.id, 'a'); const votes_b = await db.countVotes(q.id, 'b');
      const votes_c = q.option_c ? await db.countVotes(q.id, 'c') : 0;
      const pred = await db.getPrediction(userId, q.id);
      result.push({ ...q, auto_check: undefined, votes_a, votes_b, votes_c, user_answer: pred?.answer || null,
        user_was_correct: pred && q.resolved ? pred.answer === q.correct_answer : null });
    }
    res.json({ ok: true, questions: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/predict', async (req, res) => {
  try {
    const { userId, questionId, answer } = req.body;
    if (!userId || !questionId || !answer) return res.status(400).json({ error: 'Missing fields' });
    if (!['a', 'b', 'c'].includes(answer)) return res.status(400).json({ error: 'Invalid answer' });
    const question = await db.getQuestion(questionId);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    if (answer === 'c' && !question.option_c) return res.status(400).json({ error: 'No option C for this question' });
    if (question.resolved) return res.status(400).json({ error: 'Already resolved' });
    if (await db.getPrediction(userId, questionId)) return res.status(409).json({ error: 'Already predicted' });
    const user = await db.addPrediction(userId, questionId, answer);
    const votes_a = await db.countVotes(questionId, 'a'); const votes_b = await db.countVotes(questionId, 'b');
    const votes_c = question.option_c ? await db.countVotes(questionId, 'c') : 0;
    res.json({ ok: true, question: { ...question, votes_a, votes_b, votes_c }, user, pointsEarned: 5 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaders = (await db.getLeaderboard()).map(u => ({
      telegram_id: u.telegram_id, username: u.username, first_name: u.first_name,
      score: u.score, correct: u.correct, total: u.total, best_streak: u.best_streak
    }));
    res.json({ ok: true, leaders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = await db.getUser(userId); if (!user) return res.status(404).json({ error: 'User not found' });
    const rank = await db.getUserRank(user.score);
    const recentPredictions = await db.getRecentPredictions(userId);
    res.json({ ok: true, user, rank, recentPredictions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/resolve', async (req, res) => {
  try {
    const { key, questionId, correctAnswer } = req.body;
    if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
    if (!questionId || !correctAnswer || !['a', 'b', 'c'].includes(correctAnswer)) return res.status(400).json({ error: 'Missing/invalid fields' });
    const result = await db.resolveQuestion(questionId, correctAnswer);
    if (!result.ok) return res.status(400).json({ error: 'Not found or already resolved' });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/questions', async (req, res) => {
  try {
    if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
    const questions = await db.getActiveQuestions('all');
    const result = [];
    for (const q of questions) {
      const va = await db.countVotes(q.id, 'a'); const vb = await db.countVotes(q.id, 'b');
      result.push({ ...q, auto_check: undefined, votes_a: va, votes_b: vb, total_votes: va + vb });
    }
    res.json({ ok: true, questions: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/question', async (req, res) => {
  try {
    const { key, text, option_a, option_b, option_c, category, timeframe } = req.body;
    if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
    if (!text || !option_a || !option_b) return res.status(400).json({ error: 'Missing fields' });
    const qId = await db.addQuestion({ text, option_a, option_b, option_c, category, timeframe });
    res.json({ ok: true, questionId: qId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/generate', async (req, res) => {
  try {
    if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
    const scheduler = require('./scheduler');
    await scheduler.runOnce();
    res.json({ ok: true, message: 'Scheduler cycle complete' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ROOMS API ---

app.get('/api/rooms', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId); if (!userId) return res.status(400).json({ error: 'userId required' });
    const rooms = (await db.getUserRooms(userId)).map(r => ({
      id: r.id, name: r.name, emoji: r.emoji, members_count: parseInt(r.members_count),
      questions_count: parseInt(r.questions_count), is_owner: r.owner_id === userId, invite_code: r.invite_code
    }));
    res.json({ ok: true, rooms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms/create', async (req, res) => {
  try {
    const { userId, name, emoji } = req.body;
    if (!userId || !name) return res.status(400).json({ error: 'userId and name required' });
    if (await db.getUserOwnedRoomsCount(userId) >= 5) return res.status(400).json({ error: 'Max 5 rooms' });
    const room = await db.createRoom(userId, name, emoji);
    res.json({ ok: true, room });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms/join', async (req, res) => {
  try {
    const { userId, inviteCode } = req.body;
    if (!userId || !inviteCode) return res.status(400).json({ error: 'userId and inviteCode required' });
    const room = await db.getRoomByInvite(inviteCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const result = await db.joinRoom(room.id, userId);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, room: { id: room.id, name: room.name, emoji: room.emoji } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rooms/:roomId', async (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId); const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const room = await db.getRoom(roomId); if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!await db.isRoomMember(roomId, userId)) return res.status(403).json({ error: 'Not a member' });

    const rawQs = await db.getRoomQuestions(roomId);
    const questions = [];
    for (const q of rawQs) {
      const preds = await db.getRoomPredictions(q.id);
      const votesA = preds.filter(p => p.answer === 'a').length; const votesB = preds.filter(p => p.answer === 'b').length;
      const userPred = preds.find(p => p.user_id === userId);
      const author = await db.getUser(q.author_id);
      questions.push({
        id: q.id, text: q.text, option_a: q.option_a, option_b: q.option_b,
        author_name: author?.first_name || author?.username || '?',
        votes_a: votesA, votes_b: votesB, user_answer: userPred?.answer || null,
        resolved: q.resolved, correct_answer: q.correct_answer,
        user_was_correct: userPred && q.resolved ? userPred.answer === q.correct_answer : null,
        can_resolve: (q.author_id === userId || room.owner_id === userId) && !q.resolved
      });
    }
    const leaderboard = await db.getRoomLeaderboard(roomId);
    const userRooms = await db.getUserRooms(userId);
    const membersCount = userRooms.find(r => r.id === roomId)?.members_count || 0;
    res.json({ ok: true, room: { id: room.id, name: room.name, emoji: room.emoji, members_count: parseInt(membersCount), is_owner: room.owner_id === userId, invite_code: room.invite_code }, questions, leaderboard });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms/:roomId/question', async (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId);
    const { userId, text, option_a, option_b } = req.body;
    if (!userId || !text || !option_a || !option_b) return res.status(400).json({ error: 'Missing fields' });
    if (await db.countRoomQuestionsToday(roomId, userId) >= 5) return res.status(400).json({ error: 'Max 5 questions per day' });
    const question = await db.addRoomQuestion(roomId, userId, text, option_a, option_b);
    res.json({ ok: true, question });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms/:roomId/predict', async (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId);
    const { userId, questionId, answer } = req.body;
    if (!userId || !questionId || !answer) return res.status(400).json({ error: 'Missing fields' });
    const result = await db.roomPredict(roomId, questionId, userId, answer);
    if (!result.ok) return res.status(400).json(result);
    const user = await db.getUser(userId);
    const preds = await db.getRoomPredictions(questionId);
    res.json({ ok: true, votes_a: preds.filter(p => p.answer === 'a').length, votes_b: preds.filter(p => p.answer === 'b').length, pointsEarned: 5, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms/:roomId/resolve', async (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId);
    const { userId, questionId, correctAnswer } = req.body;
    if (!userId || !questionId || !correctAnswer) return res.status(400).json({ error: 'Missing fields' });
    const result = await db.resolveRoomQuestion(roomId, questionId, userId, correctAnswer);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, winners: result.winners, total: result.total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Start ---

const PORT = process.env.PORT || 3000;

async function start() {
  await db.initDB();
  console.log('[DB] PostgreSQL connected & schema ready');

  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    if (bot && WEBAPP_URL && (process.env.RENDER || process.env.DATABASE_URL)) {
      try {
        await bot.setWebHook(`${WEBAPP_URL}/bot${BOT_TOKEN}`);
        console.log(`[Bot] Webhook set: ${WEBAPP_URL}/bot${BOT_TOKEN.slice(0, 10)}...`);
      } catch (e) { console.error('[Bot] Webhook error:', e.message); }
    }

    const scheduler = require('./scheduler');
    scheduler.start();
  });
}

start().catch(e => { console.error('Startup error:', e); process.exit(1); });
