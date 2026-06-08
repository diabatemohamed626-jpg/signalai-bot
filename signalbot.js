import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

console.log("Bot starting...");
console.log("Telegram token set:", !!TELEGRAM_TOKEN);
console.log("Groq key set:", !!GROQ_API_KEY);

function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l += Math.abs(d));
  }
  return 100 - 100 / (1 + (g / p) / ((l / p) || 0.0001));
}
function calcEMA(arr, p) {
  const k = 2 / (p + 1);
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
  return v;
}
function getIndicators(klines) {
  const c = klines.map(k => +k[4]);
  const h = klines.map(k => +k[2]);
  const l = klines.map(k => +k[3]);
  const v = klines.map(k => +k[5]);
  const last = c[c.length - 1];
  const rsi = calcRSI(c);
  const e12 = calcEMA(c, 12), e26 = calcEMA(c, 26);
  const e9 = calcEMA(c, 9);
  const s20 = c.slice(-20).reduce((a, b) => a + b) / 20;
  const s50 = c.slice(-50).reduce((a, b) => a + b) / 50;
  const s200 = c.slice(-Math.min(200, c.length)).reduce((a, b) => a + b) / Math.min(200, c.length);
  const bm = s20;
  const bs = Math.sqrt(c.slice(-20).map(x => (x - bm) ** 2).reduce((a, b) => a + b) / 20);
  const avgV = v.slice(-20).reduce((a, b) => a + b) / 20;

  // Stochastic RSI
  const rsiValues = [];
  for (let i = 14; i < c.length; i++) {
    const slice = c.slice(i - 14, i);
    let g = 0, lo = 0;
    for (let j = 1; j < slice.length; j++) {
      const d = slice[j] - slice[j-1];
      d > 0 ? g += d : lo += Math.abs(d);
    }
    rsiValues.push(100 - 100 / (1 + (g/14) / ((lo/14) || 0.0001)));
  }
  const rsiSlice = rsiValues.slice(-14);
  const rsiMin = Math.min(...rsiSlice);
  const rsiMax = Math.max(...rsiSlice);
  const stochRSI = rsiMax === rsiMin ? 50 : ((rsiValues[rsiValues.length-1] - rsiMin) / (rsiMax - rsiMin)) * 100;

  // ATR for stop loss calculation
  const trueRanges = [];
  for (let i = 1; i < klines.length; i++) {
    const high = h[i], low = l[i], prevClose = c[i-1];
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const atr = trueRanges.slice(-14).reduce((a, b) => a + b) / 14;

  // Candle pattern detection
  const lastCandle = { o: +klines[klines.length-1][1], h: h[h.length-1], l: l[l.length-1], c: last };
  const prevCandle = { o: +klines[klines.length-2][1], h: h[h.length-2], l: l[l.length-2], c: c[c.length-2] };
  const bullishEngulfing = lastCandle.c > lastCandle.o && prevCandle.c < prevCandle.o && lastCandle.o < prevCandle.c && lastCandle.c > prevCandle.o;
  const bearishEngulfing = lastCandle.c < lastCandle.o && prevCandle.c > prevCandle.o && lastCandle.o > prevCandle.c && lastCandle.c < prevCandle.o;
  const hammer = (lastCandle.h - Math.max(lastCandle.o, lastCandle.c)) < (Math.abs(lastCandle.o - lastCandle.c) * 0.3) && (Math.min(lastCandle.o, lastCandle.c) - lastCandle.l) > (Math.abs(lastCandle.o - lastCandle.c) * 2);
  const doji = Math.abs(lastCandle.o - lastCandle.c) < (lastCandle.h - lastCandle.l) * 0.1;

  const patterns = [];
  if (bullishEngulfing) patterns.push("Bullish Engulfing");
  if (bearishEngulfing) patterns.push("Bearish Engulfing");
  if (hammer) patterns.push("Hammer");
  if (doji) patterns.push("Doji");

  return {
    price: last,
    rsi: rsi.toFixed(1),
    rsiState: rsi < 30 ? "OVERSOLD" : rsi > 70 ? "OVERBOUGHT" : "NEUTRAL",
    stochRSI: stochRSI.toFixed(1),
    stochState: stochRSI < 20 ? "OVERSOLD" : stochRSI > 80 ? "OVERBOUGHT" : "NEUTRAL",
    macd: (e12 - e26).toFixed(4),
    macdState: e12 > e26 ? "BULLISH" : "BEARISH",
    macdCross: e12 > e26 && calcEMA(c.slice(0,-1), 12) <= calcEMA(c.slice(0,-1), 26) ? "JUST CROSSED BULLISH" : e12 < e26 && calcEMA(c.slice(0,-1), 12) >= calcEMA(c.slice(0,-1), 26) ? "JUST CROSSED BEARISH" : "NO CROSS",
    ema9: e9.toFixed(2),
    sma20: s20.toFixed(2),
    sma50: s50.toFixed(2),
    sma200: s200.toFixed(2),
    trend: last > s50 ? (last > s200 ? "STRONG UPTREND" : "WEAK UPTREND") : (last < s200 ? "STRONG DOWNTREND" : "WEAK DOWNTREND"),
    bbUpper: (bm + 2 * bs).toFixed(2),
    bbMiddle: bm.toFixed(2),
    bbLower: (bm - 2 * bs).toFixed(2),
    bbWidth: ((4 * bs) / bm * 100).toFixed(2),
    atr: atr.toFixed(2),
    support: Math.min(...l.slice(-20)).toFixed(2),
    resistance: Math.max(...h.slice(-20)).toFixed(2),
    volume: v[v.length-1] > avgV*1.5 ? "VERY HIGH" : v[v.length-1] > avgV*1.2 ? "HIGH" : v[v.length-1] < avgV*0.5 ? "VERY LOW" : v[v.length-1] < avgV*0.8 ? "LOW" : "NORMAL",
    patterns: patterns.length ? patterns.join(", ") : "None detected",
  };
}

const SYMBOLS = {
  BTC: "BTC-USDT", ETH: "ETH-USDT", SOL: "SOL-USDT",
  BNB: "BNB-USDT", XRP: "XRP-USDT", DOGE: "DOGE-USDT", ADA: "ADA-USDT",
  AVAX: "AVAX-USDT", MATIC: "MATIC-USDT", LINK: "LINK-USDT",
  DOT: "DOT-USDT", UNI: "UNI-USDT", ATOM: "ATOM-USDT", LTC: "LTC-USDT",
};

async function fetchSignal(symbol, tf) {
  console.log(`Fetching candles for ${symbol} ${tf}`);
  const tfMap = { "1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1hour","2h":"2hour","4h":"4hour","6h":"6hour","8h":"8hour","12h":"12hour","1d":"1day","3d":"3day","1w":"1week" };
  const kucoinTf = tfMap[tf] || "1hour";
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${kucoinTf}&symbol=${symbol}&limit=210`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("KuCoin error " + r.status);
  const json = await r.json();
  if (!json.data || !json.data.length) throw new Error("No candle data");
  const klines = json.data.reverse().map(k => [k[0], k[1], k[3], k[4], k[2], k[5]]);
  console.log(`Got ${klines.length} candles`);
  return getIndicators(klines);
}

async function getAISignal(coin, tf, ind) {
  console.log("Calling Groq AI...");
  const prompt = `You are a master crypto trader with 15 years experience and a 90%+ win rate. You have traded through every major bull and bear market. You are known for:
- Extremely precise entries with minimal slippage
- Tight stop losses that protect capital (never more than 1.5x ATR away from entry)
- High probability setups only — you wait for confluence of multiple signals
- Perfect risk/reward ratios (minimum 1:2, preferring 1:3)
- Reading market structure, order flow and momentum together

Analyse ${coin}/USDT on the ${tf} timeframe with your full expertise.

=== MARKET DATA ===
Price: $${ind.price.toLocaleString()}

MOMENTUM:
- RSI(14): ${ind.rsi} → ${ind.rsiState}
- Stoch RSI: ${ind.stochRSI} → ${ind.stochState}
- MACD: ${ind.macd} → ${ind.macdState} (${ind.macdCross})

TREND:
- EMA9: $${ind.ema9}
- SMA20: $${ind.sma20}
- SMA50: $${ind.sma50}
- SMA200: $${ind.sma200}
- Trend: ${ind.trend}

VOLATILITY:
- ATR(14): $${ind.atr}
- Bollinger Upper: $${ind.bbUpper}
- Bollinger Mid: $${ind.bbMiddle}
- Bollinger Lower: $${ind.bbLower}
- BB Width: ${ind.bbWidth}%

KEY LEVELS:
- Support: $${ind.support}
- Resistance: $${ind.resistance}

VOLUME: ${ind.volume}
CANDLE PATTERNS: ${ind.patterns}

=== YOUR TASK ===
Give your highest conviction signal. If confluence is weak, say NEUTRAL.
Stop loss: place just beyond the nearest structural level, maximum 1.5x ATR from entry.
TP1: minimum 1.5x the risk. TP2: minimum 3x the risk.

Reply with ONLY raw JSON, nothing else:
{"signal":"STRONG_BUY","confidence":85,"entry":"${ind.price.toFixed(2)}","stopLoss":"exactPrice","takeProfit1":"exactPrice","takeProfit2":"exactPrice","reasoning":"Precise explanation of confluence factors and why these exact levels","risk":"LOW","timeToHold":"duration","riskReward":"1:3","keyLevel":"the most important price level to watch"}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600, temperature: 0.2,
    }),
  });
  const text = await r.text();
  console.log("Groq status:", r.status, text.slice(0, 200));
  if (!r.ok) throw new Error("Groq error " + r.status);
  const d = JSON.parse(text);
  const content = d.choices[0].message.content.trim();
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON from AI");
  return JSON.parse(match[0]);
}

