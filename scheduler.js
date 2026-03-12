const db = require('./database');

const HOUR = 60 * 60 * 1000;

let _bot = null;
function setBot(botInstance) { _bot = botInstance; }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getBtcPrice() {
  const data = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
  return Math.round(data.bitcoin.usd);
}

async function getUsdRub() {
  const data = await fetchJSON('https://open.er-api.com/v6/latest/USD');
  return Math.round(data.rates.RUB * 100) / 100;
}

async function getMoscowWeather() {
  const data = await fetchJSON('https://wttr.in/Moscow?format=j1');
  const tomorrow = data.weather?.[1];
  if (!tomorrow) throw new Error('No forecast data');
  const avgTemp = Math.round((parseInt(tomorrow.maxtempC) + parseInt(tomorrow.mintempC)) / 2);
  const maxTemp = parseInt(tomorrow.maxtempC);
  const totalChanceOfRain = tomorrow.hourly.reduce((sum, h) => sum + parseInt(h.chanceofrain || 0), 0) / tomorrow.hourly.length;
  const totalChanceOfSnow = tomorrow.hourly.reduce((sum, h) => sum + parseInt(h.chanceofsnow || 0), 0) / tomorrow.hourly.length;
  return { avgTemp, maxTemp, chanceOfRain: Math.round(totalChanceOfRain), chanceOfSnow: Math.round(totalChanceOfSnow) };
}

async function getFearGreedIndex() {
  const data = await fetchJSON('https://api.alternative.me/fng/?limit=1');
  return parseInt(data.data[0].value);
}

function getCheckTime(hourMSK) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setUTCHours(hourMSK - 3, 0, 0, 0);
  return tomorrow.toISOString();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Pool of fun questions — rotates daily, admin resolves
