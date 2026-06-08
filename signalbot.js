import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Indicators ────────────────────────────────────────────────
function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l += Math.abs(d));
  }
  const rs = (g / p) / ((l / p) || 0.0001);
  return 100 - 100 / (1 + rs);
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
    volume: v[v.length - 1] > avgV * 1.2 ? "HIGH" : v[v.length - 1] < avgV * 0.8 ? "LOW" : "NORMAL",
  };
}

// ── Binance ───────────────────────────────────────────────────
const SYMBOLS = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT",
  BNB: "BNBUSDT", XRP: "XRPUSDT", DOGE: "DOGEUSDT", ADA: "ADAUSDT",
};

async function fetchSignal(symbol, tf) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=100`);
  if (!r.ok) throw new Error("Binance error " + r.status);
  const klines = await r.json();
  return getIndicators(klines);
}

// ── Groq AI ───────────────────────────────────────────────────
async function getAISignal(coin, tf, ind) {
  const prompt = `You are a professional crypto trader. Analyse ${coin}/USDT on the ${tf} timeframe.

Indicators:
- Price: $${ind.price.toLocaleString()}
- RSI(14): ${ind.rsi} (${ind.rsiState})
- MACD: ${ind.macd} (${ind.macdState})
- SMA20: $${ind.sma20} | SMA50: $${ind.sma50} → ${ind.trend}
- Bollinger Bands: $${ind.bbLower} – $${ind.bbUpper}
- Support: $${ind.support} | Resistance: $${ind.resistance}
- Volume: ${ind.volume}

Reply with ONLY raw JSON, no markdown:
{"signal":"BUY","confidence":72,"entry":"${ind.price.toFixed(0)}","stopLoss":"price","takeProfit1":"price","takeProfit2":"price","reasoning":"2-3 sentences","risk":"MEDIUM","timeToHold":"duration"}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.3,
    }),
  });
  if (!r.ok) throw new Error("Groq error " + r.status);
  const d = await r.json();
  const text = d.choices[0].message.content.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON from AI");
  return JSON.parse(match[0]);
}

// ── Format message ────────────────────────────────────────────
function formatSignal(coin, tf, sig, ind) {
  const emoji = {
    STRONG_BUY: "🟢🟢", BUY: "🟢", NEUTRAL: "⚪️", SELL: "🔴", STRONG_SELL: "🔴🔴"
  }[sig.signal] || "⚪️";

  const riskEmoji = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🔴" }[sig.risk] || "🟡";

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

// ── Telegram helpers ──────────────────────────────────────────
async function sendMessage(chatId, text, parseMode = "Markdown") {
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
  });
}

async function sendTyping(chatId) {
  await fetch(`${TG}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// ── Help message ──────────────────────────────────────────────
const HELP = `🤖 *SignalAI Bot*

Send a message like:
• \`BTC 1h\` — Bitcoin 1 hour signal
• \`ETH 4h\` — Ethereum 4 hour signal
• \`SOL 15m\` — Solana 15 min signal

*Supported coins:*
BTC, ETH, SOL, BNB, XRP, DOGE, ADA

*Timeframes:*
15m, 1h, 4h, 1d

Just type the coin and timeframe and I'll generate a full signal with entry, stop loss, and take profits. ⚡`;

// ── Main polling loop ─────────────────────────────────────────
let offset = 0;

async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30`);
    const data = await r.json();

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim().toUpperCase();

      // Handle /start and /help
      if (text === "/START" || text === "/HELP") {
        await sendMessage(chatId, HELP);
        continue;
      }

      // Parse "BTC 1h" or "BTC" (default 1h)
      const parts = text.split(/\s+/);
      const coin = parts[0];
      const tf = (parts[1] || "1H").toLowerCase();

      if (!SYMBOLS[coin]) {
        await sendMessage(chatId, `❌ Unknown coin: *${coin}*\n\nSupported: BTC, ETH, SOL, BNB, XRP, DOGE, ADA`, "Markdown");
        continue;
      }

      const validTFs = ["15m", "1h", "4h", "1d"];
      if (!validTFs.includes(tf)) {
        await sendMessage(chatId, `❌ Unknown timeframe: *${tf}*\n\nSupported: 15m, 1h, 4h, 1d`, "Markdown");
        continue;
      }

      // Generate signal
      await sendTyping(chatId);
      await sendMessage(chatId, `⏳ Fetching ${coin} ${tf.toUpperCase()} signal...`);

      try {
        await sendTyping(chatId);
        const ind = await fetchSignal(SYMBOLS[coin], tf);
        const sig = await getAISignal(coin, tf, ind);
        const reply = formatSignal(coin, tf, sig, ind);
        await sendMessage(chatId, reply);
      } catch (e) {
        await sendMessage(chatId, `❌ Error: ${e.message}`);
      }
    }
  } catch (e) {
    console.error("Poll error:", e.message);
  }

  setTimeout(poll, 1000);
}

console.log("🤖 SignalAI Bot starting...");
poll();
