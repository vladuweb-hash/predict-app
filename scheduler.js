const db = require('./database');

const HOUR = 60 * 60 * 1000;

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
  { text: '🏟 Будет ли сегодня в мировом футболе матч со счётом 5:0 или крупнее?', option_a: 'Да, будет разгром', option_b: 'Нет, таких не будет', category: 'sport' },
  { text: '🎬 Выйдет ли сегодня трейлер фильма, который наберёт 1M+ просмотров за сутки?', option_a: 'Да, выйдет хит', option_b: 'Нет, не сегодня', category: 'movies' },
  { text: '🚀 SpaceX запустит ракету на этой неделе?', option_a: 'Да, запустят', option_b: 'Нет, не на этой', category: 'tech' },
  { text: '📱 Будет ли сегодня глобальный сбой у крупного сервиса (Google, Meta, X)?', option_a: 'Да, что-то ляжет', option_b: 'Нет, всё будет работать', category: 'tech' },
  { text: '⚽ Забьёт ли кто-то хет-трик в топ-5 лигах Европы сегодня?', option_a: 'Да, будет хет-трик', option_b: 'Нет', category: 'sport' },
  { text: '🎵 Появится ли новый трек в топ-10 Spotify Global сегодня?', option_a: 'Да, будет новинка', option_b: 'Нет, всё те же', category: 'music' },
  { text: '🌋 Произойдёт ли в мире землетрясение > 5.0 баллов сегодня?', option_a: 'Да', option_b: 'Нет', category: 'general' },
  { text: '🏀 NBA: будет ли сегодня игрок с 40+ очками?', option_a: 'Да, кто-то зажжёт', option_b: 'Нет', category: 'sport' },
  { text: '💰 Илон Маск напишет пост в X, который наберёт 1M+ лайков сегодня?', option_a: 'Да, конечно', option_b: 'Нет, не сегодня', category: 'tech' },
  { text: '🎮 Выйдет ли сегодня крупный анонс или релиз в игровой индустрии?', option_a: 'Да, будет новость', option_b: 'Тишина', category: 'tech' },
  { text: '📉 Упадёт ли какая-то криптовалюта из топ-20 на 10%+ за сегодня?', option_a: 'Да, кто-то рухнет', option_b: 'Нет, спокойный день', category: 'crypto' },
  { text: '🏆 Будет ли сегодня мировой рекорд в каком-либо виде спорта?', option_a: 'Да!', option_b: 'Нет', category: 'sport' },
  { text: '☕ Сколько людей проголосует на этот вопрос до конца дня?', option_a: 'Больше 20', option_b: 'Меньше 20', category: 'general' },
  { text: '🎭 Российский фильм попадёт в тренды сегодня?', option_a: 'Да', option_b: 'Нет', category: 'movies' },
  { text: '❄️ Будет ли снег хотя бы в одной столице Европы завтра?', option_a: 'Да', option_b: 'Нет, весна же', category: 'general' },
  { text: '📺 Выйдет ли новый эпизод топ-сериала, о котором все будут говорить?', option_a: 'Да, будет хайп', option_b: 'Нет, тихий день', category: 'movies' },
  { text: '🤖 Новость про ИИ попадёт в топ-3 мировых новостей сегодня?', option_a: 'Да, ИИ опять на первых полосах', option_b: 'Нет, другие темы', category: 'tech' },
  { text: '⚡ Tesla: акции вырастут или упадут сегодня?', option_a: 'Вырастут', option_b: 'Упадут', option_c: 'Почти не изменятся (±1%)', category: 'finance' },
  { text: '🎤 Кто-то из артистов объявит мировой тур сегодня?', option_a: 'Да', option_b: 'Нет', category: 'music' },
  { text: '🐕 Dogecoin вырастет сегодня?', option_a: 'Да, ту зе мун!', option_b: 'Нет, упадёт', option_c: 'Боковик (±2%)', category: 'crypto' },
  { text: '🔥 Какой-то пост в TikTok наберёт 50M+ просмотров за сутки?', option_a: 'Конечно да', option_b: 'Нет, не сегодня', category: 'entertainment' },
  { text: '🏎 Формула 1: будет ли сход лидера на ближайшей гонке?', option_a: 'Да, интрига!', option_b: 'Нет, всё штатно', category: 'sport' },
  { text: '📊 S&P 500 закроется в плюсе сегодня?', option_a: 'Да, зелёный день', option_b: 'Нет, красный', option_c: 'Почти ноль (±0.1%)', category: 'finance' },
  { text: '🎯 Больше людей ответят правильно, чем неправильно на этот вопрос?', option_a: 'Да, большинство угадает', option_b: 'Нет, большинство ошибётся', category: 'general' },
  { text: '🌊 Произойдёт ли природная катастрофа, попавшая в мировые новости, сегодня?', option_a: 'К сожалению, да', option_b: 'Нет, спокойный день', category: 'general' },
  { text: '👑 Кто-то из мировых лидеров сделает громкое заявление сегодня?', option_a: 'Да, будет заявление', option_b: 'Нет, тихий день', category: 'general' },
  { text: '🎪 Появится ли новый вирусный мем сегодня?', option_a: 'Да, интернет не спит', option_b: 'Нет, сегодня без мемов', category: 'entertainment' },
  { text: '🛸 Появится ли новость про НЛО или космос в топ-новостях сегодня?', option_a: 'Да', option_b: 'Нет', category: 'general' },
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
    await autoResolveQuestions();
  } catch (e) { console.error('[Scheduler] Cycle error:', e.message); }
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

module.exports = { start, runOnce, generateDailyQuestions, autoResolveQuestions, generateWeeklyQuestions };