const FUN_POOL = [
  // Спорт — с ничьей
  { text: '⚽ Лига Чемпионов: чья возьмёт в ближайшем топ-матче?', option_a: 'Победа фаворита', option_b: 'Сенсация — андердог', option_c: 'Ничья', category: 'sport' },
  { text: '🏀 NBA сегодня: победит команда с лучшим рейтингом?', option_a: 'Да, фаворит возьмёт', option_b: 'Нет, апсет!', option_c: 'Разница меньше 3 очков', category: 'sport' },
  { text: '⚽ Сколько голов будет в топ-матче сегодня?', option_a: '3 и больше — голевая феерия', option_b: '0–1 — скука', option_c: 'Ровно 2', category: 'sport' },
  { text: '🥊 UFC/бокс: как закончится ближайший топ-бой?', option_a: 'Нокаут/сабмишн', option_b: 'Решение судей', option_c: 'Ничья или техническая остановка', category: 'sport' },
  { text: '🏎 Формула 1: кто выиграет ближайшую квалификацию?', option_a: 'Red Bull / Ферстаппен', option_b: 'Ferrari / McLaren', option_c: 'Другая команда — сюрприз', category: 'sport' },
  { text: '🎾 Кто победит в ближайшем теннисном финале?', option_a: 'Сеяный выше', option_b: 'Сеяный ниже', option_c: 'Матч перенесут / не состоится', category: 'sport' },

  // Кино и сериалы
  { text: '🎬 Какой фильм будет #1 в прокате на этих выходных?', option_a: 'Сиквел / франшиза', option_b: 'Оригинальный фильм', option_c: 'Анимация / мультфильм', category: 'movies' },
  { text: '📺 Рейтинг нового эпизода топ-сериала на IMDb?', option_a: 'Выше 8.5 — шедевр', option_b: 'Ниже 7.0 — провал', option_c: '7.0–8.5 — норм', category: 'movies' },
  { text: '🍿 Выйдет ли сегодня трейлер, который взорвёт интернет (1M+ за сутки)?', option_a: 'Да, хайп обеспечен', option_b: 'Нет, тишина', option_c: 'Выйдет, но не наберёт 1M', category: 'movies' },

  // Музыка
  { text: '🎵 Кто сейчас #1 в мировом Spotify — поп или хип-хоп?', option_a: 'Поп', option_b: 'Хип-хоп / рэп', option_c: 'Другой жанр (латино, рок, электро)', category: 'music' },
  { text: '🎤 Новый трек от топ-артиста наберёт 10M+ прослушиваний за первый день?', option_a: 'Легко наберёт', option_b: 'Не дотянет', option_c: 'Не будет релизов от топов', category: 'music' },

  // Технологии и ИИ
  { text: '🤖 Новость про ИИ попадёт в мировой топ-3 сегодня?', option_a: 'Да, ИИ на первых полосах', option_b: 'Нет, другие темы главнее', option_c: 'Попадёт, но не в топ-3', category: 'tech' },
  { text: '📱 Apple, Google или Samsung — кто первый анонсирует что-то новое?', option_a: 'Apple', option_b: 'Google', option_c: 'Samsung или кто-то ещё', category: 'tech' },
  { text: '🚀 SpaceX: будет ли запуск на этой неделе?', option_a: 'Да, успешный', option_b: 'Нет, не на этой неделе', option_c: 'Запуск будет, но перенесут', category: 'tech' },
  { text: '🎮 Какая платформа доминирует в игровых чартах сейчас?', option_a: 'PlayStation', option_b: 'PC / Steam', option_c: 'Nintendo / Xbox', category: 'tech' },

  // Крипто и финансы
  { text: '🐕 Dogecoin за сегодня:', option_a: 'Рост больше 3%', option_b: 'Падение больше 3%', option_c: 'Боковик (±3%)', category: 'crypto' },
  { text: '📊 S&P 500 сегодня закроется:', option_a: 'В плюсе — зелёный день', option_b: 'В минусе — красный день', option_c: 'Почти без изменений (±0.2%)', category: 'finance' },
  { text: '⚡ Акции Tesla сегодня:', option_a: 'Вырастут больше 2%', option_b: 'Упадут больше 2%', option_c: 'Останутся в коридоре ±2%', category: 'finance' },
  { text: '💎 Ethereum за сегодня:', option_a: 'Обгонит Bitcoin по росту', option_b: 'Отстанет от Bitcoin', option_c: 'Примерно одинаково', category: 'crypto' },

  // Развлечения и тренды
  { text: '🔥 Самый залайканный пост в X (Twitter) сегодня будет от:', option_a: 'Илон Маск', option_b: 'Другая знаменитость', option_c: 'Обычный пользователь / мем', category: 'entertainment' },
  { text: '🎪 Родится ли сегодня новый вирусный мем?', option_a: 'Да, интернет доставит', option_b: 'Нет, день без мемов', option_c: 'Вернётся старый мем', category: 'entertainment' },
  { text: '📲 Какое приложение будет #1 по скачиваниям сегодня?', option_a: 'Соцсеть (TikTok, Instagram...)', option_b: 'Игра', option_c: 'Утилита или ИИ-сервис', category: 'entertainment' },
  { text: '🎰 Что сегодня будет трендить в TikTok?', option_a: 'Танцевальный челлендж', option_b: 'Лайфхак / рецепт', option_c: 'Мем / юмор / скетч', category: 'entertainment' },

  // Мир и общество
  { text: '🌍 Главная мировая новость сегодня будет про:', option_a: 'Политику / экономику', option_b: 'Технологии / науку', option_c: 'Спорт / культуру / другое', category: 'general' },
  { text: '👑 Кто-то из мировых лидеров сделает громкое заявление сегодня?', option_a: 'Да, резонансное', option_b: 'Нет, тихий день', option_c: 'Заявление будет, но не громкое', category: 'general' },
  { text: '🌡 Какая погода завтра в большинстве городов-миллионников РФ?', option_a: 'Теплее нормы', option_b: 'Холоднее нормы', option_c: 'Около нормы', category: 'general' },
  { text: '☕ Сколько человек проголосует на этот вопрос?', option_a: 'Больше 50', option_b: 'Меньше 10', option_c: 'От 10 до 50', category: 'general' },

  // Метавопросы
  { text: '🎯 Какой процент игроков угадает этот вопрос?', option_a: 'Больше 60% — лёгкий вопрос', option_b: 'Меньше 30% — ловушка', option_c: 'От 30% до 60% — фифти-фифти', category: 'general' },
  { text: '🔮 Большинство выберет вариант A на этот вопрос?', option_a: 'Да, A самый популярный', option_b: 'Нет, B выберут чаще', option_c: 'C — тёмная лошадка', category: 'general' },
];

function getDayIndex(dateStr) {
  const d = new Date(dateStr);
  return Math.floor(d.getTime() / (24 * 60 * 60 * 1000));
}

