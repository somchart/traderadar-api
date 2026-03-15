// TradeRadar API v7.0 — Finnhub primary, no scraping
// Finnhub: free 60 req/min, designed for server use, never blocks Railway IPs
// Sign up free at https://finnhub.io → Dashboard → API Keys
// "type":"module" in package.json required

import express from 'express';
import cors    from 'cors';
import helmet  from 'helmet';
import https   from 'https';
import http    from 'http';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_KEY       = process.env.API_KEY       || 'change-me-in-env';
const CACHE_TTL_MS  = parseInt(process.env.CACHE_TTL_MS || '60000');
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT   || '120');
const ALLOWED_ORIGIN= process.env.ALLOWED_ORIGIN || '*';
const FINNHUB_KEY   = process.env.FINNHUB_KEY   || '';   // REQUIRED — free at finnhub.io
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';   // For /api/ai proxy
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || '';   // Optional extra coverage

// ─── CACHE ───────────────────────────────────────────────────────────────────
const cache  = new Map();
const getC   = k => { const e=cache.get(k); if(!e)return null; if(Date.now()>e.exp){cache.delete(k);return null;} return e.data; };
const setC   = (k,d,ttl=CACHE_TTL_MS) => cache.set(k,{data:d,exp:Date.now()+ttl});
const cStats = () => { let v=0,now=Date.now(); cache.forEach(e=>{if(now<e.exp)v++;}); return {total:cache.size,valid:v,ttl_ms:CACHE_TTL_MS}; };

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const buckets = new Map();
const checkRate = ip => {
  const now=Date.now(), e=buckets.get(ip)||{n:0,reset:now+60000};
  if(now>e.reset){e.n=0;e.reset=now+60000;}
  e.n++; buckets.set(ip,e); return e.n<=RATE_LIMIT;
};
setInterval(()=>{ const now=Date.now(); buckets.forEach((v,k)=>{if(now>v.reset+60000)buckets.delete(k);}); },300000);

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({origin:ALLOWED_ORIGIN==='*'?'*':ALLOWED_ORIGIN.split(','),methods:['GET','POST']}));
app.use(express.json({limit:'8kb'}));
app.use((req,res,next)=>{
  if(['/health','/'].includes(req.path)) return next();
  const ip=(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress;
  if(!checkRate(ip)) return res.status(429).json({error:`Rate limit: max ${RATE_LIMIT} req/min`});
  next();
});
app.use((req,res,next)=>{
  if(['/health','/'].includes(req.path)) return next();
  const key=req.headers['x-api-key']||req.query.apikey;
  if(!key||key!==API_KEY) return res.status(401).json({error:'Invalid or missing X-API-Key'});
  next();
});

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────
function fetchJSON(urlStr, opts={}, timeoutMs=10000) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const client = url.protocol==='https:'?https:http;
    const reqOpts = {
      hostname: url.hostname,
      port:     url.port||(url.protocol==='https:'?443:80),
      path:     url.pathname+url.search,
      method:   opts.method||'GET',
      headers:  {'Accept':'application/json','Content-Type':'application/json',...(opts.headers||{})},
      timeout:  timeoutMs,
    };
    const req = client.request(reqOpts, res=>{
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8');
        if(res.statusCode<200||res.statusCode>=300)
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,100)}`));
        try{resolve(JSON.parse(body));}
        catch{reject(new Error('Invalid JSON: '+body.slice(0,60)));}
      });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('Request timeout'));});
    if(opts.body){req.write(opts.body);}
    req.end();
  });
}

const safeNum=(v,d=4)=>v==null||!isFinite(Number(v))?null:+Number(v).toFixed(d);

// ─── SYMBOL NORMALIZATION ────────────────────────────────────────────────────
// Finnhub uses standard symbols for US stocks.
// For indices/FX/crypto it uses different endpoints.
const FINNHUB_EXCEPTIONS = {
  '^GSPC':'SPY',    // S&P500 → SPY ETF (Finnhub doesn't support ^GSPC quote)
  '^IXIC':'QQQ',    // NASDAQ → QQQ ETF
  '^VIX':'VIXY',    // VIX → VIXY ETF
  '^SET':'EEM',     // SET → EEM as proxy
  '^TNX':'TLT',     // 10Y Yield → TLT as proxy
  'THBX=X':'USD',   // handled separately via FX endpoint
  'DX-Y.NYB':'UUP', // DXY → UUP ETF
  'GC=F':'XAUUSD',  // Gold → will use crypto endpoint
  'BTC-USD':'BINANCE:BTCUSDT', // Crypto via exchange prefix
  'ETH-USD':'BINANCE:ETHUSDT',
};

// Map .BK Thai stocks for Finnhub — uses SET: prefix
function toFinnhubSym(sym) {
  if(FINNHUB_EXCEPTIONS[sym]) return FINNHUB_EXCEPTIONS[sym];
  if(sym.endsWith('.BK')) return 'SET:'+sym.replace('.BK','');
  return sym; // US stocks work directly
}

// ─── FINNHUB API ─────────────────────────────────────────────────────────────
const FH = 'https://finnhub.io/api/v1';

async function fhGet(path) {
  if(!FINNHUB_KEY) throw new Error('FINNHUB_KEY not configured');
  const sep = path.includes('?')?'&':'?';
  return fetchJSON(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {}, 8000);
}

async function finnhubQuote(sym) {
  const fSym = toFinnhubSym(sym);

  // Crypto symbols (BINANCE:BTCUSDT format)
  if(fSym.includes(':')) {
    const d = await fhGet(`/quote?symbol=${encodeURIComponent(fSym)}`);
    if(!d.c||d.c===0) throw new Error(`No price for ${fSym}`);
    const p=d.pc||d.c;
    return buildQuote(sym, sym, d.c, d.c-p, p?((d.c-p)/p)*100:0, null, null, d.h, d.l, d.o, d.h, d.l, p, null);
  }

  // FX rate via Finnhub forex
  if(sym==='THBX=X') {
    const d = await fhGet('/forex/rates?base=USD');
    const rate = d?.quote?.THB;
    if(!rate) throw new Error('No THB rate from Finnhub');
    return buildQuote('THBX=X','USD/THB',rate,0,0,null,null,rate,rate,rate,rate,rate,rate,'FX');
  }

  // Standard quote
  const [quote, profile] = await Promise.allSettled([
    fhGet(`/quote?symbol=${encodeURIComponent(fSym)}`),
    fhGet(`/stock/profile2?symbol=${encodeURIComponent(fSym)}`),
  ]);

  const d = quote.status==='fulfilled'?quote.value:{};
  const p2= profile.status==='fulfilled'?profile.value:{};

  if(!d.c||d.c===0) throw new Error(`Finnhub: no price for ${fSym} (mapped from ${sym})`);
  const prev=d.pc||d.c;

  return buildQuote(
    sym,
    p2.name||fSym,
    d.c, d.c-prev, prev?((d.c-prev)/prev)*100:0,
    d.v||null, null,
    d.h||null, d.l||null,
    d.o||null, d.h||null, d.l||null, prev,
    p2.finnhubIndustry||null,
    p2.marketCapitalization?p2.marketCapitalization*1e6:null,
    p2.currency||null,
    p2.exchange||null,
  );
}

function buildQuote(sym,name,price,chg,chgPct,vol,avgVol,hi52,lo52,open,dayHi,dayLo,prev,sector,mktCap,currency,exchange) {
  return {
    symbol:sym, shortName:name,
    regularMarketPrice:         safeNum(price,4),
    regularMarketChange:        safeNum(chg,4),
    regularMarketChangePercent: safeNum(chgPct,4),
    regularMarketVolume:        vol??null,
    averageVolume:              avgVol??null,
    fiftyTwoWeekHigh:           safeNum(hi52,4),
    fiftyTwoWeekLow:            safeNum(lo52,4),
    fiftyDayAverage:            null,
    twoHundredDayAverage:       null,
    trailingPE:                 null,
    marketCap:                  mktCap??null,
    regularMarketOpen:          safeNum(open,4),
    regularMarketDayHigh:       safeNum(dayHi,4),
    regularMarketDayLow:        safeNum(dayLo,4),
    regularMarketPreviousClose: safeNum(prev,4),
    currency:                   currency||null,
    exchangeName:               exchange||null,
    _src:'finnhub',
  };
}

// Finnhub candle data for charts
async function finnhubChart(sym, range) {
  const fSym = toFinnhubSym(sym);
  const now  = Math.floor(Date.now()/1000);
  const days = {'1d':2,'5d':7,'1mo':35,'3mo':95}[range]||35;
  const from = now - days*86400;
  const res  = range==='1d'?'60':'D'; // 60min for 1d, daily otherwise

  const d = await fhGet(`/stock/candle?symbol=${encodeURIComponent(fSym)}&resolution=${res}&from=${from}&to=${now}`);
  if(d.s==='no_data'||!d.t?.length) throw new Error(`Finnhub: no candle data for ${fSym}`);

  return {
    timestamps: d.t,
    closes:     d.c.map(v=>safeNum(v,4)),
    opens:      d.o.map(v=>safeNum(v,4)),
    highs:      d.h.map(v=>safeNum(v,4)),
    lows:       d.l.map(v=>safeNum(v,4)),
    volumes:    d.v||d.t.map(()=>null),
    count:      d.t.length,
    _src:'finnhub',
  };
}

// ─── RAPIDAPI FALLBACK ────────────────────────────────────────────────────────
async function rapidQuote(sym) {
  if(!RAPIDAPI_KEY) throw new Error('no RAPIDAPI_KEY');
  const d = await fetchJSON(
    `https://yahoo-finance15.p.rapidapi.com/api/v1/markets/stock/quotes?ticker=${encodeURIComponent(sym)}`,
    {headers:{'x-rapidapi-key':RAPIDAPI_KEY,'x-rapidapi-host':'yahoo-finance15.p.rapidapi.com'}}, 10000
  );
  const q=Array.isArray(d?.body)?d.body[0]:d?.quoteResponse?.result?.[0]||d?.data?.[0];
  if(!q?.regularMarketPrice) throw new Error(`RapidAPI: no price for ${sym}`);
  return {
    symbol:q.symbol||sym, shortName:q.shortName||sym,
    regularMarketPrice:safeNum(q.regularMarketPrice,4),
    regularMarketChange:safeNum(q.regularMarketChange,4),
    regularMarketChangePercent:safeNum(q.regularMarketChangePercent,4),
    regularMarketVolume:q.regularMarketVolume??null,
    averageVolume:q.averageDailyVolume3Month??null,
    fiftyTwoWeekHigh:safeNum(q.fiftyTwoWeekHigh,4),
    fiftyTwoWeekLow:safeNum(q.fiftyTwoWeekLow,4),
    fiftyDayAverage:safeNum(q.fiftyDayAverage,4),
    twoHundredDayAverage:safeNum(q.twoHundredDayAverage,4),
    trailingPE:safeNum(q.trailingPE,2), marketCap:q.marketCap??null,
    regularMarketOpen:safeNum(q.regularMarketOpen,4),
    regularMarketDayHigh:safeNum(q.regularMarketDayHigh,4),
    regularMarketDayLow:safeNum(q.regularMarketDayLow,4),
    regularMarketPreviousClose:safeNum(q.regularMarketPreviousClose,4),
    currency:q.currency??null, exchangeName:q.fullExchangeName??null,
    _src:'rapidapi',
  };
}

