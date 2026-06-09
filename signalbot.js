import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Channel IDs — replace with your real channel IDs ──────
const SCALP_CHANNEL_ID = process.env.SCALP_CHANNEL_ID;   // e.g. -1001234567890
const SWING_CHANNEL_ID = process.env.SWING_CHANNEL_ID;   // e.g. -1009876543210

console.log("Bot starting...");
console.log("Token set:", !!TELEGRAM_TOKEN);
console.log("Groq set:", !!GROQ_API_KEY);

const sessions = {};

// ── Market session detector ────────────────────────────────
function getMarketSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 22 || hour < 7)  return { session: "ASIAN",     liquidity: "LOW",      note: "Low volume Asian session. Slow moves, wider spreads. Add 2-3x to hold time." };
  if (hour >= 7  && hour < 12) return { session: "LONDON",    liquidity: "HIGH",     note: "London session open. High volume, strong moves. Hold times as suggested." };
  if (hour >= 12 && hour < 17) return { session: "NEW YORK",  liquidity: "VERY HIGH",note: "NY+London overlap. Highest volume of the day. Fast moves, signals more reliable." };
  if (hour >= 17 && hour < 22) return { session: "NY CLOSE",  liquidity: "MEDIUM",   note: "NY closing session. Fading volume. Consider shorter holds or avoid new entries." };
  return { session: "MIXED", liquidity: "NORMAL", note: "" };
}

function getSmartHoldTime(tf, session) {
  const base = {
    "1m":15,"3m":30,"5m":45,"15m":90,"30m":180,"1h":240,"2h":480,
    "4h":720,"6h":1080,"8h":1440,"12h":2160,"1d":4320,"3d":10080,"1w":20160
  }[tf] || 240;
  const multiplier = session.liquidity==="LOW"?2.5:session.liquidity==="MEDIUM"?1.5:1;
  const mins = Math.round(base * multiplier);
  if (mins < 60)   return `${mins} minutes`;
  if (mins < 1440) return `${Math.round(mins/60)} hours`;
  return `${Math.round(mins/1440)} days`;
}