async function generateDailyQuestions() {
  console.log('[Scheduler] Generating daily questions...');
  const today = new Date().toISOString().slice(0, 10);
  let generated = 0;

  if (await db.hasAutoQuestionsForDate(today)) {
    console.log('[Scheduler] Questions already generated for today, skipping.');
    return 0;
  }

  // 1. Bitcoin
  try {
    const btcPrice = await getBtcPrice();
    const threshold = Math.round(btcPrice / 100) * 100;
    const margin = Math.round(threshold * 0.01);
    await db.addQuestion({
      text: `Bitcoin завтра к 18:00 МСК? (сейчас ~$${threshold.toLocaleString('en-US')})`,
      option_a: `Рост — выше $${(threshold + margin).toLocaleString('en-US')}`,
      option_b: `Падение — ниже $${(threshold - margin).toLocaleString('en-US')}`,
      option_c: `Стоит на месте (±$${margin})`,
      category: 'crypto', timeframe: 'tomorrow',
      autoCheck: { type: 'crypto_price_3way', coin: 'bitcoin', threshold, margin, generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] BTC ($${threshold} ±${margin})`);
  } catch (e) { console.error('  [!] BTC failed:', e.message); }
  await sleep(1500);

  // 2. USD/RUB
  try {
    const usdRub = await getUsdRub();
    const threshold = Math.round(usdRub);
    const margin = 0.5;
    await db.addQuestion({
      text: `Доллар завтра: дороже или дешевле? (сейчас ~${threshold}₽)`,
      option_a: `Подорожает — выше ${threshold + margin}₽`,
      option_b: `Подешевеет — ниже ${threshold - margin}₽`,
      option_c: `Не изменится (±${margin}₽)`,
      category: 'finance', timeframe: 'tomorrow',
      autoCheck: { type: 'currency_3way', pair: 'USD_RUB', threshold, margin, generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] USD/RUB (${threshold}₽ ±${margin})`);
  } catch (e) { console.error('  [!] USD/RUB failed:', e.message); }
  await sleep(1500);

  // 3. Moscow weather — temperature
  try {
    const weather = await getMoscowWeather();
    const temp = weather.avgTemp;
    const margin = 2;
    await db.addQuestion({
      text: `Какая погода будет завтра в Москве? (прогноз ~${temp}°C)`,
      option_a: `Теплее ${temp + margin}°C`,
      option_b: `Холоднее ${temp - margin}°C`,
      option_c: `Примерно ${temp}°C (±${margin}°)`,
      category: 'general', timeframe: 'tomorrow',
      autoCheck: { type: 'weather_temp', city: 'Moscow', threshold: temp, margin, generated_date: today, check_after: getCheckTime(20) }
    });
    generated++;
    console.log(`  [+] Weather temp Moscow (${temp}°C ±${margin})`);
  } catch (e) { console.error('  [!] Weather temp failed:', e.message); }
  await sleep(1500);

  // 4. Moscow weather — rain/snow
  try {
    const weather = await getMoscowWeather();
    const month = new Date().getMonth();
    const isWinter = month <= 2 || month >= 10;
    const precipChance = isWinter ? weather.chanceOfSnow : weather.chanceOfRain;
    const precipWord = isWinter ? 'снег' : 'дождь';
    const precipEmoji = isWinter ? '❄️' : '🌧';
    await db.addQuestion({
      text: `${precipEmoji} Будет ли завтра ${precipWord} в Москве? (вероятность ${precipChance}%)`,
      option_a: `Да, будет ${precipWord}`,
      option_b: `Нет, сухо`,
      category: 'general', timeframe: 'tomorrow',
      autoCheck: { type: 'weather_precip', city: 'Moscow', isWinter, generated_date: today, check_after: getCheckTime(21) }
    });
    generated++;
    console.log(`  [+] Weather precip Moscow (${precipWord} ${precipChance}%)`);
  } catch (e) { console.error('  [!] Weather precip failed:', e.message); }
  await sleep(1500);

  // 5. Fear & Greed Index
  try {
    const fgi = await getFearGreedIndex();
    await db.addQuestion({
      text: `Рынок завтра: жадность или страх? (сейчас индекс ${fgi}/100)`,
      option_a: fgi >= 50 ? 'Ещё жаднее — выше ' + Math.min(fgi + 5, 100) : 'Жадность — выше 50',
      option_b: fgi < 50 ? 'Ещё страшнее — ниже ' + Math.max(fgi - 5, 0) : 'Страх — ниже 50',
      option_c: `Примерно так же (~${fgi})`,
      category: 'finance', timeframe: 'tomorrow',
      autoCheck: { type: 'fear_greed', threshold: fgi, generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] Fear & Greed (${fgi})`);
  } catch (e) { console.error('  [!] Fear & Greed failed:', e.message); }
  await sleep(1500);

  // 6. Fun question from pool
  try {
    const dayIdx = getDayIndex(today);
    const poolQ = FUN_POOL[dayIdx % FUN_POOL.length];
    await db.addQuestion({
      text: poolQ.text,
      option_a: poolQ.option_a,
      option_b: poolQ.option_b,
      option_c: poolQ.option_c || null,
      category: poolQ.category || 'general',
      timeframe: 'tomorrow',
    });
    generated++;
    console.log(`  [+] Fun: "${poolQ.text.slice(0, 50)}..."`);
  } catch (e) { console.error('  [!] Fun question failed:', e.message); }

  if (generated > 0) console.log(`[Scheduler] Generated ${generated} questions for ${today}`);
  return generated;
}

async function autoResolveQuestions() {
  console.log('[Scheduler] Checking questions to resolve...');
  const now = Date.now();
  let resolved = 0;

  const pendingQuestions = await db.getAutoCheckPending();

  for (const q of pendingQuestions) {
    const ac = q.auto_check;
    if (!ac) continue;
    const checkTime = new Date(ac.check_after).getTime();
    if (now < checkTime) continue;

    try {
      let currentValue, correctAnswer;
      switch (ac.type) {
        case 'crypto_price': {
          const priceData = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ac.coin}&vs_currencies=usd`);
          currentValue = priceData[ac.coin].usd;
          correctAnswer = currentValue > ac.threshold ? 'a' : 'b';
          console.log(`  [?] ${ac.coin}: $${currentValue} vs $${ac.threshold} → ${correctAnswer}`);
          break;
        }
        case 'crypto_price_3way': {
          const priceData = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ac.coin}&vs_currencies=usd`);
          currentValue = priceData[ac.coin].usd;
          const upper = ac.threshold + ac.margin;
          const lower = ac.threshold - ac.margin;
          correctAnswer = currentValue > upper ? 'a' : currentValue < lower ? 'b' : 'c';
          console.log(`  [?] ${ac.coin}: $${currentValue} | $${lower}-$${upper} → ${correctAnswer}`);
          break;
        }
        case 'currency': {
          const rateData = await fetchJSON('https://open.er-api.com/v6/latest/USD');
          currentValue = rateData.rates.RUB;
          correctAnswer = currentValue > ac.threshold ? 'a' : 'b';
          console.log(`  [?] USD/RUB: ${currentValue.toFixed(2)} vs ${ac.threshold} → ${correctAnswer}`);
          break;
        }
        case 'currency_3way': {
          const rateData = await fetchJSON('https://open.er-api.com/v6/latest/USD');
          currentValue = rateData.rates.RUB;
          const upper = ac.threshold + ac.margin;
          const lower = ac.threshold - ac.margin;
          correctAnswer = currentValue > upper ? 'a' : currentValue < lower ? 'b' : 'c';
          console.log(`  [?] USD/RUB: ${currentValue.toFixed(2)} | ${lower}-${upper} → ${correctAnswer}`);
          break;
        }
        case 'weather_temp': {
          const data = await fetchJSON(`https://wttr.in/${ac.city}?format=j1`);
          const todayW = data.weather?.[0];
          currentValue = Math.round((parseInt(todayW.maxtempC) + parseInt(todayW.mintempC)) / 2);
          const upper = ac.threshold + ac.margin;
          const lower = ac.threshold - ac.margin;
          correctAnswer = currentValue > upper ? 'a' : currentValue < lower ? 'b' : 'c';
          console.log(`  [?] ${ac.city} temp: ${currentValue}°C | ${lower}-${upper} → ${correctAnswer}`);
          break;
        }
        case 'weather_precip': {
          const data = await fetchJSON(`https://wttr.in/${ac.city}?format=j1`);
          const todayW = data.weather?.[0];
          const avgRain = todayW.hourly.reduce((s, h) => s + parseInt(h.chanceofrain || 0), 0) / todayW.hourly.length;
          const avgSnow = todayW.hourly.reduce((s, h) => s + parseInt(h.chanceofsnow || 0), 0) / todayW.hourly.length;
          const hadPrecip = ac.isWinter ? avgSnow > 40 : avgRain > 40;
          correctAnswer = hadPrecip ? 'a' : 'b';
          console.log(`  [?] ${ac.city} precip: rain=${avgRain.toFixed(0)}% snow=${avgSnow.toFixed(0)}% → ${correctAnswer}`);
          break;
        }
        case 'fear_greed': {
          const fgiData = await fetchJSON('https://api.alternative.me/fng/?limit=1');
          currentValue = parseInt(fgiData.data[0].value);
          const diff = currentValue - ac.threshold;
          correctAnswer = diff > 5 ? 'a' : diff < -5 ? 'b' : 'c';
          console.log(`  [?] FGI: ${currentValue} vs ${ac.threshold} (diff ${diff}) → ${correctAnswer}`);
          break;
        }
        default: continue;
      }
      const result = await db.resolveQuestion(q.id, correctAnswer);
      const answerLabel = correctAnswer === 'a' ? q.option_a : correctAnswer === 'b' ? q.option_b : q.option_c;
      if (result.ok) {
        console.log(`  [OK] Q${q.id}: "${q.text.slice(0, 40)}..." → ${answerLabel} | ${result.winnersCount}/${result.totalPredictions} winners`);
        resolved++;
        await notifyUsersAboutResult(q, correctAnswer, answerLabel, result);
        if (q.is_featured) {
          const preds = await db.getPredictionsForQuestion(q.id);
          for (const p of preds) {
            if (p.answer === correctAnswer) await db.grantAchievement(p.user_id, 'featured_correct');
          }
        }
      }
    } catch (e) { console.error(`  [!] Failed to resolve Q${q.id}:`, e.message); }
    await sleep(1500);
  }

  console.log(resolved > 0 ? `[Scheduler] Resolved ${resolved} questions` : '[Scheduler] No questions ready to resolve');
  return resolved;
}