// ─── MULTI-SOURCE ─────────────────────────────────────────────────────────────
async function getQuote(sym) {
  const errs=[];
  if(FINNHUB_KEY){ try{return await finnhubQuote(sym);}catch(e){errs.push('fh:'+e.message);} }
  if(RAPIDAPI_KEY){try{return await rapidQuote(sym);}catch(e){errs.push('rapid:'+e.message);} }
  throw new Error(`[${sym}] ${errs.join(' | ')||'No API keys configured. Add FINNHUB_KEY to Railway Variables.'}`);
}

async function getChart(sym, range) {
  if(FINNHUB_KEY){ try{return await finnhubChart(sym,range);}catch(e){console.warn('[chart fh]',sym,e.message);} }
  throw new Error(`No chart data for ${sym}. Ensure FINNHUB_KEY is set.`);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health',(req,res)=>{
  const fhOk = !!FINNHUB_KEY;
  res.status(200).json({
    status:'ok',
    uptime:Math.round(process.uptime())+'s',
    cache:cStats(),
    version:'7.0.0',
    keys:{
      finnhub:  fhOk?'✅ configured':'❌ MISSING — add FINNHUB_KEY to Railway Variables',
      rapidapi: RAPIDAPI_KEY?'✅ configured':'— optional',
      anthropic:ANTHROPIC_KEY?'✅ configured':'— add ANTHROPIC_KEY for AI',
    },
    ready: fhOk,
    time:new Date().toISOString(),
  });
});

