import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

console.log("Bot starting...");
console.log("Token set:", !!TELEGRAM_TOKEN);
console.log("Groq set:", !!GROQ_API_KEY);

// Session store
const sessions = {};

// ── Indicators ────────────────────────────────────────────
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
    price:last, atr,
    rsi:rsi.toFixed(1), rsiState:rsi<30?"OVERSOLD":rsi>70?"OVERBOUGHT":"NEUTRAL",
    macd:(e12-e26).toFixed(4), macdState:e12>e26?"BULLISH":"BEARISH",
    sma20:s20.toFixed(2), sma50:s50.toFixed(2),
    trend:last>s50?"UPTREND":"DOWNTREND",
    bbUpper:(bm+2*bs).toFixed(2), bbLower:(bm-2*bs).toFixed(2),
    support:Math.min(...l.slice(-20)).toFixed(2), resistance:Math.max(...h.slice(-20)).toFixed(2),
    volume:v[v.length-1]>avgV*1.2?"HIGH":v[v.length-1]<avgV*0.8?"LOW":"NORMAL",
    patterns:patterns.length?patterns.join(", "):"None",
  };
}

// ── Position sizing (done in code, never by AI) ───────────
function calcPosition(balance, price, atr) {
  const risk = balance * 0.01;
  const slDist = atr * 1.2;
  let size = risk / slDist;
  let value = size * price;
  // Cap at 20% of balance — no leverage ever
  const maxValue = balance * 0.2;
  if (value > maxValue) { value = maxValue; size = value / price; }
  return {
    risk: risk.toFixed(2),
    size: size.toFixed(6),
    value: value.toFixed(2),
    pct: ((value/balance)*100).toFixed(1),
  };
}

// ── ATR-based levels (fallback if AI fails) ───────────────
function calcLevels(price, atr, isBuy) {
  const sl   = isBuy ? price - atr*1.2 : price + atr*1.2;
  const tp1  = isBuy ? price + atr*1.8 : price - atr*1.8;
  const tp2  = isBuy ? price + atr*3.6 : price - atr*3.6;
  return { sl:sl.toFixed(2), tp1:tp1.toFixed(2), tp2:tp2.toFixed(2) };
}

const SYMBOLS = {
  BTC:"BTC-USDT",ETH:"ETH-USDT",SOL:"SOL-USDT",BNB:"BNB-USDT",
  XRP:"XRP-USDT",DOGE:"DOGE-USDT",ADA:"ADA-USDT",AVAX:"AVAX-USDT",
  MATIC:"MATIC-USDT",LINK:"LINK-USDT",DOT:"DOT-USDT",
  UNI:"UNI-USDT",ATOM:"ATOM-USDT",LTC:"LTC-USDT",
};
const COINS_LIST = Object.keys(SYMBOLS).join(", ");
const VALID_TFS = ["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w"];
const TF_MAP = {"1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1hour","2h":"2hour","4h":"4hour","6h":"6hour","8h":"8hour","12h":"12hour","1d":"1day","3d":"3day","1w":"1week"};

