// TradeRadar API Server v4.0 — ESM, zero Yahoo library dependency
// Uses Yahoo Finance v11/v8 direct HTTPS with proper headers + cookie/crumb
// "type":"module" in package.json required

import express  from 'express';
import cors     from 'cors';
import helmet   from 'helmet';
import https    from 'https';
import zlib     from 'zlib';
import { Buffer } from 'buffer';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_KEY       = process.env.API_KEY      || 'change-me-in-env';
const CACHE_TTL_MS  = parseInt(process.env.CACHE_TTL_MS || '60000');
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT   || '120');
const ALLOWED_ORIGIN= process.env.ALLOWED_ORIGIN || '*';

// ─── CACHE ───────────────────────────────────────────────────────────────────
const cache = new Map();
const getCache = k => { const e=cache.get(k); if(!e)return null; if(Date.now()>e.exp){cache.delete(k);return null;} return e.data; };
const setCache = (k,d,ttl=CACHE_TTL_MS) => cache.set(k,{data:d,exp:Date.now()+ttl});
const cacheStats = () => { let v=0,now=Date.now(); cache.forEach(e=>{if(now<e.exp)v++;}); return {total:cache.size,valid:v,ttl_ms:CACHE_TTL_MS}; };

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

// ─── YAHOO FINANCE DIRECT HTTPS ──────────────────────────────────────────────
// No library — direct HTTPS using Yahoo Finance v11 (quota/price endpoint)
// This endpoint requires no crumb and works from server IPs.

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
let uaIdx = 0;
const nextUA = () => UA_LIST[uaIdx++ % UA_LIST.length];

// Yahoo Finance cookie/crumb state
let yfCookie = '';
let yfCrumb  = '';
let crumbAt  = 0;
const CRUMB_TTL = 50 * 60 * 1000; // 50 min

async function yfGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': nextUA(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Origin': 'https://finance.yahoo.com',
        'Referer': 'https://finance.yahoo.com/',
        ...(yfCookie && { 'Cookie': yfCookie }),
      },
      timeout: 12000,
    };
    const req = https.request(options, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip')       { const g = zlib.createGunzip();           res.pipe(g); stream = g; }
      else if (enc === 'br')    { const b = zlib.createBrotliDecompress(); res.pipe(b); stream = b; }
      else if (enc === 'deflate'){const d = zlib.createInflate();          res.pipe(d); stream = d; }

      const chunks = [];
      stream.on('data', c => chunks.push(Buffer.from(c)));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch(e) { reject(new Error('Invalid JSON')); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function refreshCrumb() {
  if (yfCrumb && Date.now() - crumbAt < CRUMB_TTL) return;
  try {
    // Step 1: get cookie
    const cookie = await new Promise((resolve, reject) => {
      const r = https.get('https://finance.yahoo.com/', {
        headers: { 'User-Agent': nextUA(), 'Accept': 'text/html' },
        timeout: 8000,
      }, res => {
        res.resume();
        const raw = res.headers['set-cookie'] || [];
        resolve(raw.map(c => c.split(';')[0]).join('; '));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('cookie timeout')); });
    });
    if (cookie) yfCookie = cookie;

    // Step 2: get crumb
    const crumb = await new Promise((resolve, reject) => {
      const r = https.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          'User-Agent': nextUA(),
          'Cookie': yfCookie,
          'Accept': 'text/plain',
        },
        timeout: 8000,
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => resolve(body.trim()));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('crumb timeout')); });
    });

    if (crumb && !crumb.includes('<') && crumb.length < 20) {
      yfCrumb = crumb;
      crumbAt = Date.now();
      console.log('[crumb] refreshed OK:', crumb.slice(0,6)+'...');
    }
  } catch(e) {
    console.warn('[crumb] failed (non-fatal):', e.message);
  }
}

const safeNum = (v, d=4) => v == null || !isFinite(v) ? null : +Number(v).toFixed(d);

// ── Yahoo v11 quote (works without crumb) ─────────────────────────────────────
async function fetchQuoteV11(symbols) {
  const syms = symbols.join(',');
  // v11/finance/quoteSummary or financialData — but easiest is v8/finance/quote
  // which uses a different auth path than v7
  const crumbParam = yfCrumb ? `&crumb=${encodeURIComponent(yfCrumb)}` : '';
  const path = `/v8/finance/quote?symbols=${encodeURIComponent(syms)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,averageVolume,fiftyTwoWeekHigh,fiftyTwoWeekLow,fiftyDayAverage,twoHundredDayAverage,shortName,trailingPE,forwardPE,marketCap,regularMarketPreviousClose,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,dividendYield${crumbParam}`;
  const data = await yfGet(path);
  return data?.quoteResponse?.result || [];
}

