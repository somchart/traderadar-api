// TradeRadar API v6.0 — ESM, Railway-compatible
// NEW: /api/ai endpoint proxies Claude AI (fixes CORS from browser)
// Data: Stooq CSV (free) → Finnhub (free key) → RapidAPI (free key)
// "type":"module" in package.json required

import express  from 'express';
import cors     from 'cors';
import helmet   from 'helmet';
import https    from 'https';
import http     from 'http';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_KEY        = process.env.API_KEY        || 'change-me-in-env';
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS || '60000');
const RATE_LIMIT     = parseInt(process.env.RATE_LIMIT   || '120');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RAPIDAPI_KEY   = process.env.RAPIDAPI_KEY   || '';
const FINNHUB_KEY    = process.env.FINNHUB_KEY    || '';
// Claude API key — only needed if using /api/ai proxy
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';

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
  if(['/health','/'].includes(req.path))return next();
  const ip=(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress;
  if(!checkRate(ip))return res.status(429).json({error:`Rate limit: max ${RATE_LIMIT} req/min`});
  next();
});
app.use((req,res,next)=>{
  if(['/health','/'].includes(req.path))return next();
  const key=req.headers['x-api-key']||req.query.apikey;
  if(!key||key!==API_KEY)return res.status(401).json({error:'Missing or invalid X-API-Key'});
  next();
});