async function generateWeeklyQuestions() {
  const today = new Date();
  if (today.getDay() !== 1) return 0;
  const weekKey = today.toISOString().slice(0, 10);
  if (await db.hasAutoQuestionsForDate(weekKey)) return 0;

  console.log('[Scheduler] Generating weekly questions...');
  let generated = 0;
  const friday = new Date(today); friday.setDate(friday.getDate() + 4); friday.setHours(18, 0, 0, 0);

  try {
    const btcPrice = await getBtcPrice();
    const rounded = Math.round(btcPrice / 1000) * 1000;
    const margin = Math.round(rounded * 0.03);
    await db.addQuestion({
      text: `Bitcoin к пятнице 18:00? (сейчас ~$${rounded.toLocaleString('en-US')})`,
      option_a: `Рост — выше $${(rounded + margin).toLocaleString('en-US')}`,
      option_b: `Падение — ниже $${(rounded - margin).toLocaleString('en-US')}`,
      option_c: `На месте (±$${margin.toLocaleString('en-US')})`,
      category: 'crypto', timeframe: 'week',
      autoCheck: { type: 'crypto_price_3way', coin: 'bitcoin', threshold: rounded, margin, generated_date: weekKey, check_after: friday.toISOString() }
    });
    generated++;
  } catch (e) { console.error('  [!] Weekly BTC failed:', e.message); }

  try {
    const usdRub = await getUsdRub();
    const rounded = Math.round(usdRub);
    const margin = 1;
    await db.addQuestion({
      text: `Курс доллара к пятнице? (сейчас ~${rounded}₽)`,
      option_a: `Подорожает — выше ${rounded + margin}₽`,
      option_b: `Подешевеет — ниже ${rounded - margin}₽`,
      option_c: `Не изменится (±${margin}₽)`,
      category: 'finance', timeframe: 'week',
      autoCheck: { type: 'currency_3way', pair: 'USD_RUB', threshold: rounded, margin, generated_date: weekKey, check_after: friday.toISOString() }
    });
    generated++;
  } catch (e) { console.error('  [!] Weekly USD/RUB failed:', e.message); }

  // Weekly fun question from pool (offset by half the pool to not repeat daily ones)
  try {
    const dayIdx = getDayIndex(weekKey);
    const poolQ = FUN_POOL[(dayIdx + Math.floor(FUN_POOL.length / 2)) % FUN_POOL.length];
    await db.addQuestion({
      text: poolQ.text.replace('сегодня', 'на этой неделе').replace('завтра', 'на этой неделе'),
      option_a: poolQ.option_a, option_b: poolQ.option_b, option_c: poolQ.option_c || null,
      category: poolQ.category || 'general', timeframe: 'week',
    });
    generated++;
  } catch (e) { console.error('  [!] Weekly fun failed:', e.message); }

  if (generated > 0) console.log(`[Scheduler] Generated ${generated} weekly questions`);
  return generated;
}