// ── Yahoo v8 chart (for spark/intraday) ──────────────────────────────────────
async function fetchChart(symbol, range, interval) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  return yfGet(path);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function rawQuoteToClean(q, sym) {
  return {
    symbol:                     q.symbol     || sym,
    shortName:                  q.shortName  || q.longName || sym,
    regularMarketPrice:         safeNum(q.regularMarketPrice, 4),
    regularMarketChange:        safeNum(q.regularMarketChange, 4),
    regularMarketChangePercent: safeNum(q.regularMarketChangePercent, 4),
    regularMarketVolume:        q.regularMarketVolume   ?? null,
    averageVolume:              q.averageVolume ?? null,
    fiftyTwoWeekHigh:           safeNum(q.fiftyTwoWeekHigh, 4),
    fiftyTwoWeekLow:            safeNum(q.fiftyTwoWeekLow, 4),
    fiftyDayAverage:            safeNum(q.fiftyDayAverage, 4),
    twoHundredDayAverage:       safeNum(q.twoHundredDayAverage, 4),
    trailingPE:                 safeNum(q.trailingPE, 2),
    forwardPE:                  safeNum(q.forwardPE, 2),
    marketCap:                  q.marketCap ?? null,
    dividendYield:              safeNum(q.dividendYield, 6),
    regularMarketOpen:          safeNum(q.regularMarketOpen, 4),
    regularMarketDayHigh:       safeNum(q.regularMarketDayHigh, 4),
    regularMarketDayLow:        safeNum(q.regularMarketDayLow, 4),
    regularMarketPreviousClose: safeNum(q.regularMarketPreviousClose, 4),
    currency:                   q.currency ?? null,
    exchangeName:               q.fullExchangeName || q.exchange || null,
  };
}

async function simpleGet(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, {
      headers: { 'User-Agent': 'TradeRadar/4.0', 'Accept': 'application/json' },
      timeout: 8000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()) + 's',
    cache: cacheStats(),
    version: '4.0.0',
    crumb: yfCrumb ? 'ok' : 'pending',
    time: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'TradeRadar API v4', version: '4.0.0',
    note: 'Zero library — direct Yahoo Finance HTTPS',
    endpoints: {
      '/health': 'Server health (no auth)',
      '/api/quote?symbols=AAPL,GC=F': 'Quotes (max 20)',
      '/api/spark?symbol=AAPL': 'Intraday chart (range: 1d 5d 1mo | interval: 5m 15m 60m)',
      '/api/search?q=apple': 'Symbol search',
      '/api/fear-greed': 'Fear & Greed',
      '/api/fx?from=USD&to=THB': 'FX rate',
      '/api/cache/clear': 'Clear cache',
    },
  });
});

