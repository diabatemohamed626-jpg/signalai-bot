import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

console.log("Bot starting...");
console.log("Telegram token set:", !!TELEGRAM_TOKEN);
console.log("Groq key set:", !!GROQ_API_KEY);

// Store user sessions: { chatId: { step, coin, tf, balance } }
const sessions = {};

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

  // ATR
  const trueRanges = [];
  for (let i = 1; i < klines.length; i++) {
    const hi = h[i], lo = l[i], pc = c[i-1];
    trueRanges.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  const atr = trueRanges.slice(-14).reduce((a, b) => a + b) / 14;

  // Stoch RSI
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
  const rsiMin = Math.min(...rsiSlice), rsiMax = Math.max(...rsiSlice);
  const stochRSI = rsiMax === rsiMin ? 50 : ((rsiValues[rsiValues.length-1] - rsiMin) / (rsiMax - rsiMin)) * 100;

  // Candle patterns
  const lastC = { o: +klines[klines.length-1][1], h: h[h.length-1], l: l[l.length-1], c: last };
  const prevC = { o: +klines[klines.length-2][1], h: h[h.length-2], l: l[l.length-2], c: c[c.length-2] };
  const patterns = [];
  if (lastC.c > lastC.o && prevC.c < prevC.o && lastC.o < prevC.c && lastC.c > prevC.o) patterns.push("Bullish Engulfing");
  if (lastC.c < lastC.o && prevC.c > prevC.o && lastC.o > prevC.c && lastC.c < prevC.o) patterns.push("Bearish Engulfing");
  if ((Math.min(lastC.o,lastC.c) - lastC.l) > Math.abs(lastC.o-lastC.c)*2 && (lastC.h - Math.max(lastC.o,lastC.c)) < Math.abs(lastC.o-lastC.c)*0.3) patterns.push("Hammer");
  if (Math.abs(lastC.o-lastC.c) < (lastC.h-lastC.l)*0.1) patterns.push("Doji");

  return {
    price: last, atr,
    rsi: rsi.toFixed(1), rsiState: rsi < 30 ? "OVERSOLD" : rsi > 70 ? "OVERBOUGHT" : "NEUTRAL",
    stochRSI: stochRSI.toFixed(1), stochState: stochRSI < 20 ? "OVERSOLD" : stochRSI > 80 ? "OVERBOUGHT" : "NEUTRAL",
    macd: (e12-e26).toFixed(4), macdState: e12>e26 ? "BULLISH" : "BEARISH",
    ema9: e9.toFixed(2), sma20: s20.toFixed(2), sma50: s50.toFixed(2), sma200: s200.toFixed(2),
    trend: last > s50 ? (last > s200 ? "STRONG UPTREND" : "WEAK UPTREND") : (last < s200 ? "STRONG DOWNTREND" : "WEAK DOWNTREND"),
    bbUpper: (bm+2*bs).toFixed(2), bbMiddle: bm.toFixed(2), bbLower: (bm-2*bs).toFixed(2),
    support: Math.min(...l.slice(-20)).toFixed(2), resistance: Math.max(...h.slice(-20)).toFixed(2),
    volume: v[v.length-1] > avgV*1.5 ? "VERY HIGH" : v[v.length-1] > avgV*1.2 ? "HIGH" : v[v.length-1] < avgV*0.5 ? "VERY LOW" : v[v.length-1] < avgV*0.8 ? "LOW" : "NORMAL",
    patterns: patterns.length ? patterns.join(", ") : "None detected",
  };
}

const SYMBOLS = {
  BTC:"BTC-USDT", ETH:"ETH-USDT", SOL:"SOL-USDT", BNB:"BNB-USDT",
  XRP:"XRP-USDT", DOGE:"DOGE-USDT", ADA:"ADA-USDT", AVAX:"AVAX-USDT",
  MATIC:"MATIC-USDT", LINK:"LINK-USDT", DOT:"DOT-USDT", UNI:"UNI-USDT",
  ATOM:"ATOM-USDT", LTC:"LTC-USDT",
};
const COINS_LIST = Object.keys(SYMBOLS).join(", ");
const VALID_TFS = ["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w"];