// ── Indicators ─────────────────────────────────────────────
function calcRSI(c, p=14) {
  if (c.length < p+1) return 50;
  let g=0,l=0;
  for (let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}
  return 100-100/(1+(g/p)/((l/p)||0.0001));
}
function calcEMA(a,p){
  const k=2/(p+1);let v=a.slice(0,p).reduce((x,y)=>x+y,0)/p;
  for(let i=p;i<a.length;i++)v=a[i]*k+v*(1-k);return v;
}
function getIndicators(klines) {
  const c=klines.map(k=>+k[4]),h=klines.map(k=>+k[2]),l=klines.map(k=>+k[3]),v=klines.map(k=>+k[5]);
  const last=c[c.length-1];
  const rsi=calcRSI(c);
  const e12=calcEMA(c,12),e26=calcEMA(c,26);
  const s20=c.slice(-20).reduce((a,b)=>a+b)/20;
  const s50=c.slice(-50).reduce((a,b)=>a+b)/50;
  const bm=s20,bs=Math.sqrt(c.slice(-20).map(x=>(x-bm)**2).reduce((a,b)=>a+b)/20);
  const tr=[];for(let i=1;i<klines.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  const atr=tr.slice(-14).reduce((a,b)=>a+b)/14;
  const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;
  const lc={o:+klines[klines.length-1][1],h:h[h.length-1],l:l[l.length-1],c:last};
  const pc={o:+klines[klines.length-2][1],h:h[h.length-2],l:l[l.length-2],c:c[c.length-2]};
  const patterns=[];
  if(lc.c>lc.o&&pc.c<pc.o&&lc.o<pc.c&&lc.c>pc.o)patterns.push("Bullish Engulfing");
  if(lc.c<lc.o&&pc.c>pc.o&&lc.o>pc.c&&lc.c<pc.o)patterns.push("Bearish Engulfing");
  if((Math.min(lc.o,lc.c)-lc.l)>Math.abs(lc.o-lc.c)*2)patterns.push("Hammer");
  if(Math.abs(lc.o-lc.c)<(lc.h-lc.l)*0.1)patterns.push("Doji");
  return {
    price:last,atr,
    rsi:rsi.toFixed(1),rsiState:rsi<30?"OVERSOLD":rsi>70?"OVERBOUGHT":"NEUTRAL",
    macd:(e12-e26).toFixed(5),macdState:e12>e26?"BULLISH":"BEARISH",
    sma20:s20.toFixed(5),sma50:s50.toFixed(5),
    trend:last>s50?"UPTREND":"DOWNTREND",
    bbUpper:(bm+2*bs).toFixed(5),bbLower:(bm-2*bs).toFixed(5),
    support:Math.min(...l.slice(-20)).toFixed(5),resistance:Math.max(...h.slice(-20)).toFixed(5),
    volume:v[v.length-1]>avgV*1.2?"HIGH":v[v.length-1]<avgV*0.8?"LOW":"NORMAL",
    patterns:patterns.length?patterns.join(", "):"None",
  };
}

// ── NEW: 4H Trend Analysis ─────────────────────────────────
function get4HTrend(klines4h) {
  const c = klines4h.map(k => +k[4]);
  const h = klines4h.map(k => +k[2]);
  const l = klines4h.map(k => +k[3]);
  const last = c[c.length - 1];

  // EMA 20 and EMA 50 on 4H
  const ema20 = calcEMA(c, 20);
  const ema50 = calcEMA(c, 50);

  // RSI on 4H
  const rsi4h = calcRSI(c);

  // Structure: higher highs / lower lows over last 10 candles
  const recentHighs = h.slice(-10);
  const recentLows  = l.slice(-10);
  const higherHighs = recentHighs[recentHighs.length-1] > recentHighs[0];
  const higherLows  = recentLows[recentLows.length-1]   > recentLows[0];
  const lowerHighs  = recentHighs[recentHighs.length-1] < recentHighs[0];
  const lowerLows   = recentLows[recentLows.length-1]   < recentLows[0];

  // Determine trend
  let trend4h, trendStrength, trendColor;

  if (last > ema20 && ema20 > ema50 && higherHighs && higherLows) {
    trend4h = "BULLISH";
    trendStrength = "STRONG";
    trendColor = "🟢";
  } else if (last > ema50 && rsi4h > 50) {
    trend4h = "BULLISH";
    trendStrength = "WEAK";
    trendColor = "🟡";
  } else if (last < ema20 && ema20 < ema50 && lowerHighs && lowerLows) {
    trend4h = "BEARISH";
    trendStrength = "STRONG";
    trendColor = "🔴";
  } else if (last < ema50 && rsi4h < 50) {
    trend4h = "BEARISH";
    trendStrength = "WEAK";
    trendColor = "🟡";
  } else {
    trend4h = "NEUTRAL";
    trendStrength = "RANGING";
    trendColor = "⚪️";
  }

  return { trend4h, trendStrength, trendColor, ema20_4h: ema20.toFixed(5), ema50_4h: ema50.toFixed(5), rsi4h: rsi4h.toFixed(1) };
}

// ── NEW: Signal Type Router ────────────────────────────────
// Returns: { type, action, reason }
// type: "SWING" | "SCALP" | "SKIP"
function classifySignal(signal, trend4h, session) {
  const isBuy  = ["BUY","STRONG_BUY"].includes(signal);
  const isSell = ["SELL","STRONG_SELL"].includes(signal);
  const { trend4h: t, trendStrength } = trend4h;
  const isLowLiquidity = session.liquidity === "LOW";

  // SKIP conditions — hard filters
  if (isLowLiquidity && trendStrength === "WEAK") {
    return { type: "SKIP", reason: "⚠️ Asian session + weak trend. No clear setup. Wait for London open." };
  }
  if (isBuy && t === "BEARISH" && trendStrength === "STRONG") {
    return { type: "SKIP", reason: "⚠️ 4H strongly bearish. Buying against strong trend. Skipping." };
  }
  if (isSell && t === "BULLISH" && trendStrength === "STRONG") {
    return { type: "SKIP", reason: "⚠️ 4H strongly bullish. Selling against strong trend. Skipping." };
  }

  // SWING conditions — 4H and signal fully aligned
  if ((isBuy && t === "BULLISH") || (isSell && t === "BEARISH")) {
    return { type: "SWING", reason: `✅ 4H ${t} aligns with ${signal}. High conviction setup. Target TP2.` };
  }

  // SCALP conditions — neutral 4H or weak alignment
  if (t === "NEUTRAL" || trendStrength === "WEAK") {
    return { type: "SCALP", reason: `⚡ 4H is ${t}. Range-bound. Scalp to TP1 only. Do not hold to TP2.` };
  }

  // Counter-trend scalp — weak opposite trend
  if ((isBuy && t === "BEARISH" && trendStrength === "WEAK") ||
      (isSell && t === "BULLISH" && trendStrength === "WEAK")) {
    return { type: "SCALP", reason: `⚡ Counter-trend scalp. 4H ${t} but weak. TP1 only. Tight SL.` };
  }

  return { type: "SCALP", reason: "⚡ No strong trend alignment. Scalp setup only." };
}

// ── Position sizing ────────────────────────────────────────
function calcPosition(balance, price, atr, leverage=1) {
  const risk = balance * 0.01;
  const slDist = atr * 1.2;
  let size = risk / slDist;
  let value = size * price;
  const maxValue = balance * leverage * 0.20;
  if (value > maxValue) { value = maxValue; size = value / price; }
  if (leverage === 1 && value > balance * 0.20) { value = balance * 0.20; size = value / price; }
  const margin = value / leverage;
  const marginPct = (margin / balance) * 100;
  return {
    risk: risk.toFixed(2),
    size: size.toFixed(6),
    value: value.toFixed(2),
    margin: margin.toFixed(2),
    marginPct: marginPct.toFixed(1),
  };
}

function calcLevels(price, atr, isBuy) {
  const sl  = isBuy ? price-atr*1.2 : price+atr*1.2;
  const tp1 = isBuy ? price+atr*1.8 : price-atr*1.8;
  const tp2 = isBuy ? price+atr*3.6 : price-atr*3.6;
  return { sl:sl.toFixed(5), tp1:tp1.toFixed(5), tp2:tp2.toFixed(5) };
}

// ── Symbols ────────────────────────────────────────────────
const CRYPTO = {
  BTC:"BTC-USDT",ETH:"ETH-USDT",SOL:"SOL-USDT",BNB:"BNB-USDT",
  XRP:"XRP-USDT",DOGE:"DOGE-USDT",ADA:"ADA-USDT",AVAX:"AVAX-USDT",
  MATIC:"MATIC-USDT",LINK:"LINK-USDT",DOT:"DOT-USDT",
  UNI:"UNI-USDT",ATOM:"ATOM-USDT",LTC:"LTC-USDT",
};
const FOREX_PAIRS = {
  "EURUSD":"EUR/USD","GBPUSD":"GBP/USD","USDJPY":"USD/JPY",
  "AUDUSD":"AUD/USD","USDCAD":"USD/CAD","USDCHF":"USD/CHF",
  "NZDUSD":"NZD/USD","EURGBP":"EUR/GBP",
};
const VALID_TFS = ["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w"];
const TF_MAP = {"1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1hour","2h":"2hour","4h":"4hour","6h":"6hour","8h":"8hour","12h":"12hour","1d":"1day","3d":"3day","1w":"1week"};
const COINS_LIST = Object.keys(CRYPTO).join(", ");
const FOREX_LIST = Object.keys(FOREX_PAIRS).join(", ");

async function fetchCryptoCandles(symbol, tf) {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${TF_MAP[tf]}&symbol=${symbol}&limit=210`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("KuCoin error " + r.status);
  const json = await r.json();
  if (!json.data?.length) throw new Error("No candle data");
  return json.data.reverse().map(k=>[k[0],k[1],k[3],k[4],k[2],k[5]]);
}

async function fetchForexCandles(pair, tf) {
  const intervalMap = {"1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1h","2h":"2h","4h":"4h","1d":"1day","1w":"1week"};
  const interval = intervalMap[tf] || "1h";
  const symbol = pair.slice(0,3) + "/" + pair.slice(3);
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=100&apikey=demo`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Forex API error " + r.status);
  const json = await r.json();
  if (!json.values?.length) throw new Error("No forex data — try again in a moment");
  return json.values.reverse().map(k=>[k.datetime,k.open,k.high,k.low,k.close,k.volume||"0"]);
}

async function getAISignal(coin, tf, ind, session, holdTime) {
  const p = ind.price, a = ind.atr;
  const buyLevels  = calcLevels(p, a, true);
  const sellLevels = calcLevels(p, a, false);
  const isForex = !!FOREX_PAIRS[coin];

  const prompt = `You are a master trader with 15 years experience, 90%+ win rate, trading both crypto and forex.

Analyse ${isForex ? FOREX_PAIRS[coin] : coin+"/USDT"} on the ${tf} timeframe.

MARKET SESSION: ${session.session} | Liquidity: ${session.liquidity}
SESSION NOTE: ${session.note}
RECOMMENDED HOLD TIME: ${holdTime}

MARKET DATA:
Price: ${p}
ATR(14): ${a.toFixed(5)}
RSI: ${ind.rsi} (${ind.rsiState})
MACD: ${ind.macd} (${ind.macdState})
SMA20: ${ind.sma20} | SMA50: ${ind.sma50} | Trend: ${ind.trend}
BB: ${ind.bbLower} – ${ind.bbUpper}
Support: ${ind.support} | Resistance: ${ind.resistance}
Volume: ${ind.volume}
Patterns: ${ind.patterns}

LEVEL GUIDANCE:
If BUY: entry ~${p}, SL ~${buyLevels.sl}, TP1 ~${buyLevels.tp1}, TP2 ~${buyLevels.tp2}
If SELL: entry ~${p}, SL ~${sellLevels.sl}, TP1 ~${sellLevels.tp1}, TP2 ~${sellLevels.tp2}

IMPORTANT: If the setup is unclear or indicators conflict strongly, return signal as "NEUTRAL".
Account for the ${session.session} session. During low liquidity warn about slow moves.

Reply ONLY with raw JSON:
{"signal":"BUY","confidence":75,"entry":"${p}","stopLoss":"${buyLevels.sl}","takeProfit1":"${buyLevels.tp1}","takeProfit2":"${buyLevels.tp2}","reasoning":"2-3 sentences","risk":"MEDIUM","timeToHold":"${holdTime}","keyLevel":"${ind.support}","sessionWarning":"warning if any"}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_API_KEY}`},
    body:JSON.stringify({model:"llama-3.3-70b-versatile",messages:[{role:"user",content:prompt}],max_tokens:500,temperature:0.1}),
  });
  const text = await r.text();
  console.log("Groq:", r.status, text.slice(0,300));
  if (!r.ok) throw new Error("Groq error " + r.status);
  const d = JSON.parse(text);
  const raw = d.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON returned");
  const sig = JSON.parse(match[0]);

  const isBuy = ["BUY","STRONG_BUY"].includes(sig.signal);
  const fb = calcLevels(p, a, isBuy);
  if (!sig.entry    ||+sig.entry    <=0) sig.entry       = p.toFixed(5);
  if (!sig.stopLoss ||+sig.stopLoss <=0) sig.stopLoss    = fb.sl;
  if (!sig.takeProfit1||+sig.takeProfit1<=0) sig.takeProfit1 = fb.tp1;
  if (!sig.takeProfit2||+sig.takeProfit2<=0) sig.takeProfit2 = fb.tp2;
  if (!sig.confidence||sig.confidence<=0)    sig.confidence  = 65;
  if (!sig.risk)     sig.risk       = "MEDIUM";
  if (!sig.timeToHold||sig.timeToHold==="0") sig.timeToHold = holdTime;
  if (!sig.reasoning) sig.reasoning = "Signal based on technical indicator confluence.";
  return sig;
}

