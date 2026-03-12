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
    await db.addQuestion({
      text: `Bitcoin будет выше $${threshold.toLocaleString('en-US')} завтра к 18:00 МСК?`,
      option_a: `Да, выше $${threshold.toLocaleString('en-US')}`, option_b: `Нет, ниже`,
      category: 'crypto', timeframe: 'tomorrow',
      autoCheck: { type: 'crypto_price', coin: 'bitcoin', threshold, direction: 'above', generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] BTC question (threshold: $${threshold})`);
  } catch (e) { console.error('  [!] BTC question failed:', e.message); }

  try {
    const ethPrice = await getEthPrice();
    const threshold = Math.round(ethPrice / 10) * 10;
    await db.addQuestion({
      text: `Ethereum будет выше $${threshold.toLocaleString('en-US')} завтра к 18:00 МСК?`,
      option_a: `Да, выше $${threshold.toLocaleString('en-US')}`, option_b: `Нет, ниже`,
      category: 'crypto', timeframe: 'tomorrow',
      autoCheck: { type: 'crypto_price', coin: 'ethereum', threshold, direction: 'above', generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] ETH question (threshold: $${threshold})`);
  } catch (e) { console.error('  [!] ETH question failed:', e.message); }

  try {
    const usdRub = await getUsdRub();
    const threshold = Math.round(usdRub);
    await db.addQuestion({
      text: `Доллар будет дороже ${threshold}₽ завтра?`,
      option_a: `Да, дороже ${threshold}₽`, option_b: `Нет, дешевле`,
      category: 'finance', timeframe: 'tomorrow',
      autoCheck: { type: 'currency', pair: 'USD_RUB', threshold, direction: 'above', generated_date: today, check_after: getCheckTime(18) }
    });
    generated++;
    console.log(`  [+] USD/RUB question (threshold: ${threshold}₽)`);
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
        case 'currency': {
          const rateData = await fetchJSON('https://open.er-api.com/v6/latest/USD');
          currentValue = rateData.rates.RUB;
          correctAnswer = currentValue > ac.threshold ? 'a' : 'b';
          console.log(`  [?] USD/RUB: ${currentValue.toFixed(2)} vs ${ac.threshold} → ${correctAnswer}`);
          break;
        }
        default: continue;
      }
      const result = await db.resolveQuestion(q.id, correctAnswer);
      if (result.ok) {
        console.log(`  [OK] Q${q.id}: "${q.text}" → ${correctAnswer === 'a' ? q.option_a : q.option_b} | ${result.winnersCount}/${result.totalPredictions} winners`);
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
    await db.addQuestion({
      text: `Bitcoin будет выше $${roundedPrice.toLocaleString('en-US')} к пятнице?`,
      option_a: `Да, выше`, option_b: `Нет, ниже`, category: 'crypto', timeframe: 'week',
      autoCheck: { type: 'crypto_price', coin: 'bitcoin', threshold: roundedPrice, direction: 'above', generated_date: weekKey, check_after: friday.toISOString() }
    });
    generated++;
  } catch (e) { console.error('  [!] Weekly BTC failed:', e.message); }

  try {
    const usdRub = await getUsdRub();
    const roundedRate = Math.round(usdRub);
    await db.addQuestion({
      text: `Доллар будет дороже ${roundedRate}₽ к пятнице?`,
      option_a: `Да, дороже`, option_b: `Нет, дешевле`, category: 'finance', timeframe: 'week',
      autoCheck: { type: 'currency', pair: 'USD_RUB', threshold: roundedRate, direction: 'above', generated_date: weekKey, check_after: friday.toISOString() }
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
