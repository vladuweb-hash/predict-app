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

async function getEthPrice() {
  const data = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
  return Math.round(data.ethereum.usd);
}

async function getUsdRub() {
  const data = await fetchJSON('https://open.er-api.com/v6/latest/USD');
  return Math.round(data.rates.RUB * 100) / 100;
}

function getCheckTime(hourMSK) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setUTCHours(hourMSK - 3, 0, 0, 0);
  return tomorrow.toISOString();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateDailyQuestions() {
  console.log('[Scheduler] Generating daily questions...');
  const today = new Date().toISOString().slice(0, 10);
  let generated = 0;

  if (await db.hasAutoQuestionsForDate(today)) {
    console.log('[Scheduler] Questions already generated for today, skipping.');
    return 0;
  }

  try {
    const btcPrice = await getBtcPrice();
    const threshold = Math.round(btcPrice / 100) * 100;
    const margin = Math.round(threshold * 0.01);
    await db.addQuestion({
      text: `Куда двинется Bitcoin завтра к 18:00 МСК? (сейчас ~$${threshold.toLocaleString('en-US')})`,
      option_a: `Выше $${(threshold + margin).toLocaleString('en-US')}`,
      option_b: `Ниже $${(threshold - margin).toLocaleString('en-US')}`,
      option_c: `Примерно так же (±${margin})`,
      category: 'crypto', timeframe: 'tomorrow',
      autoCheck: { type: 'crypto_price_3way', coin: 'bitcoin', threshold, margin, generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] BTC question ($${threshold} ±${margin})`);
  } catch (e) { console.error('  [!] BTC question failed:', e.message); }

  try {
    const ethPrice = await getEthPrice();
    const threshold = Math.round(ethPrice / 10) * 10;
    const margin = Math.round(threshold * 0.01);
    await db.addQuestion({
      text: `Куда двинется Ethereum завтра к 18:00 МСК? (сейчас ~$${threshold.toLocaleString('en-US')})`,
      option_a: `Выше $${(threshold + margin).toLocaleString('en-US')}`,
      option_b: `Ниже $${(threshold - margin).toLocaleString('en-US')}`,
      option_c: `Примерно так же (±${margin})`,
      category: 'crypto', timeframe: 'tomorrow',
      autoCheck: { type: 'crypto_price_3way', coin: 'ethereum', threshold, margin, generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] ETH question ($${threshold} ±${margin})`);
  } catch (e) { console.error('  [!] ETH question failed:', e.message); }

  try {
    const usdRub = await getUsdRub();
    const threshold = Math.round(usdRub);
    const margin = 0.5;
    await db.addQuestion({
      text: `Курс доллара завтра? (сейчас ~${threshold}₽)`,
      option_a: `Дороже ${threshold + margin}₽`,
      option_b: `Дешевле ${threshold - margin}₽`,
      option_c: `Примерно так же (±${margin}₽)`,
      category: 'finance', timeframe: 'tomorrow',
      autoCheck: { type: 'currency_3way', pair: 'USD_RUB', threshold, margin, generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] USD/RUB question (${threshold}₽ ±${margin})`);
  } catch (e) { console.error('  [!] USD/RUB question failed:', e.message); }

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
          console.log(`  [?] ${ac.coin}: $${currentValue} | range $${lower}-$${upper} → ${correctAnswer}`);
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
          console.log(`  [?] USD/RUB: ${currentValue.toFixed(2)} | range ${lower}-${upper} → ${correctAnswer}`);
          break;
        }
        default: continue;
      }
      const result = await db.resolveQuestion(q.id, correctAnswer);
      const answerLabel = correctAnswer === 'a' ? q.option_a : correctAnswer === 'b' ? q.option_b : q.option_c;
      if (result.ok) {
        console.log(`  [OK] Q${q.id}: "${q.text}" → ${answerLabel} | ${result.winnersCount}/${result.totalPredictions} winners`);
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
    const roundedPrice = Math.round(btcPrice / 1000) * 1000;
    const margin = Math.round(roundedPrice * 0.03);
    await db.addQuestion({
      text: `Bitcoin к пятнице 18:00 МСК? (сейчас ~$${roundedPrice.toLocaleString('en-US')})`,
      option_a: `Выше $${(roundedPrice + margin).toLocaleString('en-US')}`,
      option_b: `Ниже $${(roundedPrice - margin).toLocaleString('en-US')}`,
      option_c: `Примерно так же (±$${margin.toLocaleString('en-US')})`,
      category: 'crypto', timeframe: 'week',
      autoCheck: { type: 'crypto_price_3way', coin: 'bitcoin', threshold: roundedPrice, margin, generated_date: weekKey, check_after: friday.toISOString() }
    });
    generated++;
  } catch (e) { console.error('  [!] Weekly BTC failed:', e.message); }

  try {
    const usdRub = await getUsdRub();
    const roundedRate = Math.round(usdRub);
    const margin = 1;
    await db.addQuestion({
      text: `Курс доллара к пятнице? (сейчас ~${roundedRate}₽)`,
      option_a: `Дороже ${roundedRate + margin}₽`,
      option_b: `Дешевле ${roundedRate - margin}₽`,
      option_c: `Примерно так же (±${margin}₽)`,
      category: 'finance', timeframe: 'week',
      autoCheck: { type: 'currency_3way', pair: 'USD_RUB', threshold: roundedRate, margin, generated_date: weekKey, check_after: friday.toISOString() }
    });
    generated++;
  } catch (e) { console.error('  [!] Weekly USD/RUB failed:', e.message); }

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
