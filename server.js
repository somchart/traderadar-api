// TradeRadar API Server v3.0 — ESM, Node 18+, yahoo-finance2 latest
// "type":"module" in package.json means this file is treated as ES Module

import express  from 'express';
import cors     from 'cors';
import helmet   from 'helmet';
import https    from 'https';
import { createRequire } from 'module';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_KEY       = process.env.API_KEY      || 'change-me-in-env';
const CACHE_TTL_MS  = parseInt(process.env.CACHE_TTL_MS || '60000');
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT   || '120');
const ALLOWED_ORIGIN= process.env.ALLOWED_ORIGIN || '*';

// ─── YAHOO FINANCE — dynamic ESM import ──────────────────────────────────────
// yahoo-finance2 v2.9+ is ESM-only. On Node 22 with "type":"module", we use
// top-level dynamic import(). The server starts listening FIRST, then yf loads.
let yf      = null;
let yfReady = false;
let yfError = null;

async function loadYF() {
  try {
    const mod = await import('yahoo-finance2');
    yf = mod.default;
    yf.setGlobalConfig({ validation: { logErrors: false } });
    yfReady = true;
    console.log('[yf] yahoo-finance2 loaded OK');
  } catch (e) {
    yfError = e.message;
    console.error('[yf] load failed:', e.message);
  }
}

function getYF() {
  if (!yfReady) throw new Error('yahoo-finance2 not ready' + (yfError ? ': ' + yfError : ' — try again in a moment'));
  return yf;
}

// ─── CACHE ───────────────────────────────────────────────────────────────────
const cache = new Map();
function getCache(k)       { const e=cache.get(k); if(!e)return null; if(Date.now()>e.exp){cache.delete(k);return null;} return e.data; }
function setCache(k,d,ttl=CACHE_TTL_MS) { cache.set(k,{data:d,exp:Date.now()+ttl}); }
function cacheStats()      { let v=0; const now=Date.now(); cache.forEach(e=>{if(now<e.exp)v++;}); return {total:cache.size,valid:v,ttl_ms:CACHE_TTL_MS}; }

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const buckets = new Map();
function checkRate(ip) {
  const now=Date.now(), e=buckets.get(ip)||{n:0,reset:now+60000};
  if(now>e.reset){e.n=0;e.reset=now+60000;}
  e.n++; buckets.set(ip,e); return e.n<=RATE_LIMIT;
}
setInterval(()=>{ const now=Date.now(); buckets.forEach((v,k)=>{if(now>v.reset+60000)buckets.delete(k);}); },300000);

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({ origin: ALLOWED_ORIGIN==='*'?'*':ALLOWED_ORIGIN.split(','), methods:['GET'] }));