async function fetchCandles(symbol, tf) {
  const tfMap = {"1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1hour","2h":"2hour","4h":"4hour","6h":"6hour","8h":"8hour","12h":"12hour","1d":"1day","3d":"3day","1w":"1week"};
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${tfMap[tf]||"1hour"}&symbol=${symbol}&limit=210`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("KuCoin error " + r.status);
  const json = await r.json();
  if (!json.data?.length) throw new Error("No candle data");
  return json.data.reverse().map(k => [k[0],k[1],k[3],k[4],k[2],k[5]]);
}

async function getAISignal(coin, tf, ind, balance) {
  // Risk management: 1% of balance per trade
  const riskAmount = balance * 0.01;
  const stopLossDistance = ind.atr * 1.2;
  const positionSize = riskAmount / stopLossDistance;
  const positionValue = positionSize * ind.price;
  const leverage = Math.min(Math.ceil(positionValue / balance), 10); // suggest leverage if needed

  const prompt = `You are a master crypto trader with 15 years experience and 90%+ win rate. You are known for:
- Extremely precise entries with tight stop losses (1-1.5x ATR max)
- Only taking high probability setups with strong confluence
- Perfect risk/reward (minimum 1:2, preferring 1:3+)
- Never risking more than 1% of account per trade
- Reading market structure and momentum together

Analyse ${coin}/USDT on the ${tf} timeframe.

=== MARKET DATA ===
Price: $${ind.price.toLocaleString()}
ATR(14): $${ind.atr.toFixed(2)}

MOMENTUM:
- RSI(14): ${ind.rsi} → ${ind.rsiState}
- Stoch RSI: ${ind.stochRSI} → ${ind.stochState}
- MACD: ${ind.macd} → ${ind.macdState}

TREND:
- EMA9: $${ind.ema9} | SMA20: $${ind.sma20} | SMA50: $${ind.sma50} | SMA200: $${ind.sma200}
- Overall: ${ind.trend}

VOLATILITY:
- BB Upper: $${ind.bbUpper} | Mid: $${ind.bbMiddle} | Lower: $${ind.bbLower}

KEY LEVELS:
- Support: $${ind.support} | Resistance: $${ind.resistance}

VOLUME: ${ind.volume}
CANDLE PATTERNS: ${ind.patterns}

=== ACCOUNT ===
Balance: $${balance.toLocaleString()}
Risk per trade (1%): $${riskAmount.toFixed(2)}
ATR-based stop distance: $${stopLossDistance.toFixed(2)}
Suggested position size: ${positionSize.toFixed(4)} ${coin} (~$${positionValue.toFixed(2)})

Give your highest conviction signal only. Use NEUTRAL if confluence is weak.
Stop loss: max 1.5x ATR from entry, placed at structural level.
TP1: 1.5x risk. TP2: 3x risk.

Reply ONLY with raw JSON:
{"signal":"BUY","confidence":85,"entry":"${ind.price.toFixed(2)}","stopLoss":"price","takeProfit1":"price","takeProfit2":"price","reasoning":"precise explanation","risk":"LOW","timeToHold":"duration","riskReward":"1:3","keyLevel":"price","positionSize":"${positionSize.toFixed(4)} ${coin}","positionValue":"$${positionValue.toFixed(2)}","riskAmount":"$${riskAmount.toFixed(2)}","suggestion":"any extra advice"}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 700, temperature: 0.2 }),
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
  const confBar = "█".repeat(Math.round(sig.confidence/10)) + "░".repeat(10-Math.round(sig.confidence/10));

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
💼 *Position Sizing (1% risk):*
• Risk Amount: ${sig.riskAmount}
• Position Size: ${sig.positionSize}
• Position Value: ${sig.positionValue}
━━━━━━━━━━━━━━━━━━
📊 *Master Analysis:*
${sig.reasoning}
${sig.suggestion ? `\n💡 *Pro Tip:* ${sig.suggestion}` : ""}
━━━━━━━━━━━━━━━━━━
📈 *Indicators:*
• RSI: ${ind.rsi} (${ind.rsiState})
• Stoch RSI: ${ind.stochRSI} (${ind.stochState})
• MACD: ${ind.macdState}
• Trend: ${ind.trend}
• ATR: $${ind.atr.toFixed(2)}
• Volume: ${ind.volume}
• Patterns: ${ind.patterns}