async function runCycle() {
  try {
    await generateDailyQuestions();
    await sleep(2000);
    await generateWeeklyQuestions();
    await sleep(2000);
    await markFeaturedQuestion();
    await sleep(1000);
    await autoResolveQuestions();
    await sleep(2000);
    await sendWeeklySummary();
  } catch (e) { console.error('[Scheduler] Cycle error:', e.message); }
}

async function notifyUsersAboutResult(question, correctAnswer, answerLabel, result) {
  if (!_bot) return;
  try {
    const preds = await db.getPredictionsForQuestion(question.id);
    for (const p of preds) {
      const user = await db.getUser(p.user_id);
      if (!user || !user.chat_id || !user.notifications) continue;
      const isCorrect = p.answer === correctAnswer;
      const emoji = isCorrect ? '🎉' : '😔';
      const points = isCorrect ? '+25' : '+5';
      const msg = `${emoji} *Результат:* ${question.text.slice(0, 80)}\n\n` +
        `✅ Ответ: *${answerLabel}*\n` +
        `${isCorrect ? '🎯 Ты угадал!' : '❌ В этот раз мимо'} (${points} очков)\n` +
        `📊 Угадали: ${result.winnersCount} из ${result.totalPredictions}`;
      try { await _bot.sendMessage(user.chat_id, msg, { parse_mode: 'Markdown' }); } catch (e) { /* user blocked bot */ }
      await sleep(100);
    }
  } catch (e) { console.error('[Notify] Error:', e.message); }
}