function formatSignal(coin, tf, sig, ind) {
  const emoji = { STRONG_BUY:"🟢🟢", BUY:"🟢", NEUTRAL:"⚪️", SELL:"🔴", STRONG_SELL:"🔴🔴" }[sig.signal] || "⚪️";
  const riskEmoji = { LOW:"🟢", MEDIUM:"🟡", HIGH:"🔴" }[sig.risk] || "🟡";
  const confBar = "█".repeat(Math.round(sig.confidence / 10)) + "░".repeat(10 - Math.round(sig.confidence / 10));

  return `${emoji} *${sig.signal}* — ${coin}/USDT ${tf.toUpperCase()}
━━━━━━━━━━━━━━━━━━
💰 *Price:* $${parseFloat(ind.price).toLocaleString()}
⚡ *Confidence:* ${sig.confidence}% ${confBar}
${riskEmoji} *Risk:* ${sig.risk} | ⏱ *Hold:* ${sig.timeToHold}
📐 *Risk/Reward:* ${sig.riskReward || "1:2"}
━━━━━━━━━━━━━━━━━━
📍 *Entry:* $${sig.entry}
🛑 *Stop Loss:* $${sig.stopLoss}
🎯 *TP1:* $${sig.takeProfit1}
🏆 *TP2:* $${sig.takeProfit2}
${sig.keyLevel ? `🔑 *Key Level:* $${sig.keyLevel}` : ""}
━━━━━━━━━━━━━━━━━━
📊 *Master Analysis:*
${sig.reasoning}
━━━━━━━━━━━━━━━━━━
📈 *Indicators:*
• RSI: ${ind.rsi} (${ind.rsiState})
• Stoch RSI: ${ind.stochRSI} (${ind.stochState})
• MACD: ${ind.macdState} ${ind.macdCross !== "NO CROSS" ? "⚠️ " + ind.macdCross : ""}
• Trend: ${ind.trend}
• ATR: $${ind.atr}
• Volume: ${ind.volume}
• Patterns: ${ind.patterns}

_Not financial advice. Always use stop losses._`;
}

