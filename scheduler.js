const db = require('./database');
const pkg = require('./package.json');

let _bot = null;
let _botUsername = null;

function setBot(bot) { _bot = bot; }

function miniAppUrl() {
  const raw = (process.env.WEBAPP_URL || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  const tag = encodeURIComponent((process.env.APP_VERSION || pkg.version || '1').toString());
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}tgcb=${tag}`;
}

async function getBotUsername() {
  if (_botUsername) return _botUsername;
  if (!_bot) return 'bot';
  try { _botUsername = (await _bot.getMe()).username; } catch (e) { _botUsername = 'bot'; }
  return _botUsername;
}

function playButton() {
  const url = miniAppUrl();
  if (!url) return undefined;
  return { reply_markup: { inline_keyboard: [[{ text: '🎯 Играть ещё', web_app: { url } }]] } };
}

const MOTIVATIONS = [
  'Попробуй ещё — рынок ждёт!',
  'Один раунд до идеала!',
  'Ты на верном пути, продолжай!',
  'В следующий раз повезёт больше!',
  'Аналитик в тебе крепнет 💪',
];

function randomMotivation() {
  return MOTIVATIONS[Math.floor(Math.random() * MOTIVATIONS.length)];
}

function buildRoundBar(count) {
  let bar = '';
  for (let i = 0; i < 5; i++) bar += i < count ? '🟢' : '🔴';
  return bar;
}

async function processRoundResolution(round) {
  try {
    const result = await db.resolveRound(round.id);
    if (!result) return;

    const c = result.correctCount;
    console.log(`[Scheduler] Round #${round.id}: ${c}/5`);

    const newAchievements = await db.checkAchievements(round.user_id);

    const dmId = result.user && (result.user.chat_id || result.user.telegram_id);
    if (_bot && dmId) {
      const rating = db.computeLeaderboardRating(result.user);
      const bar = buildRoundBar(c);

      let msg;
      if (result.is5of5) {
        msg = `🏆🏆🏆 ИДЕАЛЬНЫЙ РАУНД! 🏆🏆🏆\n\n`;
        msg += `${bar}  5 из 5!\n\n`;
        msg += `🎫 +1 билет в розыгрыш 500⭐\n`;
        if (result.premiumGranted) msg += `🌟 Premium на 3 дня — бонус за мастерство!\n`;
        if (result.streak > 1) msg += `🔥 Серия идеальных: ${result.streak} подряд! Невероятно!\n`;
        msg += `\n📊 Твой рейтинг: ${rating} очков`;
      } else if (c >= 4) {
        msg = `🔥 Почти идеально!\n\n${bar}  ${c} из 5\n\n`;
        msg += `Совсем чуть-чуть! Ещё один раунд — и 5/5 твой! 💪\n`;
        msg += `📊 Рейтинг: ${rating} очков`;
      } else if (c >= 3) {
        msg = `👍 Неплохо!\n\n${bar}  ${c} из 5\n\n`;
        msg += `Больше половины верно — ты разбираешься!\n`;
        msg += `${randomMotivation()}\n📊 Рейтинг: ${rating}`;
      } else if (c >= 1) {
        msg = `📉 Раунд завершён\n\n${bar}  ${c} из 5\n\n`;
        msg += `${randomMotivation()}\n📊 Рейтинг: ${rating}`;
      } else {
        msg = `😬 Ни одного попадания!\n\n${bar}  0 из 5\n\n`;
        msg += `Бывает! Рынок непредсказуем — попробуй ещё раз 🎲\n📊 Рейтинг: ${rating}`;
      }

      if (newAchievements.length > 0) {
        const defs = db.ACHIEVEMENT_DEFS;
        msg += '\n';
        for (const a of newAchievements) {
          const def = defs.find(d => d.type === a.type);
          if (def) msg += `\n🏅 Новая ачивка: ${def.emoji} ${def.title}!`;
        }
      }

      try { await _bot.sendMessage(dmId, msg, playButton()); } catch (e) {}
    }

    if (_bot && result.referralTicketForReferrerId) {
      const refUser = await db.getUser(result.referralTicketForReferrerId);
      const refDm = refUser && (refUser.chat_id || refUser.telegram_id);
      if (refDm) {
        try {
          await _bot.sendMessage(refDm,
            '🎁 Отличная новость!\n\nТвой друг доиграл первый раунд — тебе +1 билет в недельный розыгрыш 500⭐!\nПриглашай ещё друзей — больше билетов, больше шансов!',
            playButton()
          );
        } catch (e) {}
      }
    }
  } catch (e) {
    console.error(`[Scheduler] Failed to resolve round #${round.id}:`, e.message);
  }
}