async function sendWeeklySummary() {
  if (!_bot) return;
  const today = new Date();
  if (today.getDay() !== 0) return;
  console.log('[Scheduler] Sending weekly summaries...');
  try {
    const users = await db.getAllUsers();
    let sent = 0;
    for (const u of users) {
      if (!u.chat_id || !u.notifications) continue;
      const stats = await db.getWeeklyStats(u.telegram_id);
      if (parseInt(stats.total) === 0) continue;
      const accuracy = parseInt(stats.total) > 0 ? Math.round(parseInt(stats.correct) / parseInt(stats.total) * 100) : 0;
      const rank = await db.getUserRank(u.score);
      const msg = `📊 *Твоя неделя в «Предскажи»*\n\n` +
        `📝 Прогнозов: ${stats.total}\n` +
        `🎯 Угадано: ${stats.correct} (${accuracy}%)\n` +
        `⚡ Заработано: +${stats.points} очков\n` +
        `🔥 Серия дней: ${u.daily_streak || 0}\n` +
        `🏆 Рейтинг: #${rank}\n\n` +
        `Новая неделя — новые прогнозы! 💪`;
      try { await _bot.sendMessage(u.chat_id, msg, { parse_mode: 'Markdown' }); sent++; } catch (e) { /* blocked */ }
      await sleep(200);
    }
    console.log(`[Scheduler] Sent ${sent} weekly summaries`);
  } catch (e) { console.error('[Scheduler] Weekly summary error:', e.message); }
}

async function markFeaturedQuestion() {
  try {
    await db.pool.query('UPDATE questions SET is_featured = false WHERE is_featured = true');
    const { rows } = await db.pool.query(`
      SELECT id FROM questions WHERE is_active = true AND resolved = false
      ORDER BY RANDOM() LIMIT 1
    `);
    if (rows.length > 0) {
      await db.pool.query('UPDATE questions SET is_featured = true WHERE id = $1', [rows[0].id]);
      console.log(`[Scheduler] Featured question: Q${rows[0].id}`);
    }
  } catch (e) { console.error('[Scheduler] Featured question error:', e.message); }
}

function start() {
  console.log('[Scheduler] Started. Checking every 2 hours.');
  setTimeout(() => runCycle(), 5000);
  setInterval(() => runCycle(), 2 * HOUR);
}

async function runOnce() {
  console.log('[Scheduler] Running single cycle...');
  await runCycle();
  console.log('[Scheduler] Done.');
}

module.exports = { start, runOnce, setBot, generateDailyQuestions, autoResolveQuestions, generateWeeklyQuestions, sendWeeklySummary, markFeaturedQuestion };