app.get('/',(req,res)=>res.json({
  name:'TradeRadar API v7', version:'7.0.0',
  primarySource:'Finnhub (free 60 req/min, Railway-compatible)',
  setup:'Set FINNHUB_KEY in Railway Variables (free at finnhub.io)',
  endpoints:{
    'GET  /health':'Server + key status',
    'GET  /api/quote?symbols=AAPL,GC=F':'Stock quotes',
    'GET  /api/spark?symbol=AAPL&range=1mo':'OHLCV chart',
    'GET  /api/search?q=apple':'Symbol search',
    'GET  /api/fear-greed':'Fear & Greed index',
    'GET  /api/fx?from=USD&to=THB':'FX rate',
    'POST /api/ai':'Claude AI proxy',
    'GET  /api/cache/clear':'Clear cache',
  },
}));

// GET /api/quote
app.get('/api/quote', async(req,res)=>{
  if(!FINNHUB_KEY && !RAPIDAPI_KEY)
    return res.status(503).json({error:'No API keys configured. Add FINNHUB_KEY to Railway Variables (free at finnhub.io).'});

  const raw = req.query.symbols||req.query.symbol||'';
  if(!raw) return res.status(400).json({error:'symbols param required'});
  const syms = raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,20);

  const ck='quote:'+syms.join(',');
  const hit=getC(ck);
  if(hit) return res.json({ok:true,cached:true,count:hit.length,quotes:hit,ts:Date.now()});

  const results = await Promise.allSettled(syms.map(s=>getQuote(s)));
  const quotes  = results.map((r,i)=>r.status==='fulfilled'?r.value:null).filter(Boolean);
  const failed  = results.map((r,i)=>r.status==='rejected'?{sym:syms[i],err:r.reason?.message}:null).filter(Boolean);
  if(failed.length) console.warn('[quote] partial fail:',failed.map(f=>f.sym).join(','));

  if(!quotes.length) return res.status(502).json({
    error:'No quotes returned.',
    hint:'Ensure FINNHUB_KEY is set in Railway Variables.',
    failed,
  });

  setC(ck,quotes);
  res.json({ok:true,cached:false,count:quotes.length,quotes,failed,ts:Date.now()});
});

