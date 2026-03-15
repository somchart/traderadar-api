// TradeRadar API Server v5.0 — ESM, Railway-compatible
// Data sources:
//   - Quotes : Yahoo Finance via RapidAPI (free 500 req/mo) OR Finnhub (free 60 req/min)
//   - Chart  : Stooq CSV (free, no auth, no IP block)
//   - Search : Yahoo v1/finance/search via RapidAPI
//   - F&G    : alternative.me (direct, always works)
//   - FX     : frankfurter.app (direct, always works)
// "type":"module" in package.json

import express from 'express';
import cors    from 'cors';
import helmet  from 'helmet';
import https   from 'https';
import http    from 'http';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_KEY        = process.env.API_KEY        || 'change-me-in-env';
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS  || '60000');
const RATE_LIMIT     = parseInt(process.env.RATE_LIMIT    || '120');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
// Get a free key at rapidapi.com → "Yahoo Finance" by Apidojo (500 req/mo free)
const RAPIDAPI_KEY   = process.env.RAPIDAPI_KEY   || '';
// Get a free key at finnhub.io (60 req/min free, no IP block)
const FINNHUB_KEY    = process.env.FINNHUB_KEY    || '';

// ─── CACHE ───────────────────────────────────────────────────────────────────
const cache   = new Map();
const getC    = k => { const e=cache.get(k); if(!e)return null; if(Date.now()>e.exp){cache.delete(k);return null;} return e.data; };
const setC    = (k,d,ttl=CACHE_TTL_MS) => cache.set(k,{data:d,exp:Date.now()+ttl});
const cStats  = () => { let v=0,now=Date.now(); cache.forEach(e=>{if(now<e.exp)v++;}); return {total:cache.size,valid:v,ttl_ms:CACHE_TTL_MS}; };

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
app.use(cors({origin:ALLOWED_ORIGIN==='*'?'*':ALLOWED_ORIGIN.split(','),methods:['GET']}));
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

// ─── HTTP FETCH HELPER ───────────────────────────────────────────────────────
function fetchURL(urlStr, extraHeaders={}, timeoutMs=10000) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'Mozilla/5.0 (compatible; TradeRadarBot/5.0)',
        'Accept':     'application/json, text/plain, */*',
        ...extraHeaders,
      },
      timeout: timeoutMs,
    };
    const req = client.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,120)}`));
        }
        try   { resolve(JSON.parse(body)); }
        catch { resolve(body); }           // return raw string if not JSON (e.g. CSV)
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ─── DATA SOURCES ────────────────────────────────────────────────────────────
const safeNum = (v,d=4) => v==null||!isFinite(Number(v)) ? null : +Number(v).toFixed(d);

// ── SOURCE 1: Finnhub — no IP block, 60 req/min free ─────────────────────────
async function finnhubQuote(sym) {
  if (!FINNHUB_KEY) throw new Error('FINNHUB_KEY not set');
  // Finnhub uses different symbol format: BK suffix for Thai
  const fSym = sym.endsWith('.BK') ? sym.replace('.BK','') : sym;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(fSym)}&token=${FINNHUB_KEY}`;
  const d = await fetchURL(url, {}, 8000);
  if (!d.c) throw new Error('Finnhub: no price for '+sym);
  const prev = d.pc || d.c;
  return {
    symbol:                     sym,
    shortName:                  sym,
    regularMarketPrice:         safeNum(d.c, 4),
    regularMarketChange:        safeNum(d.c - prev, 4),
    regularMarketChangePercent: safeNum(prev ? ((d.c-prev)/prev)*100 : 0, 4),
    regularMarketVolume:        null,
    averageVolume:              null,
    fiftyTwoWeekHigh:           safeNum(d.h, 4),
    fiftyTwoWeekLow:            safeNum(d.l, 4),
    fiftyDayAverage:            null,
    twoHundredDayAverage:       null,
    trailingPE:                 null,
    marketCap:                  null,
    regularMarketOpen:          safeNum(d.o, 4),
    regularMarketDayHigh:       safeNum(d.h, 4),
    regularMarketDayLow:        safeNum(d.l, 4),
    regularMarketPreviousClose: safeNum(prev, 4),
    _source: 'finnhub',
  };
}

