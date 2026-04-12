require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');
const pkg = require('./package.json');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const WEBAPP_URL = process.env.WEBAPP_URL || '';

/** Telegram кэширует Web App по URL — меняй APP_VERSION в .env или version в package.json после деплоя фронта. */
function miniAppOpenUrl() {
  const raw = (WEBAPP_URL || '').trim();
  if (!raw) return '';
  const base = raw.replace(/\/$/, '');
  const tag = encodeURIComponent((process.env.APP_VERSION || pkg.version || '1').toString());
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}tgcb=${tag}`;
}

bot.on('polling_error', (err) => {
  console.error('[Bot] polling_error:', err.code || '', err.message);
});

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  const param = (match[1] || '').trim();

  let ref = null;
  if (param && /^\d+$/.test(param)) ref = param;
  if (param.startsWith('ref_')) ref = param.slice(4);

  let user = await db.getUser(tgUser.id);
  if (!user) {
    user = await db.createUser(tgUser, ref);
  }
  user.chat_id = chatId;
  await db.saveUser(user);

  let appUrl = miniAppOpenUrl();
  let btnText = '🎯 Играть';
  let greeting = `🎯 *Предскажи* — угадай, куда пойдут цены!\n\n` +
    `📈 5 активов — выше или ниже через час?\n` +
    `🎫 Угадай все 5 = билет в розыгрыш\n` +
    `⚔️ Вызывай друзей на дуэли!\n\n` +
    `Нажми кнопку ниже, чтобы играть 👇`;

  // В URL мини-приложения Telegram ожидает GET tgWebAppStartParam (а не startapp) — иначе клиент может обрезать параметр.
  if (param.startsWith('duel_')) {
    const sep = appUrl.includes('?') ? '&' : '?';
    const enc = encodeURIComponent(param);
    appUrl = appUrl + sep + 'tgWebAppStartParam=' + enc + '&startapp=' + enc;
    btnText = '⚔️ Принять дуэль';
    greeting = `⚔️ Тебя вызвали на дуэль!\n\nНажми кнопку ниже, чтобы принять вызов 👇`;
  } else if (param.startsWith('friend_')) {
    const sep = appUrl.includes('?') ? '&' : '?';
    const enc = encodeURIComponent(param);
    appUrl = appUrl + sep + 'tgWebAppStartParam=' + enc + '&startapp=' + enc;
    btnText = '👥 Открыть';
    greeting = `👥 Тебя приглашают в друзья!\n\nНажми кнопку ниже 👇`;
  }

  await bot.sendMessage(chatId, greeting, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: btnText,
        web_app: { url: appUrl }
      }]]
    }
  });
});

bot.onText(/\/profile/, async (msg) => {
  const user = await db.getUser(msg.from.id);
  if (!user) return bot.sendMessage(msg.chat.id, 'Сначала нажми /start');

  const premium = db.isPremiumActive(user) ? '⭐ Premium' : 'Free';
  await bot.sendMessage(msg.chat.id,
    `👤 *Профиль*\n\n` +
    `Раундов: ${user.total_rounds || 0}\n` +
    `5/5: ${user.total_5of5 || 0}\n` +
    `Лучшая серия: ${user.best_streak || 0}\n` +
    `Дуэли: ${user.duel_wins || 0}W / ${user.duel_losses || 0}L\n` +
    `Статус: ${premium}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/premium/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.sendInvoice(
      chatId,
      '⭐ Premium — 1 неделя',
      'Раунд каждый час, безлимит дуэлей, больше шансов на призы!',
      'premium_week',
      '', // provider_token empty for Stars
      'XTR',
      [{ label: 'Premium 1 неделя', amount: 25 }]
    );
  } catch (e) {
    console.error('[Bot] Invoice error:', e.message);
    await bot.sendMessage(chatId, 'Ошибка создания счёта. Попробуй позже.');
  }
});

bot.on('pre_checkout_query', async (query) => {
  try {
    await bot.answerPreCheckoutQuery(query.id, true);
  } catch (e) {
    console.error('[Bot] Pre-checkout error:', e.message);
  }
});

bot.on('successful_payment', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const payload = msg.successful_payment.invoice_payload;

  if (payload === 'premium_week') {
    const user = await db.getUser(userId);
    if (user) {
      const now = new Date();
      const currentEnd = user.premium_until ? new Date(user.premium_until) : now;
      const base = currentEnd > now ? currentEnd : now;
      user.is_premium = true;
      user.premium_until = new Date(base.getTime() + 7 * 24 * 3600000);
      await db.saveUser(user);

      await bot.sendMessage(chatId,
        `✅ Premium активирован до ${user.premium_until.toLocaleDateString('ru-RU')}!\n\n` +
        `• Раунд каждый час\n• Безлимит дуэлей\n• Больше шансов!`
      );
    }
  }
});

bot.onText(/\/duel/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    '⚔️ Дуэли — создай вызов и пригласи друга в мини-приложении.',
    {
      reply_markup: {
        inline_keyboard: [[{
          text: '⚔️ Создать дуэль',
          web_app: { url: miniAppOpenUrl() }
        }]]
      }
    }
  );
});

bot.onText(/\/top/, async (msg) => {
  const base = (WEBAPP_URL || '').replace(/\/$/, '');
  if (!base) {
    return bot.sendMessage(msg.chat.id, '🏆 Открой мини-приложение — вкладка «Топ».');
  }
  const tag = encodeURIComponent((process.env.APP_VERSION || pkg.version || '1').toString());
  const url = `${base}/leaderboard.html?tgcb=${tag}`;
  await bot.sendMessage(msg.chat.id,
    '🏆 *Публичный рейтинг* — топ-50 по идеальным раундам. Ссылку можно переслать друзьям.',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🏆 Открыть топ', url }]] }
    }
  );
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `🎯 *Предскажи — Помощь*\n\n` +
    `*Как играть:*\n` +
    `1. Начни раунд — получи 5 активов\n` +
    `2. Для каждого: цена через час выше или ниже?\n` +
    `3. Через час — результат!\n\n` +
    `*Призы:*\n` +
    `🎫 5/5 = билет в розыгрыш 500⭐\n` +
    `🌟 Первый 5/5 за неделю = Premium 3 дня\n` +
    `⚔️ 2 победы в дуэлях = 1 билет\n\n` +
    `*Команды:*\n` +
    `/start — Запуск\n` +
    `/top — Публичный рейтинг (ссылка)\n` +
    `/premium — Купить Premium (25⭐/нед)\n` +
    `/profile — Статистика\n` +
    `/duel — Дуэли\n` +
    `/help — Помощь`,
    { parse_mode: 'Markdown' }
  );
});

console.log('[Bot] Polling started');

module.exports = bot;
