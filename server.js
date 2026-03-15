'use strict';

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const https      = require('https');
const http       = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_KEY       = process.env.API_KEY || 'change-me-in-env';   // set in Railway env vars
const CACHE_TTL_MS  = parseInt(process.env.CACHE_TTL_MS  || '60000');  // 60s default (real-time)
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT     || '120');    // req/min per IP (higher for 60s cache)
const ALLOWED_ORIGIN= process.env.ALLOWED_ORIGIN || '*';                // set to your Netlify URL

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, exp: Date.now() + ttl });
}
function getCacheStats() {
  let valid = 0;
  const now = Date.now();
  cache.forEach(v => { if (now < v.exp) valid++; });
  return { total: cache.size, valid, ttl_ms: CACHE_TTL_MS };
}

// ─── SIMPLE IN-MEMORY RATE LIMITER ───────────────────────────────────────────
const rateBuckets = new Map();
function checkRate(ip) {
  const now   = Date.now();
  const entry = rateBuckets.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  rateBuckets.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}
// Clean old buckets every 5 min
setInterval(() => {
  const now = Date.now();
  rateBuckets.forEach((v, k) => { if (now > v.reset + 60_000) rateBuckets.delete(k); });
}, 300_000);

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN.split(','),
  methods: ['GET'],
}));
app.use(express.json());

// Rate limit middleware
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // skip health check
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max ' + RATE_LIMIT + ' req/min.' });
  }
  next();
});

// API Key auth middleware (skip health + docs)
app.use((req, res, next) => {
  if (['/health', '/'].includes(req.path)) return next();
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key. Pass X-API-Key header.' });
  }
  next();
});

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────
function fetchJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TradeRadar/1.0)',
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Invalid JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ─── YAHOO FINANCE HELPERS ───────────────────────────────────────────────────
const YF_BASE  = 'https://query1.finance.yahoo.com';
const YF_BASE2 = 'https://query2.finance.yahoo.com'; // fallback

async function yfFetch(path) {
  const cacheKey = 'yf:' + path;
  const hit = getCache(cacheKey);
  if (hit) return { data: hit, cached: true };

  let data;
  try {
    data = await fetchJSON(YF_BASE + path);
  } catch (e) {
    // Fallback to query2
    try {
      data = await fetchJSON(YF_BASE2 + path);
    } catch (e2) {
      throw new Error(`Yahoo Finance unreachable: ${e.message}`);
    }
  }
  setCache(cacheKey, data);
  return { data, cached: false };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check — no auth required
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.round(process.uptime()) + 's',
    cache:    getCacheStats(),
    version:  '1.0.0',
    time:     new Date().toISOString(),
  });
});

// Docs
app.get('/', (req, res) => {
  res.json({
    name: 'TradeRadar API',
    version: '1.0.0',
    auth: 'Pass X-API-Key header on all /api/* requests',
    endpoints: {
      'GET /health':                     'Server health + cache stats (no auth)',
      'GET /api/quote?symbols=AAPL,GC=F':'Stock/ETF/Futures quotes',
      'GET /api/spark?symbol=AAPL':      'Intraday chart data (5m, 1d)',
      'GET /api/search?q=apple':         'Symbol search',
      'GET /api/fear-greed':             'Crypto Fear & Greed Index',
      'GET /api/fx?from=USD&to=THB':     'Exchange rate',
      'GET /api/cache/clear':            'Clear server cache',
    },
  });
});