// GET /api/spark
app.get('/api/spark', async(req,res)=>{
  const sym   = (req.query.symbol||'').trim().toUpperCase();
  const range = ['1d','5d','1mo','3mo'].includes(req.query.range)?req.query.range:'1mo';
  if(!sym) return res.status(400).json({error:'symbol param required'});

  const ck=`spark:${sym}:${range}`;
  const hit=getC(ck);
  if(hit) return res.json({ok:true,cached:true,...hit});

  try{
    const data=await getChart(sym,range);
    setC(ck,data);
    res.json({ok:true,cached:false,symbol:sym,range,...data});
  }catch(e){
    res.status(502).json({error:e.message});
  }
});

// GET /api/search
app.get('/api/search', async(req,res)=>{
  const q=(req.query.q||'').trim();
  if(!q) return res.status(400).json({error:'q param required'});
  const uq=q.toUpperCase();

  const KNOWN=[
    {symbol:'AAPL',shortname:'Apple Inc.',type:'US Stock'},
    {symbol:'NVDA',shortname:'NVIDIA Corp.',type:'US Stock'},
    {symbol:'TSLA',shortname:'Tesla Inc.',type:'US Stock'},
    {symbol:'MSFT',shortname:'Microsoft Corp.',type:'US Stock'},
    {symbol:'AMZN',shortname:'Amazon.com',type:'US Stock'},
    {symbol:'META',shortname:'Meta Platforms',type:'US Stock'},
    {symbol:'GOOGL',shortname:'Alphabet Inc.',type:'US Stock'},
    {symbol:'GC=F',shortname:'Gold Futures',type:'Futures'},
    {symbol:'XAUUSD',shortname:'Gold Spot USD',type:'Commodity'},
    {symbol:'BTC-USD',shortname:'Bitcoin / USD',type:'Crypto'},
    {symbol:'ETH-USD',shortname:'Ethereum / USD',type:'Crypto'},
    {symbol:'PTT.BK',shortname:'บมจ. ปตท.',type:'TH Stock'},
    {symbol:'CPALL.BK',shortname:'บมจ. ซีพี ออลล์',type:'TH Stock'},
    {symbol:'KBANK.BK',shortname:'บมจ. กสิกรไทย',type:'TH Stock'},
    {symbol:'ADVANC.BK',shortname:'บมจ. แอดวานซ์ อินโฟ',type:'TH Stock'},
    {symbol:'AOT.BK',shortname:'บมจ. ท่าอากาศยาน',type:'TH Stock'},
    {symbol:'^GSPC',shortname:'S&P 500',type:'Index'},
    {symbol:'^VIX',shortname:'CBOE VIX',type:'Index'},
    {symbol:'SPY',shortname:'S&P 500 ETF',type:'ETF'},
    {symbol:'GLD',shortname:'Gold ETF',type:'ETF'},
    {symbol:'QQQ',shortname:'NASDAQ ETF',type:'ETF'},
    {symbol:'THBX=X',shortname:'USD/THB Rate',type:'FX'},
  ];

  let matches=KNOWN.filter(s=>s.symbol.includes(uq)||s.shortname.toUpperCase().includes(uq));

  if(FINNHUB_KEY && matches.length<4){
    try{
      const d=await fhGet(`/search?q=${encodeURIComponent(q)}`);
      const seen=new Set(matches.map(m=>m.symbol));
      (d.result||[]).slice(0,5).filter(r=>!seen.has(r.symbol)&&r.type!=='').forEach(r=>
        matches.push({symbol:r.symbol,shortname:r.description||r.symbol,type:r.type||'Stock'})
      );
    }catch{}
  }

  res.json({ok:true,quotes:matches.slice(0,8)});
});

