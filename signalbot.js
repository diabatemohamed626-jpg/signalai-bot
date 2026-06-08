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
  const s20 = c.slice(-20).reduce((a, b) => a + b) / 20;
  const s50 = c.slice(-50).reduce((a, b) => a + b) / 50;
  const bm = s20;
  const bs = Math.sqrt(c.slice(-20).map(x => (x - bm) ** 2).reduce((a, b) => a + b) / 20);
  const avgV = v.slice(-20).reduce((a, b) => a + b) / 20;
  return {
    price: last,
    rsi: rsi.toFixed(1),
    rsiState: rsi < 30 ? "OVERSOLD" : rsi > 70 ? "OVERBOUGHT" : "NEUTRAL",
    macd: (e12 - e26).toFixed(2),
    macdState: e12 > e26 ? "BULLISH" : "BEARISH",
    sma20: s20.toFixed(2), sma50: s50.toFixed(2),
    trend: last > s50 ? "UPTREND" : "DOWNTREND",
    bbUpper: (bm + 2 * bs).toFixed(2),
    bbLower: (bm - 2 * bs).toFixed(2),
    support: Math.min(...l.slice(-20)).toFixed(2),
    resistance: Math.max(...h.slice(-20)).toFixed(2),
    volume: v[v.length-1] > avgV*1.2 ? "HIGH" : v[v.length-1] < avgV*0.8 ? "LOW" : "NORMAL",
  };
}

const SYMBOLS = {
  BTC: "BTC-USDT", ETH: "ETH-USDT", SOL: "SOL-USDT",
  BNB: "BNB-USDT", XRP: "XRP-USDT", DOGE: "DOGE-USDT", ADA: "ADA-USDT",
};

// KuCoin — no geo restrictions
async function fetchSignal(symbol, tf) {
  console.log(`Fetching candles for ${symbol} ${tf}`);
  const tfMap = { "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "2h": "2hour", "4h": "4hour", "6h": "6hour", "8h": "8hour", "12h": "12hour", "1d": "1day", "3d": "3day", "1w": "1week" };
  const kucoinTf = tfMap[tf] || "1hour";
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${kucoinTf}&symbol=${symbol}&limit=100`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("KuCoin error " + r.status);
  const json = await r.json();
  if (!json.data || !json.data.length) throw new Error("No candle data");
  // KuCoin: [time, open, close, high, low, volume] newest first — reverse and remap to [t,o,h,l,c,v]
  const klines = json.data.reverse().map(k => [k[0], k[1], k[3], k[4], k[2], k[5]]);
  console.log(`Got ${klines.length} candles`);
  return getIndicators(klines);
}

async function getAISignal(coin, tf, ind) {
  console.log("Calling Groq AI...");
  const prompt = `You are a professional crypto trader. Analyse ${coin}/USDT on the ${tf} timeframe.
Indicators:
- Price: $${ind.price.toLocaleString()}
- RSI(14): ${ind.rsi} (${ind.rsiState})
- MACD: ${ind.macd} (${ind.macdState})
- SMA20: $${ind.sma20} | SMA50: $${ind.sma50} → ${ind.trend}
- Bollinger Bands: $${ind.bbLower} – $${ind.bbUpper}
- Support: $${ind.support} | Resistance: $${ind.resistance}
- Volume: ${ind.volume}
Reply with ONLY raw JSON no markdown:
{"signal":"BUY","confidence":72,"entry":"${ind.price.toFixed(0)}","stopLoss":"price","takeProfit1":"price","takeProfit2":"price","reasoning":"2-3 sentences","risk":"MEDIUM","timeToHold":"duration"}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400, temperature: 0.3,
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
  return `${emoji} *${sig.signal}* — ${coin}/USDT ${tf.toUpperCase()}

💰 *Price:* $${parseFloat(ind.price).toLocaleString()}
⚡ *Confidence:* ${sig.confidence}%
${riskEmoji} *Risk:* ${sig.risk} | ⏱ *Hold:* ${sig.timeToHold}

📍 *Entry:* $${sig.entry}
🛑 *Stop Loss:* $${sig.stopLoss}
🎯 *TP1:* $${sig.takeProfit1}
🎯 *TP2:* $${sig.takeProfit2}

📊 *Analysis:*
${sig.reasoning}

📈 *Indicators:*
• RSI: ${ind.rsi} (${ind.rsiState})
• MACD: ${ind.macd} (${ind.macdState})
• Trend: ${ind.trend}
• Support: $${ind.support} | Resistance: $${ind.resistance}
• Volume: ${ind.volume}

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

const HELP = `🤖 *SignalAI Bot*

Send a message like:
• \`BTC 1h\` — Bitcoin 1 hour signal
• \`ETH 4h\` — Ethereum 4 hour signal
• \`SOL 15m\` — Solana 15 min signal

*Supported coins:* BTC, ETH, SOL, BNB, XRP, DOGE, ADA
*Timeframes:* 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w`;

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
      const coin = parts[0];
      const tf = (parts[1] || "1H").toLowerCase();

      if (!SYMBOLS[coin]) {
        await sendMessage(chatId, `❌ Unknown coin: *${coin}*\n\nSupported: BTC, ETH, SOL, BNB, XRP, DOGE, ADA`);
        continue;
      }
      if (!["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w"].includes(tf)) {
        await sendMessage(chatId, `❌ Unknown timeframe: *${tf}*\n\nSupported: 15m, 1h, 4h, 1d`);
        continue;
      }

      await sendTyping(chatId);
      await sendMessage(chatId, `⏳ Fetching ${coin} ${tf.toUpperCase()} signal...`);

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