// ── /api/quote ────────────────────────────────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  const symbols = req.query.symbols || req.query.symbol;
  if (!symbols) return res.status(400).json({ error: 'symbols query param required' });

  // Validate: max 20 symbols, alphanumeric + common chars
  const syms = symbols.split(',').map(s => s.trim()).filter(Boolean);
  if (syms.length > 20) return res.status(400).json({ error: 'Max 20 symbols per request' });

  const fields = [
    'symbol','shortName','longName',
    'regularMarketPrice','regularMarketChange','regularMarketChangePercent',
    'regularMarketVolume','averageVolume',
    'fiftyTwoWeekHigh','fiftyTwoWeekLow',
    'fiftyDayAverage','twoHundredDayAverage',
    'trailingPE','forwardPE','priceToBook',
    'marketCap','dividendYield',
    'regularMarketOpen','regularMarketDayHigh','regularMarketDayLow',
    'regularMarketPreviousClose',
  ].join(',');

  const path = `/v7/finance/quote?symbols=${encodeURIComponent(syms.join(','))}&fields=${fields}`;

  try {
    const { data, cached } = await yfFetch(path);
    const quotes = data?.quoteResponse?.result || [];
    res.json({
      ok: true,
      cached,
      count: quotes.length,
      quotes,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /api/spark ────────────────────────────────────────────────────────────────
app.get('/api/spark', async (req, res) => {
  const symbol   = req.query.symbol;
  const range    = ['1d','5d','1mo','3mo'].includes(req.query.range) ? req.query.range : '1d';
  const interval = ['1m','2m','5m','15m','30m','60m','1d'].includes(req.query.interval) ? req.query.interval : '5m';

  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });

  const path = `/v8/finance/spark?symbols=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`;

  try {
    const { data, cached } = await yfFetch(path);
    const result = data?.spark?.result?.[0]?.response?.[0];
    if (!result) return res.status(404).json({ error: 'No spark data for ' + symbol });

    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];
    const volumes    = result.indicators?.quote?.[0]?.volume || [];
    const highs      = result.indicators?.quote?.[0]?.high || [];
    const lows       = result.indicators?.quote?.[0]?.low || [];

    res.json({
      ok: true,
      cached,
      symbol,
      range,
      interval,
      meta: result.meta || {},
      timestamps,
      closes:  closes.map(v => v != null ? +v.toFixed(4) : null),
      volumes: volumes.map(v => v != null ? Math.round(v) : null),
      highs:   highs.map(v => v != null ? +v.toFixed(4) : null),
      lows:    lows.map(v => v != null ? +v.toFixed(4) : null),
      count:   timestamps.length,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /api/search ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 1) return res.status(400).json({ error: 'q query param required' });

  const path = `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  try {
    const { data, cached } = await yfFetch(path);
    const quotes = (data.quotes || []).map(r => ({
      symbol:    r.symbol,
      shortname: r.shortname || r.longname || '',
      type:      r.typeDisp || r.quoteType || '',
      exchange:  r.exchDisp || '',
    }));
    res.json({ ok: true, cached, quotes });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /api/fear-greed ───────────────────────────────────────────────────────────
app.get('/api/fear-greed', async (req, res) => {
  const cacheKey = 'fng';
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, ...hit });

  try {
    const data = await fetchJSON('https://api.alternative.me/fng/?limit=1&format=json', 6000);
    const item = data.data?.[0];
    if (!item) throw new Error('No F&G data');
    const result = {
      value:           parseInt(item.value),
      classification:  item.value_classification,
      timestamp:       item.timestamp,
    };
    setCache(cacheKey, result, 4 * 60 * 60 * 1000); // 4 hours
    res.json({ ok: true, cached: false, ...result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /api/fx ───────────────────────────────────────────────────────────────────
app.get('/api/fx', async (req, res) => {
  const from = (req.query.from || 'USD').toUpperCase().slice(0, 3);
  const to   = (req.query.to   || 'THB').toUpperCase().slice(0, 3);
  const cacheKey = `fx:${from}:${to}`;
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, from, to, rate: hit });

  try {
    const data = await fetchJSON(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, 6000);
    const rate = data.rates?.[to];
    if (!rate) throw new Error(`No rate for ${from}/${to}`);
    setCache(cacheKey, rate, 60 * 60 * 1000); // 1 hour
    res.json({ ok: true, cached: false, from, to, rate, date: data.date });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /api/cache/clear ──────────────────────────────────────────────────────────
app.get('/api/cache/clear', (req, res) => {
  const before = cache.size;
  cache.clear();
  res.json({ ok: true, cleared: before, message: 'Cache cleared' });
});

// ─── 404 HANDLER ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found. See GET / for available endpoints.' });
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const cacheLbl = CACHE_TTL_MS < 60000
    ? (CACHE_TTL_MS / 1000 + ' sec')
    : (CACHE_TTL_MS / 60000 + ' min');
  console.log([
    '╔════════════════════════════════════════╗',
    '║       TradeRadar API Server v1.0       ║',
    '╠════════════════════════════════════════╣',
    '║  Port  : ' + PORT.toString().padEnd(29) + '║',
    '║  Cache : ' + cacheLbl.padEnd(29)         + '║',
    '║  Rate  : ' + (RATE_LIMIT + ' req/min').padEnd(29) + '║',
    '║  Auth  : API Key required              ║',
    '╚════════════════════════════════════════╝',
  ].join('\n'));
});

module.exports = app;