// GET /api/fear-greed
app.get('/api/fear-greed', async(req,res)=>{
  const hit=getC('fng');
  if(hit) return res.json({ok:true,cached:true,...hit});
  try{
    const d=await fetchJSON('https://api.alternative.me/fng/?limit=1&format=json',{},8000);
    const item=d?.data?.[0]; if(!item) throw new Error('No data');
    const p={value:parseInt(item.value),classification:item.value_classification,timestamp:item.timestamp};
    setC('fng',p,4*3600*1000);
    res.json({ok:true,cached:false,...p});
  }catch(e){ res.status(502).json({error:e.message}); }
});

// GET /api/fx
app.get('/api/fx', async(req,res)=>{
  const from=(req.query.from||'USD').toUpperCase().slice(0,3);
  const to  =(req.query.to  ||'THB').toUpperCase().slice(0,3);
  const ck=`fx:${from}:${to}`;
  const hit=getC(ck);
  if(hit) return res.json({ok:true,cached:true,from,to,...hit});

  // Try Finnhub forex first, then Frankfurter
  let rate=null, date=null;
  if(FINNHUB_KEY){
    try{
      const d=await fhGet(`/forex/rates?base=${from}`);
      if(d?.quote?.[to]){rate=d.quote[to];date=new Date().toISOString().slice(0,10);}
    }catch{}
  }
  if(!rate){
    try{
      const d=await fetchJSON(`https://api.frankfurter.app/latest?from=${from}&to=${to}`,{},8000);
      rate=d?.rates?.[to]; date=d?.date;
    }catch{}
  }

  if(!rate) return res.status(502).json({error:`No rate for ${from}/${to}`});
  const p={rate,date};
  setC(ck,p,3600*1000);
  res.json({ok:true,cached:false,from,to,...p});
});