app.use((req,res,next)=>{
  if(req.path==='/health'||req.path==='/')return next();
  const ip=(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress;
  if(!checkRate(ip))return res.status(429).json({error:`Rate limit: max ${RATE_LIMIT} req/min`});
  next();
});

app.use((req,res,next)=>{
  if(req.path==='/health'||req.path==='/')return next();
  const key=req.headers['x-api-key']||req.query.apikey;
  if(!key||key!==API_KEY)return res.status(401).json({error:'Invalid or missing X-API-Key header'});
  next();
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const safeNum=(v,d=4)=>v==null||!isFinite(v)?null:+Number(v).toFixed(d);

function fetchPlain(url, timeoutMs=8000) {
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'TradeRadar/3.0','Accept':'application/json'},timeout:timeoutMs},(r)=>{
      let body=''; r.setEncoding('utf8'); r.on('data',c=>body+=c);
      r.on('end',()=>{ try{resolve(JSON.parse(body));}catch(e){reject(e);} });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// GET /health — synchronous, no yf dependency, responds in <1ms
app.get('/health',(req,res)=>{
  res.status(200).json({
    status:'ok', uptime:Math.round(process.uptime())+'s',
    cache:cacheStats(), version:'3.0.0',
    yf: yfReady?'ready': yfError?'error: '+yfError:'loading',
    time:new Date().toISOString(),
  });
});

// GET /
app.get('/',(req,res)=>{
  res.json({
    name:'TradeRadar API v3', version:'3.0.0',
    runtime:`Node ${process.version}`, type:'ESM',
    auth:'X-API-Key header on all /api/* endpoints',
    endpoints:{
      '/health':                        'Server health (no auth)',
      '/api/quote?symbols=AAPL,GC=F':  'Quotes (max 20 symbols)',
      '/api/spark?symbol=AAPL':        'Intraday chart (range: 1d 5d 1mo | interval: 1m 5m 15m 60m)',
      '/api/search?q=apple':           'Symbol search',
      '/api/fear-greed':               'Crypto Fear & Greed Index',
      '/api/fx?from=USD&to=THB':       'Exchange rate',
      '/api/cache/clear':              'Clear cache',
    },
  });
});

// GET /api/quote
app.get('/api/quote', async(req,res)=>{
  const raw=req.query.symbols||req.query.symbol||'';
  if(!raw)return res.status(400).json({error:'symbols param required. Example: ?symbols=AAPL,PTT.BK,GC=F'});
  const syms=raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
  if(syms.length>20)return res.status(400).json({error:'Max 20 symbols'});

  const cacheKey='quote:'+syms.join(',');
  const hit=getCache(cacheKey);
  if(hit)return res.json({ok:true,cached:true,count:hit.length,quotes:hit,timestamp:new Date().toISOString()});

  try {
    const yfInst=getYF();
    const results=await Promise.allSettled(syms.map(s=>yfInst.quote(s,{},{validateResult:false})));
    const quotes=results.map((r,i)=>{
      if(r.status==='rejected')return null;
      const q=r.value||{};
      return {
        symbol:                     q.symbol||syms[i],
        shortName:                  q.shortName||q.longName||syms[i],
        regularMarketPrice:         safeNum(q.regularMarketPrice,4),
        regularMarketChange:        safeNum(q.regularMarketChange,4),
        regularMarketChangePercent: safeNum(q.regularMarketChangePercent,4),
        regularMarketVolume:        q.regularMarketVolume??null,
        averageVolume:              q.averageDailyVolume10Day??q.averageVolume??null,
        fiftyTwoWeekHigh:           safeNum(q.fiftyTwoWeekHigh,4),
        fiftyTwoWeekLow:            safeNum(q.fiftyTwoWeekLow,4),
        fiftyDayAverage:            safeNum(q.fiftyDayAverage,4),
        twoHundredDayAverage:       safeNum(q.twoHundredDayAverage,4),
        trailingPE:                 safeNum(q.trailingPE,2),
        forwardPE:                  safeNum(q.forwardPE,2),
        marketCap:                  q.marketCap??null,
        dividendYield:              safeNum(q.dividendYield,6),
        regularMarketOpen:          safeNum(q.regularMarketOpen,4),
        regularMarketDayHigh:       safeNum(q.regularMarketDayHigh,4),
        regularMarketDayLow:        safeNum(q.regularMarketDayLow,4),
        regularMarketPreviousClose: safeNum(q.regularMarketPreviousClose,4),
        currency:                   q.currency||null,
        exchangeName:               q.fullExchangeName||q.exchange||null,
      };
    }).filter(q=>q&&q.regularMarketPrice!=null);

    if(quotes.length===0){
      return res.status(502).json({error:'No valid quotes returned — symbols may be invalid or Yahoo Finance is unavailable'});
    }
    setCache(cacheKey,quotes);
    res.json({ok:true,cached:false,count:quotes.length,quotes,timestamp:new Date().toISOString()});
  } catch(e) {
    console.error('[quote]',e.message);
    res.status(503).json({error:e.message});
  }
});

// GET /api/spark
app.get('/api/spark', async(req,res)=>{
  const symbol=(req.query.symbol||'').trim().toUpperCase();
  if(!symbol)return res.status(400).json({error:'symbol param required'});

  const RANGES=['1d','5d','1mo','3mo','6mo','1y'];
  const INTERVALS=['1m','2m','5m','15m','30m','60m','90m','1h','1d','1wk'];
  const range   =RANGES.includes(req.query.range)?req.query.range:'1d';
  const interval=INTERVALS.includes(req.query.interval)?req.query.interval:'5m';

  const cacheKey=`spark:${symbol}:${range}:${interval}`;
  const hit=getCache(cacheKey);
  if(hit)return res.json({ok:true,cached:true,...hit});

  try {
    const yfInst=getYF();
    const now=new Date();
    let period1=new Date(now);
    if(range==='1d'){period1.setHours(0,0,0,0);}
    else{const d={'5d':5,'1mo':30,'3mo':90,'6mo':180,'1y':365}[range]||30;period1.setDate(now.getDate()-d);}

    const result=await yfInst.chart(symbol,{period1,interval,includePrePost:false},{validateResult:false});
    const qs=result?.quotes||[];
    if(qs.length===0)return res.status(404).json({error:`No chart data for ${symbol}`});

    const payload={
      symbol,range,interval,
      currency: result?.meta?.currency,
      exchange: result?.meta?.exchangeName,
      meta:{
        regularMarketPrice: safeNum(result?.meta?.regularMarketPrice,4),
        previousClose:      safeNum(result?.meta?.chartPreviousClose||result?.meta?.previousClose,4),
      },
      timestamps: qs.map(q=>Math.floor(new Date(q.date).getTime()/1000)),
      closes:     qs.map(q=>safeNum(q.close,4)),
      opens:      qs.map(q=>safeNum(q.open,4)),
      highs:      qs.map(q=>safeNum(q.high,4)),
      lows:       qs.map(q=>safeNum(q.low,4)),
      volumes:    qs.map(q=>q.volume??null),
      count:      qs.length,
    };
    setCache(cacheKey,payload);
    res.json({ok:true,cached:false,...payload});
  } catch(e) {
    console.error('[spark]',symbol,e.message);
    res.status(502).json({error:e.message});
  }
});

// GET /api/search
app.get('/api/search', async(req,res)=>{
  const q=(req.query.q||'').trim();
  if(!q)return res.status(400).json({error:'q param required'});

  const cacheKey='search:'+q.toLowerCase();
  const hit=getCache(cacheKey);
  if(hit)return res.json({ok:true,cached:true,quotes:hit});

  try {
    const result=await getYF().search(q,{quotesCount:8,newsCount:0},{validateResult:false});
    const quotes=(result?.quotes||[]).map(r=>({
      symbol:    r.symbol,
      shortname: r.shortname||r.longname||r.symbol,
      type:      r.typeDisp||r.quoteType||'—',
      exchange:  r.exchDisp||r.exchange||'—',
    }));
    setCache(cacheKey,quotes,300000);
    res.json({ok:true,cached:false,quotes});
  } catch(e) {
    console.error('[search]',e.message);
    res.status(502).json({error:e.message});
  }
});

// GET /api/fear-greed — direct HTTPS, no yf needed
app.get('/api/fear-greed', async(req,res)=>{
  const hit=getCache('fng');
  if(hit)return res.json({ok:true,cached:true,...hit});
  try {
    const data=await fetchPlain('https://api.alternative.me/fng/?limit=1&format=json');
    const item=data?.data?.[0];
    if(!item)throw new Error('Unexpected response');
    const payload={value:parseInt(item.value),classification:item.value_classification,timestamp:item.timestamp};
    setCache('fng',payload,4*60*60*1000);
    res.json({ok:true,cached:false,...payload});
  } catch(e) {
    res.status(502).json({error:e.message});
  }
});

// GET /api/fx — direct HTTPS, no yf needed
app.get('/api/fx', async(req,res)=>{
  const from=(req.query.from||'USD').toUpperCase().slice(0,3);
  const to  =(req.query.to  ||'THB').toUpperCase().slice(0,3);
  const cacheKey=`fx:${from}:${to}`;
  const hit=getCache(cacheKey);
  if(hit)return res.json({ok:true,cached:true,from,to,...hit});
  try {
    const data=await fetchPlain(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    const rate=data?.rates?.[to];
    if(!rate)throw new Error(`No rate for ${from}/${to}`);
    const payload={rate,date:data.date};
    setCache(cacheKey,payload,60*60*1000);
    res.json({ok:true,cached:false,from,to,...payload});
  } catch(e) {
    res.status(502).json({error:e.message});
  }
});

// GET /api/cache/clear
app.get('/api/cache/clear',(req,res)=>{
  const n=cache.size; cache.clear();
  res.json({ok:true,cleared:n});
});

// 404 / error
app.use((req,res)=>res.status(404).json({error:'Not found. See GET / for docs.'}));
app.use((err,req,res,_next)=>{ console.error('[ERROR]',err.message); res.status(500).json({error:'Internal error'}); });

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  const cacheLbl=CACHE_TTL_MS<60000?(CACHE_TTL_MS/1000+' sec'):(CACHE_TTL_MS/60000+' min');
  console.log([
    '╔════════════════════════════════════════╗',
    '║    TradeRadar API Server v3.0 (ESM)    ║',
    '╠════════════════════════════════════════╣',
    '║  Port  : '+String(PORT).padEnd(29)           +'║',
    '║  Cache : '+cacheLbl.padEnd(29)               +'║',
    '║  Rate  : '+(RATE_LIMIT+' req/min').padEnd(29)+'║',
    '║  Node  : '+process.version.padEnd(29)        +'║',
    '║  Auth  : API Key required             ║',
    '╚════════════════════════════════════════╝',
  ].join('\n'));

  // Load yahoo-finance2 via dynamic ESM import AFTER server is listening
  // This guarantees /health passes Railway healthcheck immediately
  console.log('[yf] loading yahoo-finance2...');
  await loadYF();
});