async function fetchCandles(symbol, tf) {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${TF_MAP[tf]}&symbol=${symbol}&limit=210`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("KuCoin error " + r.status);
  const json = await r.json();
  if (!json.data?.length) throw new Error("No candle data");
  return json.data.reverse().map(k=>[k[0],k[1],k[3],k[4],k[2],k[5]]);
}

async function getAISignal(coin, tf, ind) {
  const p = ind.price, a = ind.atr;
  const buyLevels  = calcLevels(p, a, true);
  const sellLevels = calcLevels(p, a, false);

  const prompt = `You are a master crypto trader with 15 years experience and 90%+ win rate.

Analyse ${coin}/USDT on the ${tf} timeframe and give ONE clear signal.

MARKET DATA:
Price: $${p.toLocaleString()}
ATR(14): $${a.toFixed(2)}
RSI: ${ind.rsi} (${ind.rsiState})
MACD: ${ind.macd} (${ind.macdState})
SMA20: $${ind.sma20} | SMA50: $${ind.sma50} | Trend: ${ind.trend}
BB: $${ind.bbLower} – $${ind.bbUpper}
Support: $${ind.support} | Resistance: $${ind.resistance}
Volume: ${ind.volume}
Patterns: ${ind.patterns}

If BUY signal: use entry ~$${p.toFixed(2)}, SL ~$${buyLevels.sl}, TP1 ~$${buyLevels.tp1}, TP2 ~$${buyLevels.tp2}
If SELL signal: use entry ~$${p.toFixed(2)}, SL ~$${sellLevels.sl}, TP1 ~$${sellLevels.tp1}, TP2 ~$${sellLevels.tp2}
Adjust levels slightly based on key structure. If no clear setup, use NEUTRAL with the same example levels.

YOU MUST reply with ONLY this exact JSON structure, all fields filled with real numbers:
{"signal":"BUY","confidence":75,"entry":"${p.toFixed(2)}","stopLoss":"${buyLevels.sl}","takeProfit1":"${buyLevels.tp1}","takeProfit2":"${buyLevels.tp2}","reasoning":"your analysis here in 2-3 sentences","risk":"MEDIUM","timeToHold":"2-4 hours","keyLevel":"${ind.support}"}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_API_KEY}`},
    body:JSON.stringify({model:"llama-3.3-70b-versatile",messages:[{role:"user",content:prompt}],max_tokens:400,temperature:0.1}),
  });
  const text = await r.text();
  console.log("Groq:", r.status, text.slice(0,300));
  if (!r.ok) throw new Error("Groq error " + r.status);
  const d = JSON.parse(text);
  const raw = d.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON returned");
  const sig = JSON.parse(match[0]);

  // Fallback for any missing/zero/null fields
  const isBuy = ["BUY","STRONG_BUY"].includes(sig.signal);
  const fb = calcLevels(p, a, isBuy);
  if (!sig.entry    || +sig.entry    <= 0) sig.entry       = p.toFixed(2);
  if (!sig.stopLoss || +sig.stopLoss <= 0) sig.stopLoss    = fb.sl;
  if (!sig.takeProfit1||+sig.takeProfit1<=0) sig.takeProfit1 = fb.tp1;
  if (!sig.takeProfit2||+sig.takeProfit2<=0) sig.takeProfit2 = fb.tp2;
  if (!sig.confidence || sig.confidence<=0) sig.confidence  = 65;
  if (!sig.risk)     sig.risk      = "MEDIUM";
  if (!sig.timeToHold || sig.timeToHold==="0") sig.timeToHold = "2-4 hours";
  if (!sig.reasoning) sig.reasoning = "Signal based on technical indicator confluence.";

  return sig;
}

function formatSignal(coin, tf, sig, ind, pos) {
  const emoji = {STRONG_BUY:"🟢🟢",BUY:"🟢",NEUTRAL:"⚪️",SELL:"🔴",STRONG_SELL:"🔴🔴"}[sig.signal]||"⚪️";
  const riskEmoji = {LOW:"🟢",MEDIUM:"🟡",HIGH:"🔴"}[sig.risk]||"🟡";
  const conf = Math.min(Math.max(parseInt(sig.confidence)||65, 0), 100);
  const bar = "█".repeat(Math.round(conf/10))+"░".repeat(10-Math.round(conf/10));
  return `${emoji} *${sig.signal}* — ${coin}/USDT ${tf.toUpperCase()}