// POST /api/ai — Claude proxy (fixes browser CORS)
app.post('/api/ai', async(req,res)=>{
  if(!ANTHROPIC_KEY)
    return res.status(503).json({error:'ANTHROPIC_KEY not set. Add it to Railway Variables (get from console.anthropic.com → API Keys).'});

  const {messages,max_tokens=1000,system}=req.body||{};
  if(!messages?.length) return res.status(400).json({error:'messages array required'});

  try{
    const body=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens,messages,...(system&&{system})});
    const d=await new Promise((resolve,reject)=>{
      const r=https.request({
        hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',
        headers:{
          'Content-Type':'application/json',
          'x-api-key':ANTHROPIC_KEY,
          'anthropic-version':'2023-06-01',
          'Content-Length':Buffer.byteLength(body),
        },
        timeout:35000,
      },resp=>{
        const chunks=[];
        resp.on('data',c=>chunks.push(c));
        resp.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(e){reject(e);}});
      });
      r.on('error',reject);
      r.on('timeout',()=>{r.destroy();reject(new Error('Anthropic timeout'));});
      r.write(body); r.end();
    });
    if(d.error) return res.status(502).json({error:d.error.message});
    res.json({ok:true,content:d.content,usage:d.usage,model:d.model});
  }catch(e){
    console.error('[ai]',e.message);
    res.status(502).json({error:e.message});
  }
});

// GET /api/cache/clear
app.get('/api/cache/clear',(req,res)=>{const n=cache.size;cache.clear();res.json({ok:true,cleared:n});});

app.use((req,res)=>res.status(404).json({error:'Not found. See GET /'}));
app.use((err,req,res,_n)=>{console.error('[ERR]',err.message);res.status(500).json({error:'Internal error'});});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, ()=>{
  const c=CACHE_TTL_MS<60000?(CACHE_TTL_MS/1000+'s'):(CACHE_TTL_MS/60000+'m');
  const fhStatus = FINNHUB_KEY ? '✅ configured' : '❌ MISSING — get free key at finnhub.io';
  console.log([
    '╔════════════════════════════════════════╗',
    '║    TradeRadar API Server v7.0          ║',
    '╠════════════════════════════════════════╣',
    '║  Port     : '+String(PORT).padEnd(27)+'║',
    '║  Cache    : '+c.padEnd(27)+'║',
    '║  Finnhub  : '+fhStatus.padEnd(27)+'║',
    '║  AI Proxy : '+(ANTHROPIC_KEY?'✅ ready':'⚠️  add ANTHROPIC_KEY').padEnd(27)+'║',
    '║  RapidAPI : '+(RAPIDAPI_KEY?'✅ configured':'— optional').padEnd(27)+'║',
    '╚════════════════════════════════════════╝',
  ].join('\n'));

  if(!FINNHUB_KEY) {
    console.error('⛔ FINNHUB_KEY is not set! All quote requests will fail.');
    console.error('   1. Go to https://finnhub.io → Sign up free');
    console.error('   2. Dashboard → API Keys → copy your key');
    console.error('   3. Railway → Variables → add FINNHUB_KEY=your_key');
  }
});