async function resolveRounds() {
  try {
    const pending = await db.getPendingRounds();
    if (pending.length === 0) return;

    console.log(`[Scheduler] Resolving ${pending.length} round(s)...`);

    for (const round of pending) {
      await processRoundResolution(round);
    }
  } catch (e) {
    console.error('[Scheduler] resolveRounds error:', e.message);
  }
}

/** Только раунды текущего пользователя — быстро для API, не блокирует весь сервер */
async function resolvePendingRoundsForUser(userId) {
  try {
    const pending = await db.getPendingRoundsForUser(userId);
    for (const round of pending) {
      await processRoundResolution(round);
    }
  } catch (e) {
    console.error('[Scheduler] resolvePendingRoundsForUser error:', e.message);
  }
}

async function resolveDuels() {
  try {
    const pending = await db.getPendingDuels();
    if (pending.length === 0) return;

    console.log(`[Scheduler] Resolving ${pending.length} duel(s)...`);

    for (const duel of pending) {
      try {
        const result = await db.resolveDuel(duel.id);
        if (!result) continue;

        console.log(`[Scheduler] Duel #${duel.id}: ${result.creatorCorrect} vs ${result.opponentCorrect}`);

        if (_bot) {
          const creator = await db.getUser(duel.creator_id);
          const opponent = await db.getUser(duel.opponent_id);
          const cName = creator?.first_name || 'Игрок 1';
          const oName = opponent?.first_name || 'Игрок 2';
          const cc = result.creatorCorrect;
          const oc = result.opponentCorrect;

          const cId = creator && (creator.chat_id || creator.telegram_id);
          const oId = opponent && (opponent.chat_id || opponent.telegram_id);

          function duelMsg(isCreator) {
            const you = isCreator ? cc : oc;
            const they = isCreator ? oc : cc;
            const opponentName = isCreator ? oName : cName;
            const youWon = (isCreator && result.winnerId == duel.creator_id) || (!isCreator && result.winnerId == duel.opponent_id);

            let header, body;
            if (result.isDraw) {
              header = '⚔️🤝 НИЧЬЯ!';
              body = `Ты: ${you}/5 — ${opponentName}: ${they}/5\n\nРавный бой! Кто победит в следующий раз?`;
            } else if (youWon) {
              header = '⚔️🏆 ПОБЕДА!';
              body = `Ты: ${you}/5 — ${opponentName}: ${they}/5\n\n🎉 Отличная победа! Ты доказал, что разбираешься!`;
            } else {
              header = '⚔️💔 Поражение';
              body = `Ты: ${you}/5 — ${opponentName}: ${they}/5\n\nНе сдавайся — реванш ждёт! 💪`;
            }

            const user = isCreator ? creator : opponent;
            const rating = db.computeLeaderboardRating(user);
            const stats = `📊 Рейтинг: ${rating} | Побед: ${user?.duel_wins || 0} | Серия 5/5: ${user?.best_streak || 0}`;
            return `${header}\n\n${body}\n\n${stats}`;
          }

          if (cId) { try { await _bot.sendMessage(cId, duelMsg(true), playButton()); } catch (e) {} }
          if (oId) { try { await _bot.sendMessage(oId, duelMsg(false), playButton()); } catch (e) {} }

          try {
            const alreadyFriends = await db.areFriends(duel.creator_id, duel.opponent_id);
            if (!alreadyFriends) {
              const botName = await getBotUsername();
              const creatorLink = `https://t.me/${botName}?startapp=friend_${duel.creator_id}`;
              const opponentLink = `https://t.me/${botName}?startapp=friend_${duel.opponent_id}`;
              if (oId) { try { await _bot.sendMessage(oId, '👥 Добавить соперника в друзья?', { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить в друзья', url: creatorLink }]] } }); } catch (e) {} }
              if (cId) { try { await _bot.sendMessage(cId, '👥 Добавить соперника в друзья?', { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить в друзья', url: opponentLink }]] } }); } catch (e) {} }
            }
          } catch (e) { console.error('[Scheduler] Friend suggest error:', e.message); }
        }
      } catch (e) {
        console.error(`[Scheduler] Failed to resolve duel #${duel.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Scheduler] resolveDuels error:', e.message);
  }
}

async function weeklyRaffleCheck() {
  try {
    const now = new Date();
    if (now.getDay() !== 0 || now.getHours() !== 20) return; // Sunday 20:00

    const weekKey = db.getWeekKey();
    const existing = await db.getRaffle(weekKey);
    if (existing?.winner_id) return;

    console.log(`[Scheduler] Drawing weekly raffle for ${weekKey}...`);
    const result = await db.drawRaffle(weekKey);

    if (result.ok && _bot) {
      const winner = await db.getUser(result.winner_id);
      const wId = winner && (winner.chat_id || winner.telegram_id);
      if (wId) {
        await _bot.sendMessage(wId,
          `🎉🎉🎉 ПОЗДРАВЛЯЕМ!\n\n` +
          `Ты выиграл(а) ${result.prize_stars}⭐ в розыгрыше недели!\n` +
          `Из ${result.total_tickets} билетов — твой оказался счастливым!\n\n` +
          `Приз будет отправлен администратором.`
        );
      }

      const allUsers = await db.getAllUsers();
      for (const u of allUsers) {
        const uid = u.chat_id || u.telegram_id;
        if (uid && u.telegram_id != result.winner_id) {
          try {
            await _bot.sendMessage(uid,
              `📢 Розыгрыш недели ${weekKey} завершён!\n` +
              `Победитель: ${winner?.first_name || 'Аноним'} — ${result.prize_stars}⭐!\n` +
              `Всего билетов: ${result.total_tickets}. Играй, чтобы получить билеты на следующую неделю!`
            );
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    console.error('[Scheduler] weeklyRaffleCheck error:', e.message);
  }
}

const REMINDER_MESSAGES = [
  { text: '🎯 Давно не заходил! Рынок двигается — проверь свою интуицию!', hours: 24 },
  { text: '📈 Ты пропустил уже сутки. Курсы изменились — успей предсказать!', hours: 48 },
  { text: '🔥 Твоя серия может сгореть! Зайди и сделай прогноз — 2 минуты.', hours: 72 },
];

async function sendReminders() {
  if (!_bot) return;
  const url = miniAppUrl();
  const btn = url ? { reply_markup: { inline_keyboard: [[{ text: '🎯 Вернуться в игру', web_app: { url } }]] } } : undefined;

  for (const rem of REMINDER_MESSAGES) {
    try {
      const users = await db.getInactiveUsers(rem.hours);
      for (const u of users) {
        const dmId = u.chat_id || u.telegram_id;
        if (!dmId) continue;
        try { await _bot.sendMessage(dmId, rem.text, btn); } catch (e) {}
      }
      if (users.length > 0) console.log(`[Reminder] Sent ${rem.hours}h reminder to ${users.length} user(s)`);
    } catch (e) {
      console.error(`[Reminder] ${rem.hours}h error:`, e.message);
    }
  }
}

function start() {
  console.log('[Scheduler] Started (every 2 min)');

  setInterval(async () => {
    await resolveRounds();
    await resolveDuels();
  }, 120000);

  setInterval(async () => {
    await weeklyRaffleCheck();
    try { await db.cleanupStaleDuels(); } catch (e) { console.error('[Scheduler] cleanupStaleDuels:', e.message); }
  }, 3600000);

  setInterval(async () => {
    const hourMSK = (new Date().getUTCHours() + 3) % 24;
    if (hourMSK >= 10 && hourMSK <= 21) {
      await sendReminders();
    }
  }, 3600000);

  setTimeout(async () => {
    await resolveRounds();
    await resolveDuels();
  }, 10000);
}

module.exports = {
  setBot, start, resolveRounds, resolvePendingRoundsForUser, resolveDuels, weeklyRaffleCheck, sendReminders,
};
