import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

console.log("Bot starting...");
console.log("Telegram token set:", !!TELEGRAM_TOKEN);
console.log("Groq key set:", !!GROQ_API_KEY);

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
  const tr = [];
  for (let i = 1; i < klines.length; i++) {
    tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  }
  const atr = tr.slice(-14).reduce((a, b) => a + b) / 14;

  // Stoch RSI
  const rsiArr = [];
  for (let i = 14; i < c.length; i++) {
    const sl = c.slice(i-14, i);
    let g = 0, lo = 0;
    for (let j = 1; j < sl.length; j++) { const d = sl[j]-sl[j-1]; d>0?g+=d:lo+=Math.abs(d); }
    rsiArr.push(100 - 100/(1+(g/14)/((lo/14)||0.0001)));
  }
  const rs = rsiArr.slice(-14);
  const rMin = Math.min(...rs), rMax = Math.max(...rs);
  const stochRSI = rMax===rMin ? 50 : ((rsiArr[rsiArr.length-1]-rMin)/(rMax-rMin))*100;

  // Patterns
  const lc = { o:+klines[klines.length-1][1], h:h[h.length-1], l:l[l.length-1], c:last };
  const pc = { o:+klines[klines.length-2][1], h:h[h.length-2], l:l[l.length-2], c:c[c.length-2] };
  const patterns = [];
  if (lc.c>lc.o && pc.c<pc.o && lc.o<pc.c && lc.c>pc.o) patterns.push("Bullish Engulfing");
  if (lc.c<lc.o && pc.c>pc.o && lc.o>pc.c && lc.c<pc.o) patterns.push("Bearish Engulfing");
  if ((Math.min(lc.o,lc.c)-lc.l)>Math.abs(lc.o-lc.c)*2 && (lc.h-Math.max(lc.o,lc.c))<Math.abs(lc.o-lc.c)*0.3) patterns.push("Hammer");
  if (Math.abs(lc.o-lc.c)<(lc.h-lc.l)*0.1) patterns.push("Doji");

  return {
    price: last, atr,
    rsi: rsi.toFixed(1), rsiState: rsi<30?"OVERSOLD":rsi>70?"OVERBOUGHT":"NEUTRAL",
    stochRSI: stochRSI.toFixed(1), stochState: stochRSI<20?"OVERSOLD":stochRSI>80?"OVERBOUGHT":"NEUTRAL",
    macd: (e12-e26).toFixed(4), macdState: e12>e26?"BULLISH":"BEARISH",
    ema9: e9.toFixed(2), sma20: s20.toFixed(2), sma50: s50.toFixed(2), sma200: s200.toFixed(2),
    trend: last>s50?(last>s200?"STRONG UPTREND":"WEAK UPTREND"):(last<s200?"STRONG DOWNTREND":"WEAK DOWNTREND"),
    bbUpper: (bm+2*bs).toFixed(2), bbMiddle: bm.toFixed(2), bbLower: (bm-2*bs).toFixed(2),
    support: Math.min(...l.slice(-20)).toFixed(2), resistance: Math.max(...h.slice(-20)).toFixed(2),
    volume: v[v.length-1]>avgV*1.5?"VERY HIGH":v[v.length-1]>avgV*1.2?"HIGH":v[v.length-1]<avgV*0.5?"VERY LOW":v[v.length-1]<avgV*0.8?"LOW":"NORMAL",
    patterns: patterns.length ? patterns.join(", ") : "None detected",
  };
}