// ── SOURCE 2: RapidAPI Yahoo Finance ─────────────────────────────────────────
async function rapidQuote(sym) {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not set');
  const url = `https://yahoo-finance15.p.rapidapi.com/api/v1/markets/stock/quotes?ticker=${encodeURIComponent(sym)}`;
  const d = await fetchURL(url, {
    'x-rapidapi-key':  RAPIDAPI_KEY,
    'x-rapidapi-host': 'yahoo-finance15.p.rapidapi.com',
  }, 10000);
  const q = d?.body?.[0] || d?.quoteResponse?.result?.[0] || d?.data?.[0];
  if (!q?.regularMarketPrice) throw new Error('RapidAPI: no price for '+sym);
  return {
    symbol:                     q.symbol || sym,
    shortName:                  q.shortName || q.displayName || sym,
    regularMarketPrice:         safeNum(q.regularMarketPrice, 4),
    regularMarketChange:        safeNum(q.regularMarketChange, 4),
    regularMarketChangePercent: safeNum(q.regularMarketChangePercent, 4),
    regularMarketVolume:        q.regularMarketVolume ?? null,
    averageVolume:              q.averageDailyVolume3Month ?? q.averageVolume ?? null,
    fiftyTwoWeekHigh:           safeNum(q.fiftyTwoWeekHigh, 4),
    fiftyTwoWeekLow:            safeNum(q.fiftyTwoWeekLow, 4),
    fiftyDayAverage:            safeNum(q.fiftyDayAverage, 4),
    twoHundredDayAverage:       safeNum(q.twoHundredDayAverage, 4),
    trailingPE:                 safeNum(q.trailingPE, 2),
    marketCap:                  q.marketCap ?? null,
    regularMarketOpen:          safeNum(q.regularMarketOpen, 4),
    regularMarketDayHigh:       safeNum(q.regularMarketDayHigh, 4),
    regularMarketDayLow:        safeNum(q.regularMarketDayLow, 4),
    regularMarketPreviousClose: safeNum(q.regularMarketPreviousClose, 4),
    currency:                   q.currency ?? null,
    exchangeName:               q.fullExchangeName ?? null,
    _source: 'rapidapi',
  };
}

// ── SOURCE 3: Stooq CSV — completely free, no auth, no IP block ───────────────
// Works for: US stocks (AAPL.US), indices (^SPX, ^NDX), gold (GC.F), FX (USDTHB.FX)
// Thai stocks: PTT.TH format
function toStooqSym(sym) {
  if (sym === 'GC=F')      return 'GC.F';
  if (sym === 'CL=F')      return 'CL.F';
  if (sym === 'BTC-USD')   return 'BTC.V';
  if (sym === 'ETH-USD')   return 'ETH.V';
  if (sym === '^GSPC')     return '^SPX';
  if (sym === '^IXIC')     return '^NDX';
  if (sym === '^VIX')      return '^VIX';
  if (sym === '^SET')      return 'WIG.IN';  // fallback index
  if (sym === 'THBX=X')   return 'USDTHB.FX';
  if (sym === 'DX-Y.NYB') return 'USDX.FX';
  if (sym === '^TNX')      return 'TNX.US';
  if (sym === 'SPY')       return 'SPY.US';
  if (sym === 'QQQ')       return 'QQQ.US';
  if (sym === 'GLD')       return 'GLD.US';
  if (sym.endsWith('.BK')) return sym.replace('.BK', '.TH');
  // US stocks/ETFs: add .US suffix
  if (/^[A-Z]{1,5}$/.test(sym)) return sym + '.US';
  return sym;
}