// ─── FETCH HELPERS ────────────────────────────────────────────────────────────
function fetchURL(urlStr, opts={}, timeoutMs=10000) {
  return new Promise((resolve,reject) => {
    const url    = new URL(urlStr);
    const client = url.protocol==='https:'?https:http;
    const req = client.request({
      hostname: url.hostname,
      port:     url.port||(url.protocol==='https:'?443:80),
      path:     url.pathname+url.search,
      method:   opts.method||'GET',
      headers:  { 'User-Agent':'TradeRadar/6.0','Accept':'*/*', ...(opts.headers||{}) },
      timeout:  timeoutMs,
    }, res => {
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8');
        if(res.statusCode<200||res.statusCode>=300)
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,80)}`));
        try   { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
    if(opts.body) req.write(opts.body);
    req.end();
  });
}

function simpleGet(url){ return fetchURL(url,{},8000); }

// ─── SYMBOL MAPPING ───────────────────────────────────────────────────────────
// Maps frontend symbols → Stooq symbols
const STOOQ_MAP = {
  'GC=F':'gc.f', 'GC.F':'gc.f', 'CL=F':'cl.f',
  'BTC-USD':'btc.v', 'ETH-USD':'eth.v',
  '^GSPC':'^spx', '^IXIC':'^ndx', '^VIX':'^vix',
  '^SET':'^tbk',   // Thai SET index on Stooq
  'THBX=X':'usdthb.fx', 'DX-Y.NYB':'usdx.fx',
  '^TNX':'tnx.us',
  'SPY':'spy.us','QQQ':'qqq.us','GLD':'gld.us',
  'AMZN':'amzn.us','META':'meta.us','GOOGL':'googl.us',
  'MSFT':'msft.us','AAPL':'aapl.us','NVDA':'nvda.us',
  'TSLA':'tsla.us','BRK.B':'brkb.us',
};
function toStooq(sym) {
  if(STOOQ_MAP[sym]) return STOOQ_MAP[sym];
  if(sym.endsWith('.BK')) return sym.replace('.BK','.th').toLowerCase();
  if(/^[A-Z]{1,5}$/.test(sym)) return sym.toLowerCase()+'.us';
  return sym.toLowerCase();
}

const safeNum=(v,d=4)=>v==null||!isFinite(Number(v))?null:+Number(v).toFixed(d);

// ─── SOURCE: Stooq ────────────────────────────────────────────────────────────
async function fetchStooqCSV(stSym) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stSym)}&i=d`;
  const body = await fetchURL(url, { headers:{'Referer':'https://stooq.com/','Accept':'text/csv,text/plain'} }, 10000);
  const text = typeof body==='string' ? body : '';
  if(!text || text.startsWith('<') || text.toLowerCase().includes('no data') || text.toLowerCase().includes('oops'))
    throw new Error(`Stooq: no data for ${stSym}`);
  const lines = text.trim().split('\n').filter(l=>l&&!l.toLowerCase().startsWith('date'));
  if(!lines.length) throw new Error(`Stooq: empty for ${stSym}`);
  return lines;
}

async function stooqQuote(sym) {
  const lines = await fetchStooqCSV(toStooq(sym));
  const [,open,high,low,close,vol] = lines[lines.length-1].split(',');
  const prevClose = lines.length>1 ? parseFloat(lines[lines.length-2].split(',')[4]) : null;
  const c = parseFloat(close), p = prevClose||c;
  if(isNaN(c)) throw new Error(`Stooq: bad price for ${sym}`);
  return {
    symbol:sym, shortName:sym,
    regularMarketPrice:safeNum(c,4),
    regularMarketChange:safeNum(c-p,4),
    regularMarketChangePercent:safeNum(p?((c-p)/p)*100:0,4),
    regularMarketVolume:vol?parseInt(vol):null, averageVolume:null,
    fiftyTwoWeekHigh:safeNum(high,4), fiftyTwoWeekLow:safeNum(low,4),
    fiftyDayAverage:null, twoHundredDayAverage:null,
    trailingPE:null, marketCap:null,
    regularMarketOpen:safeNum(open,4),
    regularMarketDayHigh:safeNum(high,4), regularMarketDayLow:safeNum(low,4),
    regularMarketPreviousClose:safeNum(p,4),
    currency: sym.endsWith('.BK')||sym.endsWith('.TH')?'THB':'USD',
    _src:'stooq',
  };
}

async function stooqChart(sym, days=30) {
  const lines = await fetchStooqCSV(toStooq(sym));
  const take  = Math.min(lines.length, Math.max(days*2, 30));
  const rows  = lines.slice(-take).map(l=>{
    const [date,open,high,low,close,vol] = l.split(',');
    return { ts:Math.floor(new Date(date?.trim()).getTime()/1000),
      o:safeNum(open,4), h:safeNum(high,4), l:safeNum(low,4),
      c:safeNum(close,4), v:vol?parseInt(vol):null };
  }).filter(r=>r.c!=null&&!isNaN(r.ts)&&r.ts>0);
  if(!rows.length) throw new Error(`Stooq chart: no rows for ${sym}`);
  return { timestamps:rows.map(r=>r.ts), closes:rows.map(r=>r.c), opens:rows.map(r=>r.o),
    highs:rows.map(r=>r.h), lows:rows.map(r=>r.l), volumes:rows.map(r=>r.v),
    count:rows.length, _src:'stooq' };
}

// ─── SOURCE: Finnhub ──────────────────────────────────────────────────────────
async function finnhubQuote(sym) {
  if(!FINNHUB_KEY) throw new Error('no FINNHUB_KEY');
  const fSym = sym.replace('.BK',''); // Finnhub uses plain symbols
  const d = await fetchURL(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(fSym)}&token=${FINNHUB_KEY}`,{},8000);
  if(!d.c||d.c===0) throw new Error(`Finnhub: no price for ${fSym}`);
  const p=d.pc||d.c;
  return {
    symbol:sym, shortName:sym,
    regularMarketPrice:safeNum(d.c,4),
    regularMarketChange:safeNum(d.c-p,4),
    regularMarketChangePercent:safeNum(p?((d.c-p)/p)*100:0,4),
    regularMarketVolume:null, averageVolume:null,
    fiftyTwoWeekHigh:safeNum(d.h,4), fiftyTwoWeekLow:safeNum(d.l,4),
    fiftyDayAverage:null, twoHundredDayAverage:null,
    trailingPE:null, marketCap:null,
    regularMarketOpen:safeNum(d.o,4),
    regularMarketDayHigh:safeNum(d.h,4), regularMarketDayLow:safeNum(d.l,4),
    regularMarketPreviousClose:safeNum(p,4),
    _src:'finnhub',
  };
}

// ─── SOURCE: RapidAPI Yahoo Finance ──────────────────────────────────────────
async function rapidQuote(sym) {
  if(!RAPIDAPI_KEY) throw new Error('no RAPIDAPI_KEY');
  const d = await fetchURL(
    `https://yahoo-finance15.p.rapidapi.com/api/v1/markets/stock/quotes?ticker=${encodeURIComponent(sym)}`,
    { headers:{'x-rapidapi-key':RAPIDAPI_KEY,'x-rapidapi-host':'yahoo-finance15.p.rapidapi.com'} }, 10000
  );
  const q = Array.isArray(d?.body)?d.body[0]:d?.quoteResponse?.result?.[0]||d?.data?.[0];
  if(!q?.regularMarketPrice) throw new Error(`RapidAPI: no price for ${sym}`);
  return {
    symbol:q.symbol||sym, shortName:q.shortName||q.displayName||sym,
    regularMarketPrice:safeNum(q.regularMarketPrice,4),
    regularMarketChange:safeNum(q.regularMarketChange,4),
    regularMarketChangePercent:safeNum(q.regularMarketChangePercent,4),
    regularMarketVolume:q.regularMarketVolume??null,
    averageVolume:q.averageDailyVolume3Month??q.averageVolume??null,
    fiftyTwoWeekHigh:safeNum(q.fiftyTwoWeekHigh,4), fiftyTwoWeekLow:safeNum(q.fiftyTwoWeekLow,4),
    fiftyDayAverage:safeNum(q.fiftyDayAverage,4), twoHundredDayAverage:safeNum(q.twoHundredDayAverage,4),
    trailingPE:safeNum(q.trailingPE,2), marketCap:q.marketCap??null,
    regularMarketOpen:safeNum(q.regularMarketOpen,4),
    regularMarketDayHigh:safeNum(q.regularMarketDayHigh,4), regularMarketDayLow:safeNum(q.regularMarketDayLow,4),
    regularMarketPreviousClose:safeNum(q.regularMarketPreviousClose,4),
    currency:q.currency??null, exchangeName:q.fullExchangeName??null,
    _src:'rapidapi',
  };
}

// ─── MULTI-SOURCE FALLBACK ────────────────────────────────────────────────────
async function getQuote(sym) {
  const errs = [];
  // 1. RapidAPI (most data fields)
  if(RAPIDAPI_KEY){ try{return await rapidQuote(sym);}catch(e){errs.push('rapid:'+e.message);} }
  // 2. Finnhub (reliable, realtime)
  if(FINNHUB_KEY){ try{return await finnhubQuote(sym);}catch(e){errs.push('finnhub:'+e.message);} }
  // 3. Stooq (always free, EOD data)
  try{return await stooqQuote(sym);}catch(e){errs.push('stooq:'+e.message);}
  throw new Error(`[${sym}] all sources failed: ${errs.join(' | ')}`);
}

async function getChart(sym, range) {
  const days = {'1d':2,'5d':7,'1mo':35,'3mo':95}[range]||35;
  // 1. Stooq daily chart (always works for EOD)
  try{return await stooqChart(sym,days);}catch(e){
    console.warn('[chart] stooq failed:',e.message);
  }
  throw new Error(`Chart unavailable for ${sym}`);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// GET /health — responds instantly, no async
app.get('/health',(req,res)=>{
  res.status(200).json({
    status:'ok', uptime:Math.round(process.uptime())+'s',
    cache:cStats(), version:'6.0.0',
    sources:{ stooq:'always', finnhub:FINNHUB_KEY?'configured':'not set',
              rapidapi:RAPIDAPI_KEY?'configured':'not set', ai:ANTHROPIC_KEY?'configured':'not set' },
    time:new Date().toISOString(),
  });
});

// GET /
app.get('/',(req,res)=>res.json({
  name:'TradeRadar API v6', version:'6.0.0',
  endpoints:{
    'GET  /health':'Server status',
    'GET  /api/quote?symbols=AAPL,GC=F':'Stock quotes (multi-source)',
    'GET  /api/spark?symbol=AAPL&range=1mo':'Chart OHLCV data',
    'GET  /api/search?q=apple':'Symbol search',
    'GET  /api/fear-greed':'Fear & Greed index',
    'GET  /api/fx?from=USD&to=THB':'FX rate',
    'POST /api/ai':'Claude AI proxy (fixes browser CORS)',
    'GET  /api/cache/clear':'Clear cache',
  },
}));

// GET /api/quote
app.get('/api/quote', async(req,res)=>{
  const raw = req.query.symbols||req.query.symbol||'';
  if(!raw) return res.status(400).json({error:'symbols param required'});
  const syms = raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,20);

  const cacheKey='quote:'+syms.join(',');
  const hit=getC(cacheKey);
  if(hit) return res.json({ok:true,cached:true,count:hit.length,quotes:hit,ts:Date.now()});

  const results = await Promise.allSettled(syms.map(s=>getQuote(s)));
  const quotes  = results.map((r,i)=>r.status==='fulfilled'?r.value:null).filter(Boolean);

  const failed  = results.map((r,i)=>r.status==='rejected'?{sym:syms[i],err:r.reason?.message}:null).filter(Boolean);
  if(failed.length) console.warn('[quote] failed:',failed.map(f=>`${f.sym}:${f.err}`).join(', '));

  if(!quotes.length) return res.status(502).json({
    error:'No quotes returned. Add FINNHUB_KEY or RAPIDAPI_KEY to Railway Variables.',
    failed,
  });

  setC(cacheKey,quotes);
  res.json({ok:true,cached:false,count:quotes.length,quotes,failed,ts:Date.now()});
});

// GET /api/spark
app.get('/api/spark', async(req,res)=>{
  const sym   = (req.query.symbol||'').trim().toUpperCase();
  const range = ['1d','5d','1mo','3mo'].includes(req.query.range)?req.query.range:'1mo';
  if(!sym) return res.status(400).json({error:'symbol param required'});

  const cacheKey=`spark:${sym}:${range}`;
  const hit=getC(cacheKey);
  if(hit) return res.json({ok:true,cached:true,...hit});

  try{
    const data = await getChart(sym,range);
    setC(cacheKey,data);
    res.json({ok:true,cached:false,symbol:sym,range,...data});
  }catch(e){
    console.error('[spark]',sym,e.message);
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
    {symbol:'BTC-USD',shortname:'Bitcoin / USD',type:'Crypto'},
    {symbol:'ETH-USD',shortname:'Ethereum / USD',type:'Crypto'},
    {symbol:'PTT.BK',shortname:'บมจ. ปตท.',type:'TH Stock'},
    {symbol:'CPALL.BK',shortname:'บมจ. ซีพี ออลล์',type:'TH Stock'},
    {symbol:'KBANK.BK',shortname:'บมจ. กสิกรไทย',type:'TH Stock'},
    {symbol:'ADVANC.BK',shortname:'บมจ. แอดวานซ์ อินโฟ',type:'TH Stock'},
    {symbol:'AOT.BK',shortname:'บมจ. ท่าอากาศยาน',type:'TH Stock'},
    {symbol:'^GSPC',shortname:'S&P 500',type:'Index'},
    {symbol:'^SET',shortname:'SET Index',type:'Index'},
    {symbol:'^VIX',shortname:'VIX Volatility',type:'Index'},
    {symbol:'SPY',shortname:'S&P 500 ETF',type:'ETF'},
    {symbol:'GLD',shortname:'Gold ETF',type:'ETF'},
    {symbol:'THBX=X',shortname:'USD/THB Rate',type:'FX'},
  ];
  let matches = KNOWN.filter(s=>s.symbol.includes(uq)||s.shortname.toUpperCase().includes(uq));

  if(FINNHUB_KEY && matches.length<4){
    try{
      const d=await fetchURL(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`,{},6000);
      const seen=new Set(matches.map(m=>m.symbol));
      (d.result||[]).slice(0,5).filter(r=>!seen.has(r.symbol)).forEach(r=>matches.push({
        symbol:r.symbol, shortname:r.description||r.symbol, type:r.type||'Stock', exchange:r.primaryExchange
      }));
    }catch{}
  }

  res.json({ok:true,quotes:matches.slice(0,8)});
});

// GET /api/fear-greed
app.get('/api/fear-greed', async(req,res)=>{
  const hit=getC('fng');
  if(hit) return res.json({ok:true,cached:true,...hit});
  try{
    const d=await simpleGet('https://api.alternative.me/fng/?limit=1&format=json');
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
  try{
    const d=await simpleGet(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    const rate=d?.rates?.[to]; if(!rate) throw new Error(`No rate ${from}→${to}`);
    const p={rate,date:d.date};
    setC(ck,p,3600*1000);
    res.json({ok:true,cached:false,from,to,...p});
  }catch(e){ res.status(502).json({error:e.message}); }
});

// POST /api/ai — Claude AI proxy (fixes browser CORS)
// Body: { messages:[...], max_tokens:1000, system:"..." }
app.post('/api/ai', async(req,res)=>{
  if(!ANTHROPIC_KEY){
    return res.status(503).json({error:'ANTHROPIC_KEY not configured on server. Add it to Railway Variables.'});
  }
  const { messages, max_tokens=1000, system } = req.body||{};
  if(!messages?.length) return res.status(400).json({error:'messages array required'});

  try{
    const body = JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens,
      messages,
      ...(system && {system}),
    });

    const d = await new Promise((resolve,reject)=>{
      const req2 = https.request({
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers:  {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length':    Buffer.byteLength(body),
        },
        timeout: 30000,
      }, resp=>{
        const chunks=[];
        resp.on('data',c=>chunks.push(c));
        resp.on('end',()=>{
          const text=Buffer.concat(chunks).toString('utf8');
          try{ resolve(JSON.parse(text)); }
          catch{ reject(new Error('Invalid JSON from Anthropic: '+text.slice(0,80))); }
        });
      });
      req2.on('error',reject);
      req2.on('timeout',()=>{req2.destroy();reject(new Error('Anthropic timeout'));});
      req2.write(body);
      req2.end();
    });

    if(d.error) return res.status(502).json({error:d.error.message||'Anthropic error'});
    res.json({ok:true, content:d.content, usage:d.usage, model:d.model});

  }catch(e){
    console.error('[ai]',e.message);
    res.status(502).json({error:e.message});
  }
});

// GET /api/cache/clear
app.get('/api/cache/clear',(req,res)=>{ const n=cache.size; cache.clear(); res.json({ok:true,cleared:n}); });

app.use((req,res)=>res.status(404).json({error:'Not found. See GET /'}));
app.use((err,req,res,_n)=>{ console.error('[ERR]',err.message); res.status(500).json({error:'Internal error'}); });

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, ()=>{
  const c=CACHE_TTL_MS<60000?(CACHE_TTL_MS/1000+'s'):(CACHE_TTL_MS/60000+'m');
  console.log([
    '╔════════════════════════════════════════╗',
    '║    TradeRadar API Server v6.0          ║',
    '╠════════════════════════════════════════╣',
    '║  Port  : '+String(PORT).padEnd(29)+'║',
    '║  Cache : '+c.padEnd(29)+'║',
    '║  AI    : '+(ANTHROPIC_KEY?'✅ proxy ready':'⚠️  set ANTHROPIC_KEY').padEnd(29)+'║',
    '║  Stooq : ✅ always on                 ║',
    '║  Rapid : '+(RAPIDAPI_KEY?'✅ configured':'— not set (optional)').padEnd(29)+'║',
    '║  Finn  : '+(FINNHUB_KEY ?'✅ configured':'— not set (optional)').padEnd(29)+'║',
    '╚════════════════════════════════════════╝',
  ].join('\n'));
});