// ── Format Signal ──────────────────────────────────────────
function formatSignal(coin, tf, sig, ind, pos, session, holdTime, leverage=1, trend4hData=null, classification=null) {
  const isForex = !!FOREX_PAIRS[coin];
  const pair = isForex ? FOREX_PAIRS[coin] : coin+"/USDT";
  const emoji = {STRONG_BUY:"🟢🟢",BUY:"🟢",NEUTRAL:"⚪️",SELL:"🔴",STRONG_SELL:"🔴🔴"}[sig.signal]||"⚪️";
  const riskEmoji = {LOW:"🟢",MEDIUM:"🟡",HIGH:"🔴"}[sig.risk]||"🟡";
  const liqEmoji = {HIGH:"🟢","VERY HIGH":"🟢🟢",MEDIUM:"🟡",LOW:"🔴","VERY LOW":"🔴🔴"}[session.liquidity]||"🟡";
  const conf = Math.min(Math.max(parseInt(sig.confidence)||65,0),100);
  const bar = "█".repeat(Math.round(conf/10))+"░".repeat(10-Math.round(conf/10));

  // Signal type badge
  const typeBadge = classification ? {
    SWING: "🏹 *SWING TRADE* — Target TP2",
    SCALP: "⚡ *SCALP TRADE* — Target TP1 only",
    SKIP:  "🚫 *NO TRADE* — Setup invalid"
  }[classification.type] : "";

  // 4H trend block
  const trend4hBlock = trend4hData ? `━━━━━━━━━━━━━━━━━━
📊 *4H Trend Filter:*
• Trend: ${trend4hData.trendColor} ${trend4hData.trend4h} (${trend4hData.trendStrength})
• EMA20: ${trend4hData.ema20_4h} | EMA50: ${trend4hData.ema50_4h}
• RSI 4H: ${trend4hData.rsi4h}
• ${classification?.reason || ""}` : "";

  return `${emoji} *${sig.signal}* — ${pair} ${tf.toUpperCase()}
${typeBadge}
━━━━━━━━━━━━━━━━━━
🕐 *Session:* ${session.session} ${liqEmoji} ${session.liquidity} liquidity
⏱ *Suggested Hold:* ${holdTime}
${sig.sessionWarning ? `⚠️ ${sig.sessionWarning}` : ""}
━━━━━━━━━━━━━━━━━━
💰 *Price:* ${parseFloat(ind.price).toLocaleString()}
⚡ *Confidence:* ${conf}% ${bar}
${riskEmoji} *Risk:* ${sig.risk}
━━━━━━━━━━━━━━━━━━
📍 *Entry:* ${sig.entry}
🛑 *Stop Loss:* ${sig.stopLoss}
🎯 *TP1:* ${sig.takeProfit1}
🏆 *TP2:* ${sig.takeProfit2}
🔑 *Key Level:* ${sig.keyLevel||ind.support}
━━━━━━━━━━━━━━━━━━
${trend4hBlock}
━━━━━━━━━━━━━━━━━━
💼 *Position Size (1% risk, 1:${leverage} leverage):*
• Risk Amount: $${pos.risk}
• Size: ${pos.size} ${isForex ? pair.replace("/","") : coin}
• Position Value: $${pos.value}
• Margin Used: $${pos.margin} (${pos.marginPct}% of balance)
━━━━━━━━━━━━━━━━━━
📊 *Analysis:*
${sig.reasoning}
━━━━━━━━━━━━━━━━━━
📈 *Indicators:*
• RSI: ${ind.rsi} (${ind.rsiState})
• MACD: ${ind.macdState}
• Trend: ${ind.trend}
• ATR: ${ind.atr.toFixed(5)}
• Volume: ${ind.volume}
• Patterns: ${ind.patterns}

_Not financial advice. Always use stop losses._`;
}