async function fetchStooqCSV(stSym) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stSym.toLowerCase())}&i=d`;
  const body = await fetchURL(url, {
    'Accept': 'text/csv, text/plain, */*',
    'Referer': 'https://stooq.com/',
  }, 10000);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  // Stooq returns HTML on error ("Oops", "No data")
  if (text.startsWith('<') || text.toLowerCase().includes('oops') || text.toLowerCase().includes('no data')) {
    throw new Error(`Stooq: no data for ${stSym} (got HTML error page)`);
  }
  const lines = text.trim().split('\n').filter(l => l.trim() && !l.toLowerCase().startsWith('date'));
  if (!lines.length) throw new Error(`Stooq: empty CSV for ${stSym}`);
  return lines;
}

async function stooqQuote(sym) {
  const stSym = toStooqSym(sym);
  const lines = await fetchStooqCSV(stSym);
  // CSV: Date,Open,High,Low,Close,Volume
  const last   = lines[lines.length - 1].split(',');
  const prev   = lines.length > 1 ? parseFloat(lines[lines.length-2].split(',')[4]) : null;
  const [date, open, high, low, close, vol] = last;
  const c = parseFloat(close);
  const p = prev || c;
  if (isNaN(c)) throw new Error(`Stooq: invalid price "${close}" for ${stSym}`);
  return {
    symbol:                     sym,
    shortName:                  sym,
    regularMarketPrice:         safeNum(c, 4),
    regularMarketChange:        safeNum(c - p, 4),
    regularMarketChangePercent: safeNum(p ? ((c-p)/p)*100 : 0, 4),
    regularMarketVolume:        vol ? parseInt(vol) : null,
    averageVolume:              null,
    fiftyTwoWeekHigh:           safeNum(high, 4),
    fiftyTwoWeekLow:            safeNum(low, 4),
    fiftyDayAverage:            null,
    twoHundredDayAverage:       null,
    trailingPE:                 null,
    marketCap:                  null,
    regularMarketOpen:          safeNum(open, 4),
    regularMarketDayHigh:       safeNum(high, 4),
    regularMarketDayLow:        safeNum(low, 4),
    regularMarketPreviousClose: safeNum(p, 4),
    currency:                   sym.endsWith('.BK') || sym.endsWith('.TH') ? 'THB' : 'USD',
    _source: 'stooq',
    _date: date?.trim(),
  };
}

// ── Stooq historical CSV for spark chart ─────────────────────────────────────
async function stooqChart(sym, days=1) {
  const stSym = toStooqSym(sym);
  const lines = await fetchStooqCSV(stSym);

  const take = Math.min(lines.length, Math.max(days * 2, 30));
  const rows = lines.slice(-take).map(l => {
    const [date, open, high, low, close, vol] = l.split(',');
    return {
      ts:     Math.floor(new Date(date?.trim()).getTime() / 1000),
      open:   safeNum(open, 4),
      high:   safeNum(high, 4),
      low:    safeNum(low, 4),
      close:  safeNum(close, 4),
      volume: vol ? parseInt(vol) : null,
    };
  }).filter(r => r.close != null && !isNaN(r.ts));

  if (!rows.length) throw new Error(`Stooq chart: no valid rows for ${stSym}`);

  return {
    timestamps: rows.map(r => r.ts),
    closes:     rows.map(r => r.close),
    opens:      rows.map(r => r.open),
    highs:      rows.map(r => r.high),
    lows:       rows.map(r => r.low),
    volumes:    rows.map(r => r.volume),
    count:      rows.length,
    _source:    'stooq',
  };
}

// ── Multi-source quote with fallback chain ────────────────────────────────────
async function getQuote(sym) {
  const errors = [];

  // Try RapidAPI first (most fields)
  if (RAPIDAPI_KEY) {
    try { return await rapidQuote(sym); } catch(e) { errors.push('rapidapi: '+e.message); }
  }

  // Try Finnhub (good for US stocks)
  if (FINNHUB_KEY) {
    try { return await finnhubQuote(sym); } catch(e) { errors.push('finnhub: '+e.message); }
  }

  // Always try Stooq (free, no auth, covers most symbols)
  try { return await stooqQuote(sym); } catch(e) { errors.push('stooq: '+e.message); }

  throw new Error(`All sources failed for ${sym}: ${errors.join(' | ')}`);
}

async function getChart(sym, range) {
  const days = {'1d':1,'5d':5,'1mo':30,'3mo':90}[range]||1;

  // Stooq always works for chart
  try { return await stooqChart(sym, days); } catch(e) {}

  throw new Error(`Chart unavailable for ${sym}`);
}

function simpleGet(url) {
  return new Promise((res,rej)=>{
    const r=https.get(url,{headers:{'User-Agent':'TradeRadar/5.0','Accept':'application/json'},timeout:8000},resp=>{
      let b=''; resp.setEncoding('utf8'); resp.on('data',c=>b+=c);
      resp.on('end',()=>{ try{res(JSON.parse(b));}catch(e){rej(e);} });
    });
    r.on('error',rej); r.on('timeout',()=>{r.destroy();rej(new Error('timeout'));});
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.status(200).json({
    status:   'ok',
    uptime:   Math.round(process.uptime())+'s',
    cache:    cStats(),
    version:  '5.0.0',
    sources:  {
      rapidapi: RAPIDAPI_KEY ? 'configured' : 'not set (optional)',
      finnhub:  FINNHUB_KEY  ? 'configured' : 'not set (optional)',
      stooq:    'always available (free, no key)',
    },
    time: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name:'TradeRadar API v5', version:'5.0.0',
    dataSources: ['Stooq (free,always)', 'Finnhub (free key)', 'RapidAPI Yahoo (free key)'],
    auth:'X-API-Key header on all /api/* endpoints',
    endpoints:{
      '/health':                        'Health + source status (no auth)',
      '/api/quote?symbols=AAPL,GC=F':  'Quotes — multi-source fallback',
      '/api/spark?symbol=AAPL':        'Chart data (1d/5d/1mo/3mo)',
      '/api/search?q=apple':           'Symbol search',
      '/api/fear-greed':               'Fear & Greed',
      '/api/fx?from=USD&to=THB':       'FX rate',
      '/api/cache/clear':              'Clear cache',
    },
  });
});

app.get('/api/quote', async (req, res) => {
  const raw  = req.query.symbols || req.query.symbol || '';
  if (!raw) return res.status(400).json({ error: 'symbols param required' });
  const syms = raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
  if (syms.length > 20) return res.status(400).json({ error: 'Max 20 symbols' });

  const cacheKey = 'quote:'+syms.join(',');
  const hit = getC(cacheKey);
  if (hit) return res.json({ok:true,cached:true,count:hit.length,quotes:hit,timestamp:new Date().toISOString()});

  const results = await Promise.allSettled(syms.map(s=>getQuote(s)));
  const quotes  = results
    .map((r,i) => r.status==='fulfilled' ? r.value : { symbol:syms[i], error:r.reason?.message })
    .filter(q => q.regularMarketPrice != null);

  if (!quotes.length) return res.status(502).json({
    error: 'No quotes returned. Set RAPIDAPI_KEY or FINNHUB_KEY in Railway Variables for more coverage.',
    details: results.map((r,i)=>({symbol:syms[i],error:r.reason?.message})),
  });

  setC(cacheKey, quotes);
  res.json({ok:true,cached:false,count:quotes.length,quotes,timestamp:new Date().toISOString()});
});

app.get('/api/spark', async (req, res) => {
  const symbol = (req.query.symbol||'').trim().toUpperCase();
  if (!symbol) return res.status(400).json({error:'symbol param required'});
  const range = ['1d','5d','1mo','3mo'].includes(req.query.range) ? req.query.range : '1d';

  const cacheKey = `spark:${symbol}:${range}`;
  const hit = getC(cacheKey);
  if (hit) return res.json({ok:true,cached:true,...hit});

  try {
    const data = await getChart(symbol, range);
    setC(cacheKey, data);
    res.json({ok:true,cached:false,symbol,range,...data});
  } catch(e) {
    res.status(502).json({error:e.message});
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q||'').trim();
  if (!q) return res.status(400).json({error:'q param required'});

  // Search using Stooq suggestions or return static suggestions
  // For now: filter from known symbols list + Finnhub search
  const known = [
    {symbol:'AAPL.US',shortname:'Apple Inc.',type:'US Stock'},
    {symbol:'NVDA.US',shortname:'NVIDIA Corp.',type:'US Stock'},
    {symbol:'TSLA.US',shortname:'Tesla Inc.',type:'US Stock'},
    {symbol:'MSFT.US',shortname:'Microsoft Corp.',type:'US Stock'},
    {symbol:'AMZN.US',shortname:'Amazon.com',type:'US Stock'},
    {symbol:'META.US',shortname:'Meta Platforms',type:'US Stock'},
    {symbol:'GOOGL.US',shortname:'Alphabet Inc.',type:'US Stock'},
    {symbol:'GC.F',shortname:'Gold Futures',type:'Futures'},
    {symbol:'PTT.TH',shortname:'บมจ. ปตท.',type:'TH Stock'},
    {symbol:'CPALL.TH',shortname:'บมจ. ซีพี ออลล์',type:'TH Stock'},
    {symbol:'KBANK.TH',shortname:'บมจ. กสิกรไทย',type:'TH Stock'},
    {symbol:'^SPX',shortname:'S&P 500',type:'Index'},
    {symbol:'^NDX',shortname:'NASDAQ 100',type:'Index'},
    {symbol:'BTC.V',shortname:'Bitcoin',type:'Crypto'},
  ];

  const uq = q.toUpperCase();
  const matches = known.filter(s =>
    s.symbol.includes(uq) || s.shortname.toUpperCase().includes(uq)
  );

  // Try Finnhub symbol search too
  if (FINNHUB_KEY) {
    try {
      const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`;
      const d = await fetchURL(url, {}, 6000);
      const extra = (d.result||[]).slice(0,6).map(r=>({
        symbol:    r.symbol,
        shortname: r.description||r.symbol,
        type:      r.type||'—',
        exchange:  r.primaryExchange||'',
      }));
      const allSyms = new Set(matches.map(m=>m.symbol));
      extra.filter(e=>!allSyms.has(e.symbol)).forEach(e=>matches.push(e));
    } catch{}
  }

  res.json({ok:true,cached:false,quotes:matches.slice(0,8).map(s=>({
    symbol:    s.symbol,
    shortname: s.shortname,
    type:      s.type||'—',
    exchange:  s.exchange||'—',
  }))});
});