━━━━━━━━━━━━━━━━━━
💰 *Price:* $${parseFloat(ind.price).toLocaleString()}
⚡ *Confidence:* ${conf}% ${bar}
${riskEmoji} *Risk:* ${sig.risk} | ⏱ *Hold:* ${sig.timeToHold}
━━━━━━━━━━━━━━━━━━
📍 *Entry:* $${sig.entry}
🛑 *Stop Loss:* $${sig.stopLoss}
🎯 *TP1:* $${sig.takeProfit1}
🏆 *TP2:* $${sig.takeProfit2}
🔑 *Key Level:* $${sig.keyLevel||ind.support}
━━━━━━━━━━━━━━━━━━
💼 *Position Size (1% risk):*
• Risk: $${pos.risk}
• Size: ${pos.size} ${coin}
• Value: $${pos.value} (${pos.pct}% of balance)
━━━━━━━━━━━━━━━━━━
📊 *Analysis:*
${sig.reasoning}
━━━━━━━━━━━━━━━━━━
📈 *Indicators:*
• RSI: ${ind.rsi} (${ind.rsiState})
• MACD: ${ind.macdState}
• Trend: ${ind.trend}
• ATR: $${ind.atr.toFixed(2)}
• Volume: ${ind.volume}
• Patterns: ${ind.patterns}

_Not financial advice. Always manage your risk._`;
}

async function send(chatId, text) {
  const r = await fetch(`${TG}/sendMessage`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text,parse_mode:"Markdown"}),
  });
  const d = await r.json();
  if (!d.ok) console.error("Send error:", JSON.stringify(d));
}

async function typing(chatId) {
  await fetch(`${TG}/sendChatAction`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,action:"typing"}),
  });
}

const HELP = `🤖 *SignalAI — Master Trader Bot*

Type a coin and timeframe:
• \`BTC 1h\`
• \`ETH 4h\`
• \`SOL 15m\`

I'll ask your balance then send a full signal with position sizing.

*Minimum balance: €50*
*Coins:* ${COINS_LIST}
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

      // Commands
      if (upper==="/START"||upper==="/HELP") {
        sessions[chatId] = null;
        await send(chatId, HELP);
        continue;
      }

      // Awaiting balance
      if (sessions[chatId]?.step==="awaiting_balance") {
        const balance = parseFloat(text.replace(/[^0-9.]/g,""));
        if (isNaN(balance)||balance<50) {
          await send(chatId,"❌ Minimum is €50. Enter a number like `100` or `500`");
          continue;
        }
        const {coin,tf} = sessions[chatId];
        sessions[chatId] = null;
        await typing(chatId);
        await send(chatId,`🔍 Analysing *${coin}* ${tf.toUpperCase()} with $${balance.toLocaleString()} balance...`);
        try {
          const klines = await fetchCandles(SYMBOLS[coin], tf);
          const ind = getIndicators(klines);
          const pos = calcPosition(balance, ind.price, ind.atr);
          const sig = await getAISignal(coin, tf, ind);
          await send(chatId, formatSignal(coin, tf, sig, ind, pos));
        } catch(e) {
          console.error("Error:", e.message);
          await send(chatId,`❌ Error: ${e.message}`);
        }
        continue;
      }

      // Parse coin + timeframe
      const parts = upper.split(/\s+/);
      const coin = parts[0].replace(/\/(USDT|USD)/,"").replace(/-(USDT|USD)/,"");
      const tf = (parts[1]||"1H").toLowerCase();

      if (!SYMBOLS[coin]) {
        await send(chatId,`❌ Unknown coin *${coin}*\n\nSupported: ${COINS_LIST}\n\nExample: \`BTC 1h\``);
        continue;
      }
      if (!VALID_TFS.includes(tf)) {
        await send(chatId,`❌ Unknown timeframe *${tf}*\n\nSupported: ${VALID_TFS.join(", ")}`);
        continue;
      }

      // Ask balance
      sessions[chatId] = {step:"awaiting_balance", coin, tf};
      await send(chatId,`💼 *${coin} ${tf.toUpperCase()} signal*\n\nWhat is your trading balance? (min €50)\n\nJust type the number:\n\`100\` or \`500\` or \`2000\``);
    }
  } catch(e) { console.error("Poll error:", e.message); }
  setTimeout(poll,1000);
}

poll();