_Not financial advice. Always manage your risk._`;
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

const HELP = `🤖 *SignalAI — Master Trader Bot*

Send a signal request like:
• \`BTC 1h\` — and I'll ask your balance
• \`ETH 4h\`
• \`SOL 15m\`

Every signal includes:
✅ Tight entry & stop loss (ATR-based)
✅ TP1 & TP2 with risk/reward ratio
✅ Position size calculated for your balance
✅ 1% risk management per trade
✅ RSI, Stoch RSI, MACD, ATR analysis
✅ Candle pattern detection

*Coins:* ${COINS_LIST}
*Timeframes:* ${VALID_TFS.join(", ")}`;

let offset = 0;

async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30`);
    if (!r.ok) { console.error("Poll error:", r.status); setTimeout(poll, 3000); return; }
    const data = await r.json();
    if (!data.ok) { console.error("TG error:", JSON.stringify(data)); setTimeout(poll, 3000); return; }

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const upper = text.toUpperCase();
      console.log(`[${chatId}] ${text}`);

      // Handle /start /help
      if (upper === "/START" || upper === "/HELP") {
        sessions[chatId] = null;
        await sendMessage(chatId, HELP);
        continue;
      }

      // Check if user is in a session waiting for balance
      if (sessions[chatId]?.step === "awaiting_balance") {
        const balance = parseFloat(text.replace(/[$,€£]/g, ""));
        if (isNaN(balance) || balance <= 0) {
          await sendMessage(chatId, "❌ Please enter a valid amount, e.g. `500` or `1200`");
          continue;
        }
        const { coin, tf } = sessions[chatId];
        sessions[chatId] = null;

        await sendTyping(chatId);
        await sendMessage(chatId, `🔍 Analysing *${coin}* ${tf.toUpperCase()} with $${balance.toLocaleString()} balance...`);

        try {
          const klines = await fetchCandles(SYMBOLS[coin], tf);
          const ind = getIndicators(klines);
          const sig = await getAISignal(coin, tf, ind, balance);
          await sendMessage(chatId, formatSignal(coin, tf, sig, ind));
        } catch(e) {
          console.error("Signal error:", e.message);
          await sendMessage(chatId, `❌ Error: ${e.message}`);
        }
        continue;
      }

      // Parse coin + timeframe
      const parts = upper.split(/\s+/);
      const coin = parts[0].replace("/USDT","").replace("-USDT","");
      const tf = (parts[1] || "1H").toLowerCase();

      if (!SYMBOLS[coin]) {
        await sendMessage(chatId, `❌ Unknown coin: *${coin}*\n\nSupported: ${COINS_LIST}`);
        continue;
      }
      if (!VALID_TFS.includes(tf)) {
        await sendMessage(chatId, `❌ Unknown timeframe: *${tf}*\n\nSupported: ${VALID_TFS.join(", ")}`);
        continue;
      }

      // Ask for balance
      sessions[chatId] = { step: "awaiting_balance", coin, tf };
      await sendMessage(chatId, `💼 *${coin} ${tf.toUpperCase()} signal requested*\n\nHow much is your trading balance? (in USD)\n\nExample: \`500\` or \`2000\`\n\n_I'll calculate the perfect position size for 1% risk per trade._`);
    }
  } catch(e) { console.error("Poll error:", e.message); }
  setTimeout(poll, 1000);
}

poll();