app.get('/api/fear-greed', async (req, res) => {
  const hit = getC('fng');
  if (hit) return res.json({ok:true,cached:true,...hit});
  try {
    const d = await simpleGet('https://api.alternative.me/fng/?limit=1&format=json');
    const item = d?.data?.[0];
    if (!item) throw new Error('No data');
    const p = {value:parseInt(item.value),classification:item.value_classification,timestamp:item.timestamp};
    setC('fng',p,4*60*60*1000);
    res.json({ok:true,cached:false,...p});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.get('/api/fx', async (req, res) => {
  const from=(req.query.from||'USD').toUpperCase().slice(0,3);
  const to  =(req.query.to  ||'THB').toUpperCase().slice(0,3);
  const cacheKey=`fx:${from}:${to}`;
  const hit=getC(cacheKey);
  if(hit)return res.json({ok:true,cached:true,from,to,...hit});
  try {
    const d=await simpleGet(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    const rate=d?.rates?.[to];
    if(!rate)throw new Error(`No rate for ${from}/${to}`);
    const p={rate,date:d.date};
    setC(cacheKey,p,60*60*1000);
    res.json({ok:true,cached:false,from,to,...p});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.get('/api/cache/clear', (req,res)=>{ const n=cache.size; cache.clear(); res.json({ok:true,cleared:n}); });

app.use((req,res)=>res.status(404).json({error:'Not found. See GET /'}));
app.use((err,req,res,_n)=>{ console.error('[ERROR]',err.message); res.status(500).json({error:'Internal error'}); });

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const c=CACHE_TTL_MS<60000?(CACHE_TTL_MS/1000+'s'):(CACHE_TTL_MS/60000+'m');
  console.log([
    '╔════════════════════════════════════════╗',
    '║    TradeRadar API Server v5.0 (ESM)    ║',
    '╠════════════════════════════════════════╣',
    '║  Port  : '+String(PORT).padEnd(29)           +'║',
    '║  Cache : '+c.padEnd(29)                      +'║',
    '║  Rate  : '+(RATE_LIMIT+' req/min').padEnd(29)+'║',
    '║  Stooq : always on (no key needed)    ║',
    '║  Rapid : '+(RAPIDAPI_KEY?'✅ configured':'⚠️  not set (optional)').padEnd(29)+'║',
    '║  Finn  : '+(FINNHUB_KEY ?'✅ configured':'⚠️  not set (optional)').padEnd(29)+'║',
    '╚════════════════════════════════════════╝',
  ].join('\n'));
});