// ── Telegram helpers ───────────────────────────────────────
async function send(chatId, text) {
  const r = await fetch(`${TG}/sendMessage`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text,parse_mode:"Markdown"}),
  });
  const d = await r.json();
  if (!d.ok) console.error("Send error:", JSON.stringify(d));
}
async function typing(chatId) {
  await fetch(`${TG}/sendChatAction`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,action:"typing"})});
}

// ── NEW: Auto-broadcast to correct channel ─────────────────
async function broadcastSignal(formattedMessage, classification) {
  if (!SCALP_CHANNEL_ID || !SWING_CHANNEL_ID) return;
  if (classification.type === "SKIP") return; // Don't broadcast skipped signals

  const channelId = classification.type === "SWING" ? SWING_CHANNEL_ID : SCALP_CHANNEL_ID;
  await send(channelId, formattedMessage);
  console.log(`Signal broadcast to ${classification.type} channel`);
}

const HELP = `🤖 *MySignal AI — Master Trader Bot*

Type a pair and timeframe:
*Crypto:*
• \`BTC 1h\` • \`ETH 4h\` • \`SOL 15m\`

*Forex:*
• \`EURUSD 1h\` • \`GBPUSD 4h\` • \`USDJPY 1d\`

Every signal includes:
✅ 4H trend filter — SWING or SCALP classification
✅ Session-aware hold time (Asian/London/NY)
✅ Entry, Stop Loss, TP1 & TP2
✅ Position size (1% risk management)
✅ Auto-routed to correct Telegram channel

*Crypto:* ${COINS_LIST}
*Forex:* ${FOREX_LIST}
*Timeframes:* ${VALID_TFS.join(", ")}`;