async function sendMessage(chatId, text) {
  const r = await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  const d = await r.json();
  if (!d.ok) console.error("Send error:", JSON.stringify(d));
}

async function sendTyping(chatId) {
  await fetch(`${TG}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

const COINS_LIST = Object.keys(SYMBOLS).join(", ");
const HELP = `🤖 *SignalAI — Master Trader Bot*

I analyse markets like a pro with 15 years experience. Send:
• \`BTC 1h\` — Bitcoin 1 hour signal
• \`ETH 4h\` — Ethereum 4 hour signal
• \`SOL 15m\` — Solana 15 min signal

*Supported coins:*
${COINS_LIST}

*All TradingView timeframes:*
1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w

Every signal includes:
✅ Entry, Stop Loss, TP1 & TP2
✅ Risk/Reward ratio
✅ RSI, Stoch RSI, MACD, ATR
✅ Candle pattern detection
✅ Key level to watch`;

let offset = 0;

async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30`);
    if (!r.ok) { console.error("Poll error:", r.status); setTimeout(poll, 3000); return; }
    const data = await r.json();
    if (!data.ok) { console.error("Telegram error:", JSON.stringify(data)); setTimeout(poll, 3000); return; }

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id;
      const text = msg.text.trim().toUpperCase();
      console.log(`Message from ${chatId}: ${text}`);

      if (text === "/START" || text === "/HELP") { await sendMessage(chatId, HELP); continue; }

      const parts = text.split(/\s+/);
      const coin = parts[0].replace("/USDT","").replace("-USDT","");
      const tf = (parts[1] || "1H").toLowerCase();

      if (!SYMBOLS[coin]) {
        await sendMessage(chatId, `❌ Unknown coin: *${coin}*\n\nSupported: ${COINS_LIST}`);
        continue;
      }
      const validTFs = ["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w"];
      if (!validTFs.includes(tf)) {
        await sendMessage(chatId, `❌ Unknown timeframe: *${tf}*\n\nSupported: ${validTFs.join(", ")}`);
        continue;
      }

      await sendTyping(chatId);
      await sendMessage(chatId, `🔍 Analysing ${coin} ${tf.toUpperCase()} with full market data...`);

      try {
        const ind = await fetchSignal(SYMBOLS[coin], tf);
        const sig = await getAISignal(coin, tf, ind);
        await sendMessage(chatId, formatSignal(coin, tf, sig, ind));
      } catch (e) {
        console.error("Signal error:", e.message);
        await sendMessage(chatId, `❌ Error: ${e.message}`);
      }
    }
  } catch (e) { console.error("Poll error:", e.message); }
  setTimeout(poll, 1000);
}

poll();