// Position sizing — calculated in code, NOT by AI
function calcPositionSize(balance, price, atr) {
  const riskAmount = balance * 0.01; // 1% risk
  const slDistance = atr * 1.2; // 1.2x ATR stop
  const positionSize = riskAmount / slDistance;
  const positionValue = positionSize * price;
  return {
    riskAmount: riskAmount.toFixed(2),
    slDistance: slDistance.toFixed(2),
    positionSize: positionSize.toFixed(6),
    positionValue: positionValue.toFixed(2),
    percentOfBalance: ((positionValue / balance) * 100).toFixed(1),
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

async function getAISignal(coin, tf, ind) {
  // AI only gives: signal, confidence, entry, stopLoss, TP1, TP2, reasoning, risk, timeToHold, keyLevel
  // Position sizing is calculated separately in code
  const prompt = `You are a master crypto trader with 15 years experience and 90%+ win rate.

Analyse ${coin}/USDT on the ${tf} timeframe.

PRICE: $${ind.price.toLocaleString()}
ATR(14): $${ind.atr.toFixed(2)}

MOMENTUM:
- RSI(14): ${ind.rsi} → ${ind.rsiState}
- Stoch RSI: ${ind.stochRSI} → ${ind.stochState}
- MACD: ${ind.macd} → ${ind.macdState}

TREND:
- EMA9: $${ind.ema9} | SMA20: $${ind.sma20} | SMA50: $${ind.sma50} | SMA200: $${ind.sma200}
- Overall: ${ind.trend}

LEVELS:
- BB: $${ind.bbLower} – $${ind.bbUpper}
- Support: $${ind.support} | Resistance: $${ind.resistance}

VOLUME: ${ind.volume}
PATTERNS: ${ind.patterns}

RULES:
- Stop loss must be within 1.5x ATR ($${(ind.atr*1.5).toFixed(2)}) of entry
- TP1 = minimum 1.5x risk from entry
- TP2 = minimum 3x risk from entry
- Use NEUTRAL if no clear setup

Reply with ONLY this JSON, real prices filled in, no zeros:
{"signal":"BUY","confidence":78,"entry":"${ind.price.toFixed(2)}","stopLoss":"${(ind.price - ind.atr*1.2).toFixed(2)}","takeProfit1":"${(ind.price + ind.atr*1.8).toFixed(2)}","takeProfit2":"${(ind.price + ind.atr*3.6).toFixed(2)}","reasoning":"your analysis here","risk":"MEDIUM","timeToHold":"2-4 hours","keyLevel":"${ind.support}"}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 500, temperature: 0.2 }),
  });
  const text = await r.text();
  console.log("Groq status:", r.status, text.slice(0, 300));
  if (!r.ok) throw new Error("Groq error " + r.status);
  const d = JSON.parse(text);
  const content = d.choices[0].message.content.trim();
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON from AI");
  const sig = JSON.parse(match[0]);

  // Validate — if AI returned 0 or bad values, use ATR-based fallback
  const price = ind.price;
  const atr = ind.atr;
  const isBuy = ["BUY","STRONG_BUY"].includes(sig.signal);
  if (!sig.entry || +sig.entry === 0) sig.entry = price.toFixed(2);
  if (!sig.stopLoss || +sig.stopLoss === 0) sig.stopLoss = isBuy ? (price - atr*1.2).toFixed(2) : (price + atr*1.2).toFixed(2);
  if (!sig.takeProfit1 || +sig.takeProfit1 === 0) sig.takeProfit1 = isBuy ? (price + atr*1.8).toFixed(2) : (price - atr*1.8).toFixed(2);
  if (!sig.takeProfit2 || +sig.takeProfit2 === 0) sig.takeProfit2 = isBuy ? (price + atr*3.6).toFixed(2) : (price - atr*3.6).toFixed(2);
  if (!sig.confidence || sig.confidence === 0) sig.confidence = 60;
  if (!sig.timeToHold || sig.timeToHold === "0") sig.timeToHold = "2-4 hours";

  return sig;
}

function formatSignal(coin, tf, sig, ind, pos) {
  const emoji = { STRONG_BUY:"🟢🟢", BUY:"🟢", NEUTRAL:"⚪️", SELL:"🔴", STRONG_SELL:"🔴🔴" }[sig.signal] || "⚪️";
  const riskEmoji = { LOW:"🟢", MEDIUM:"🟡", HIGH:"🔴" }[sig.risk] || "🟡";
  const conf = Math.min(Math.max(sig.confidence, 0), 100);
  const confBar = "█".repeat(Math.round(conf/10)) + "░".repeat(10-Math.round(conf/10));
  const rr = sig.riskReward || "1:2";

  return `${emoji} *${sig.signal}* — ${coin}/USDT ${tf.toUpperCase()}
━━━━━━━━━━━━━━━━━━
💰 *Price:* $${parseFloat(ind.price).toLocaleString()}
⚡ *Confidence:* ${conf}% ${confBar}
${riskEmoji} *Risk:* ${sig.risk || "MEDIUM"} | ⏱ *Hold:* ${sig.timeToHold}
📐 *Risk/Reward:* ${rr}
━━━━━━━━━━━━━━━━━━
📍 *Entry:* $${sig.entry}
🛑 *Stop Loss:* $${sig.stopLoss}
🎯 *TP1:* $${sig.takeProfit1}
🏆 *TP2:* $${sig.takeProfit2}
${sig.keyLevel ? `🔑 *Key Level:* $${sig.keyLevel}` : ""}
━━━━━━━━━━━━━━━━━━
💼 *Position Sizing (1% risk):*
• Risk Amount: $${pos.riskAmount}
• Position Size: ${pos.positionSize} ${coin}
• Position Value: $${pos.positionValue} (${pos.percentOfBalance}% of balance)
━━━━━━━━━━━━━━━━━━
📊 *Analysis:*
${sig.reasoning}
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
• \`BTC 1h\`
• \`ETH 4h\`
• \`SOL 15m\`

I'll ask your balance then give you:
✅ Entry, Stop Loss, TP1 & TP2
✅ Exact position size for your balance
✅ 1% risk management per trade
✅ ATR-based tight stop losses
✅ RSI, Stoch RSI, MACD analysis
✅ Candle pattern detection

*Minimum balance: €50*

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

      if (upper === "/START" || upper === "/HELP") {
        sessions[chatId] = null;
        await sendMessage(chatId, HELP);
        continue;
      }

      // Awaiting balance
      if (sessions[chatId]?.step === "awaiting_balance") {
        const balance = parseFloat(text.replace(/[$,€£\s]/g, ""));
        if (isNaN(balance) || balance < 50) {
          await sendMessage(chatId, "❌ Minimum balance is €50. Please enter a valid amount e.g. `50`, `300` or `1000`");
          continue;
        }
        const { coin, tf } = sessions[chatId];
        sessions[chatId] = null;

        await sendTyping(chatId);
        await sendMessage(chatId, `🔍 Analysing *${coin}* ${tf.toUpperCase()} with $${balance.toLocaleString()} balance...`);

        try {
          const klines = await fetchCandles(SYMBOLS[coin], tf);
          const ind = getIndicators(klines);
          const pos = calcPositionSize(balance, ind.price, ind.atr);
          const sig = await getAISignal(coin, tf, ind);
          await sendMessage(chatId, formatSignal(coin, tf, sig, ind, pos));
        } catch(e) {
          console.error("Signal error:", e.message);
          await sendMessage(chatId, `❌ Error: ${e.message}`);
        }
        continue;
      }

      // Parse coin + tf
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

      sessions[chatId] = { step: "awaiting_balance", coin, tf };
      await sendMessage(chatId, `💼 *${coin} ${tf.toUpperCase()} signal requested*\n\nWhat is your trading balance? (minimum €50)\n\nExample: \`50\` or \`300\` or \`1000\`\n\n_I'll calculate the exact position size using 1% risk per trade._`);
    }
  } catch(e) { console.error("Poll error:", e.message); }
  setTimeout(poll, 1000);
}

poll();
