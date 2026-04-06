const db = require('./database');

let _bot = null;

function setBot(bot) { _bot = bot; }

async function processRoundResolution(round) {
  try {
    const result = await db.resolveRound(round.id);
    if (!result) return;

    console.log(`[Scheduler] Round #${round.id}: ${result.correctCount}/5`);

    const newAchievements = await db.checkAchievements(round.user_id);

    const dmId = result.user && (result.user.chat_id || result.user.telegram_id);
    if (_bot && dmId) {
      let msg;
      if (result.is5of5) {
        msg = `🎯 Раунд #${round.id} завершён: 5/5! Идеально!\n`;
        if (result.premiumGranted) {
          msg += `🌟 Premium на 3 дня активирован!\n`;
        }
        msg += `🎫 +1 билет в розыгрыш недели!`;
        if (result.streak > 1) msg += `\n🔥 Серия 5/5: ${result.streak} подряд!`;
      } else {
        const emoji = result.correctCount >= 3 ? '👍' : '😔';
        msg = `${emoji} Раунд #${round.id}: ${result.correctCount}/5`;
      }

      if (newAchievements.length > 0) {
        const defs = db.ACHIEVEMENT_DEFS;
        for (const a of newAchievements) {
          const def = defs.find(d => d.type === a.type);
          if (def) msg += `\n🏅 Новая ачивка: ${def.emoji} ${def.title}!`;
        }
      }

      try { await _bot.sendMessage(dmId, msg); } catch (e) { /* user may have blocked bot */ }
    }

    if (_bot && result.referralTicketForReferrerId) {
      const refUser = await db.getUser(result.referralTicketForReferrerId);
      const refDm = refUser && (refUser.chat_id || refUser.telegram_id);
      if (refDm) {
        try {
          await _bot.sendMessage(refDm, '🎁 Приглашённый друг доиграл первый раунд — тебе +1 билет в недельный розыгрыш!');
        } catch (e) { /* blocked */ }
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

          let resultText;
          if (result.isDraw) {
            resultText = `🤝 Ничья! ${result.creatorCorrect}:${result.opponentCorrect}`;
          } else {
            const winnerName = result.winnerId == duel.creator_id
              ? (creator?.first_name || 'Игрок 1')
              : (opponent?.first_name || 'Игрок 2');
            resultText = `🏆 Победил ${winnerName}! ${result.creatorCorrect}:${result.opponentCorrect}`;
          }

          const msg = `⚔️ Дуэль #${duel.id} завершена!\n${resultText}`;

          const cId = creator && (creator.chat_id || creator.telegram_id);
          const oId = opponent && (opponent.chat_id || opponent.telegram_id);
          if (cId) { try { await _bot.sendMessage(cId, msg); } catch (e) {} }
          if (oId) { try { await _bot.sendMessage(oId, msg); } catch (e) {} }

          try {
            const alreadyFriends = await db.areFriends(duel.creator_id, duel.opponent_id);
            if (!alreadyFriends) {
              const botName = (await _bot.getMe()).username;
              const friendMsg = '👥 Добавить соперника в друзья?';
              const creatorLink = `https://t.me/${botName}?startapp=friend_${duel.creator_id}`;
              const opponentLink = `https://t.me/${botName}?startapp=friend_${duel.opponent_id}`;
              if (oId) { try { await _bot.sendMessage(oId, friendMsg, { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить в друзья', url: creatorLink }]] } }); } catch (e) {} }
              if (cId) { try { await _bot.sendMessage(cId, friendMsg, { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить в друзья', url: opponentLink }]] } }); } catch (e) {} }
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

function start() {
  console.log('[Scheduler] Started (every 2 min)');

  setInterval(async () => {
    await resolveRounds();
    await resolveDuels();
  }, 120000); // 2 minutes

  setInterval(async () => {
    await weeklyRaffleCheck();
    try { await db.cleanupStaleDuels(); } catch (e) { console.error('[Scheduler] cleanupStaleDuels:', e.message); }
  }, 3600000); // hourly check for raffle + stale duels

  setTimeout(async () => {
    await resolveRounds();
    await resolveDuels();
  }, 10000);
}

module.exports = {
  setBot, start, resolveRounds, resolvePendingRoundsForUser, resolveDuels, weeklyRaffleCheck,
};