let offset = 0;

async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30`);
    if (!r.ok) { console.error("Poll:", r.status); setTimeout(poll,3000); return; }
    const data = await r.json();
    if (!data.ok) { console.error("TG:", JSON.stringify(data)); setTimeout(poll,3000); return; }

    for (const update of data.result||[]) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text) continue;
      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const upper = text.toUpperCase();
      console.log(`[${chatId}] "${text}"`);

      if (upper==="/START"||upper==="/HELP") { sessions[chatId]=null; await send(chatId,HELP); continue; }

      // Awaiting balance
      if (sessions[chatId]?.step==="awaiting_balance") {
        const balance = parseFloat(text.replace(/[^0-9.]/g,""));
        if (isNaN(balance)||balance<50) {
          await send(chatId,"❌ Minimum is €50. Just type a number like `100` or `500`");
          continue;
        }
        const {coin,tf} = sessions[chatId];
        sessions[chatId] = {step:"awaiting_leverage", coin, tf, balance};
        await send(chatId,`✅ Balance: $${balance.toLocaleString()}

What is your account leverage?
Examples: \`10\` (1:10) or \`100\` (1:100) or \`500\` (1:500)
Type \`1\` if no leverage (spot trading)`);
        continue;
      }

      // Awaiting leverage
      if (sessions[chatId]?.step==="awaiting_leverage") {
        const leverage = parseFloat(text.replace(/[^0-9.]/g,""));
        if (isNaN(leverage)||leverage<1) {
          await send(chatId,"❌ Please enter a valid leverage e.g. `10` or `500`. Type `1` for no leverage.");
          continue;
        }
        const {coin,tf,balance} = sessions[chatId];
        sessions[chatId] = null;
        const isForex = !!FOREX_PAIRS[coin];
        const pair = isForex ? FOREX_PAIRS[coin] : coin+"/USDT";
        await typing(chatId);
        await send(chatId,`🔍 Analysing *${pair}* ${tf.toUpperCase()} with 4H filter — Balance: $${balance.toLocaleString()} | Leverage: 1:${leverage}...`);

        try {
          const session = getMarketSession();
          const holdTime = getSmartHoldTime(tf, session);

          // Fetch main timeframe candles
          const klines = isForex
            ? await fetchForexCandles(coin, tf)
            : await fetchCryptoCandles(CRYPTO[coin], tf);

          // ── NEW: Always fetch 4H candles for trend filter ──
          let klines4h = null;
          let trend4hData = null;
          if (tf !== "4h" && tf !== "1d" && tf !== "3d" && tf !== "1w") {
            try {
              klines4h = isForex
                ? await fetchForexCandles(coin, "4h")
                : await fetchCryptoCandles(CRYPTO[coin], "4h");
              trend4hData = get4HTrend(klines4h);
            } catch(e) {
              console.error("4H fetch failed:", e.message);
            }
          }

          const ind = getIndicators(klines);
          const pos = calcPosition(balance, ind.price, ind.atr, leverage);
          const sig = await getAISignal(coin, tf, ind, session, holdTime);

          // ── NEW: Classify signal ───────────────────────────
          const classification = trend4hData
            ? classifySignal(sig.signal, trend4hData, session)
            : { type: "SCALP", reason: "4H data unavailable. Treat as scalp." };

          const message = formatSignal(coin, tf, sig, ind, pos, session, holdTime, leverage, trend4hData, classification);

          // Send to user
          await send(chatId, message);

          // ── NEW: Broadcast to correct channel ─────────────
          await broadcastSignal(message, classification);

          // ── NEW: If SKIP, send extra warning to user ───────
          if (classification.type === "SKIP") {
            await send(chatId, `🚫 *Signal Skipped*\n\n${classification.reason}\n\nThis signal was NOT broadcast to any channel.`);
          }

        } catch(e) {
          console.error("Error:", e.message);
          await send(chatId,`❌ Error: ${e.message}`);
        }
        continue;
      }

      // Parse pair + tf
      const parts = upper.split(/\s+/);
      const coin = parts[0].replace(/\//,"");
      const tf = (parts[1]||"1H").toLowerCase();

      if (!CRYPTO[coin] && !FOREX_PAIRS[coin]) {
        await send(chatId,`❌ Unknown pair: *${coin}*\n\n*Crypto:* ${COINS_LIST}\n*Forex:* ${FOREX_LIST}`);
        continue;
      }
      if (!VALID_TFS.includes(tf)) {
        await send(chatId,`❌ Unknown timeframe: *${tf}*\n\nSupported: ${VALID_TFS.join(", ")}`);
        continue;
      }

      sessions[chatId] = {step:"awaiting_balance", coin, tf};
      await send(chatId,`💼 *${coin} ${tf.toUpperCase()} signal*\n\nWhat is your trading balance? (min €50)\n\nJust type the number e.g. \`100\` or \`500\``);
    }
  } catch(e) { console.error("Poll error:", e.message); }
  setTimeout(poll,1000);
}

poll();