// GET /api/quote
app.get('/api/quote', async (req, res) => {
  const raw = req.query.symbols || req.query.symbol || '';
  if (!raw) return res.status(400).json({ error: 'symbols param required' });
  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (syms.length > 20) return res.status(400).json({ error: 'Max 20 symbols' });

  const cacheKey = 'quote:' + syms.join(',');
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, count: hit.length, quotes: hit, timestamp: new Date().toISOString() });

  try {
    await refreshCrumb();
    const raw = await fetchQuoteV11(syms);
    if (!raw.length) return res.status(502).json({ error: 'No quotes returned from Yahoo Finance' });
    const quotes = raw.map(q => rawQuoteToClean(q, q.symbol)).filter(q => q.regularMarketPrice != null);
    setCache(cacheKey, quotes);
    res.json({ ok: true, cached: false, count: quotes.length, quotes, timestamp: new Date().toISOString() });
  } catch(e) {
    console.error('[quote]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/spark
app.get('/api/spark', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol param required' });
  const RANGES    = ['1d','5d','1mo','3mo'];
  const INTERVALS = ['1m','2m','5m','15m','30m','60m','1d'];
  const range    = RANGES.includes(req.query.range)    ? req.query.range    : '1d';
  const interval = INTERVALS.includes(req.query.interval) ? req.query.interval : '5m';

  const cacheKey = `spark:${symbol}:${range}:${interval}`;
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, ...hit });

  try {
    const data = await fetchChart(symbol, range, interval);
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: `No chart data for ${symbol}` });

    const ts = result.timestamp || [];
    const q  = result.indicators?.quote?.[0] || {};
    const m  = result.meta || {};

    const payload = {
      symbol, range, interval,
      currency: m.currency,
      exchange: m.exchangeName,
      meta: {
        regularMarketPrice: safeNum(m.regularMarketPrice, 4),
        previousClose: safeNum(m.chartPreviousClose || m.previousClose, 4),
      },
      timestamps: ts,
      closes:  (q.close  || []).map(v => safeNum(v, 4)),
      opens:   (q.open   || []).map(v => safeNum(v, 4)),
      highs:   (q.high   || []).map(v => safeNum(v, 4)),
      lows:    (q.low    || []).map(v => safeNum(v, 4)),
      volumes: (q.volume || []).map(v => v ?? null),
      count: ts.length,
    };
    setCache(cacheKey, payload);
    res.json({ ok: true, cached: false, ...payload });
  } catch(e) {
    console.error('[spark]', symbol, e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/search
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q param required' });

  const cacheKey = 'search:' + q.toLowerCase();
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, quotes: hit });

  try {
    const crumbParam = yfCrumb ? `&crumb=${encodeURIComponent(yfCrumb)}` : '';
    const data = await yfGet(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0${crumbParam}`);
    const quotes = (data?.quotes || []).map(r => ({
      symbol:    r.symbol,
      shortname: r.shortname || r.longname || r.symbol,
      type:      r.typeDisp  || r.quoteType || '—',
      exchange:  r.exchDisp  || r.exchange  || '—',
    }));
    setCache(cacheKey, quotes, 300000);
    res.json({ ok: true, cached: false, quotes });
  } catch(e) {
    console.error('[search]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/fear-greed
app.get('/api/fear-greed', async (req, res) => {
  const hit = getCache('fng');
  if (hit) return res.json({ ok: true, cached: true, ...hit });
  try {
    const data = await simpleGet('https://api.alternative.me/fng/?limit=1&format=json');
    const item = data?.data?.[0];
    if (!item) throw new Error('No data');
    const payload = { value: parseInt(item.value), classification: item.value_classification, timestamp: item.timestamp };
    setCache('fng', payload, 4 * 60 * 60 * 1000);
    res.json({ ok: true, cached: false, ...payload });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/fx
app.get('/api/fx', async (req, res) => {
  const from = (req.query.from || 'USD').toUpperCase().slice(0,3);
  const to   = (req.query.to   || 'THB').toUpperCase().slice(0,3);
  const cacheKey = `fx:${from}:${to}`;
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, from, to, ...hit });
  try {
    const data = await simpleGet(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    const rate = data?.rates?.[to];
    if (!rate) throw new Error(`No rate for ${from}/${to}`);
    const payload = { rate, date: data.date };
    setCache(cacheKey, payload, 60 * 60 * 1000);
    res.json({ ok: true, cached: false, from, to, ...payload });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/cache/clear
app.get('/api/cache/clear', (req, res) => {
  const n = cache.size; cache.clear();
  res.json({ ok: true, cleared: n });
});

app.use((req,res) => res.status(404).json({ error: 'Not found. See GET / for docs.' }));
app.use((err,req,res,_next) => { console.error('[ERROR]', err.message); res.status(500).json({ error: 'Internal error' }); });

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const cacheLbl = CACHE_TTL_MS < 60000 ? (CACHE_TTL_MS/1000+'s') : (CACHE_TTL_MS/60000+'m');
  console.log([
    '╔════════════════════════════════════════╗',
    '║    TradeRadar API Server v4.0 (ESM)    ║',
    '╠════════════════════════════════════════╣',
    '║  Port  : '+String(PORT).padEnd(29)            +'║',
    '║  Cache : '+cacheLbl.padEnd(29)                +'║',
    '║  Rate  : '+(RATE_LIMIT+' req/min').padEnd(29) +'║',
    '║  Node  : '+process.version.padEnd(29)         +'║',
    '║  Lib   : built-in https (no ext lib)  ║',
    '╚════════════════════════════════════════╝',
  ].join('\n'));

  // Warm up crumb in background — does NOT block healthcheck
  refreshCrumb().catch(() => {});
});
