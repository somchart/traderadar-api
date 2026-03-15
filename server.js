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
// Yahoo Finance blocks server requests unless headers look like a real browser.
// Rotate User-Agents and add all expected headers to avoid 429/502 responses.
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];
let uaIndex = 0;
function nextUA() { return UA_POOL[uaIndex++ % UA_POOL.length]; }

function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const isYahoo = url.includes('yahoo.com');
    const req = client.get(url, {
      headers: {
        'User-Agent': nextUA(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        ...(isYahoo && {
          'Referer': 'https://finance.yahoo.com/',
          'Origin':  'https://finance.yahoo.com',
        }),
      },
      timeout: timeoutMs,
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        // Drain to free socket
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      // Handle gzip/deflate via built-in zlib
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'br' || enc === 'deflate') {
        const zlib = require('zlib');
        const decomp = enc === 'gzip' ? zlib.createGunzip()
                     : enc === 'br'   ? zlib.createBrotliDecompress()
                     : zlib.createInflate();
        res.pipe(decomp);
        stream = decomp;
      }
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => { body += chunk; });
      stream.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Invalid JSON from ' + url.split('?')[0])); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout after ' + timeoutMs + 'ms')); });
  });
}

// ─── YAHOO FINANCE HELPERS ───────────────────────────────────────────────────
// Yahoo now uses /v8/finance/chart for intraday data (spark v8 deprecated).
// quote API works on both query1 and query2 — retry with backoff.
const YF_BASE  = 'https://query1.finance.yahoo.com';
const YF_BASE2 = 'https://query2.finance.yahoo.com';

async function yfFetch(path, attempt = 0) {
  const cacheKey = 'yf:' + path;
  const hit = getCache(cacheKey);
  if (hit) return { data: hit, cached: true };

  const base = attempt === 1 ? YF_BASE2 : YF_BASE;
  try {
    const data = await fetchJSON(base + path);
    setCache(cacheKey, data);
    return { data, cached: false };
  } catch (e) {
    if (attempt === 0) {
      // Short backoff then retry on query2
      await new Promise(r => setTimeout(r, 300));
      return yfFetch(path, 1);
    }
    throw new Error(`Yahoo Finance: ${e.message} (tried query1 + query2)`);
  }
}

// ─── YAHOO CRUMB (needed for v7/finance/quote since 2023) ────────────────────
let yfCrumb    = null;
let yfCookie   = null;
let crumbFetched = 0;

async function refreshCrumb() {
  // Only refresh every 55 minutes
  if (yfCrumb && Date.now() - crumbFetched < 55 * 60 * 1000) return;
  try {
    // Step 1: get cookie from finance.yahoo.com
    const cookieRes = await new Promise((resolve, reject) => {
      https.get('https://finance.yahoo.com/', {
        headers: {
          'User-Agent': nextUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: 8000,
      }, resolve).on('error', reject).on('timeout', function(){ this.destroy(); reject(new Error('timeout')); });
    });
    cookieRes.resume(); // drain
    const cookies = cookieRes.headers['set-cookie'] || [];
    yfCookie = cookies.map(c => c.split(';')[0]).join('; ');

    // Step 2: fetch crumb token
    const crumbData = await new Promise((resolve, reject) => {
      const req = https.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          'User-Agent': nextUA(),
          'Cookie': yfCookie,
          'Accept': '*/*',
          'Referer': 'https://finance.yahoo.com/',
        },
        timeout: 8000,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => resolve(body.trim()));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (crumbData && crumbData.length > 0 && !crumbData.includes('<')) {
      yfCrumb = crumbData;
      crumbFetched = Date.now();
      console.log('[crumb] refreshed:', yfCrumb.slice(0, 8) + '...');
    }
  } catch (e) {
    console.warn('[crumb] refresh failed:', e.message, '— will try v8 chart fallback for quotes');
  }
}

// Fetch quote using v8/finance/chart for a single symbol (bypass crumb requirement)
async function yfChartQuote(sym) {
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d&includePrePost=false`;
  const { data } = await yfFetch(path);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error('No chart data for ' + sym);
  const m = r.meta || {};
  return {
    symbol:                     sym,
    shortName:                  m.shortName || sym,
    regularMarketPrice:         m.regularMarketPrice,
    regularMarketChange:        m.regularMarketPrice - (m.previousClose || m.chartPreviousClose || m.regularMarketPrice),
    regularMarketChangePercent: m.previousClose
      ? ((m.regularMarketPrice - m.previousClose) / m.previousClose) * 100
      : 0,
    regularMarketVolume:        r.indicators?.quote?.[0]?.volume?.find(v => v != null) || null,
    fiftyTwoWeekHigh:           m.fiftyTwoWeekHigh,
    fiftyTwoWeekLow:            m.fiftyTwoWeekLow,
    fiftyDayAverage:            m.fiftyDayAverage,
    twoHundredDayAverage:       m.twoHundredDayAverage,
    currency:                   m.currency,
    exchangeName:               m.exchangeName,
    _source: 'chart',
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check — no auth required
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.round(process.uptime()) + 's',
    cache:    getCacheStats(),
    version:  '1.1.0',
    crumb:    yfCrumb ? 'ok' : 'none',
    time:     new Date().toISOString(),
  });
});

// Docs
app.get('/', (req, res) => {
  res.json({
    name: 'TradeRadar API',
    version: '1.1.0',
    auth: 'Pass X-API-Key header on all /api/* requests',
    endpoints: {
      'GET /health':                      'Server health + cache stats (no auth)',
      'GET /api/quote?symbols=AAPL,GC=F': 'Stock quotes (uses chart API fallback if crumb unavailable)',
      'GET /api/spark?symbol=AAPL':       'Intraday chart data via /v8/finance/chart',
      'GET /api/search?q=apple':          'Symbol search',
      'GET /api/fear-greed':              'Crypto Fear & Greed Index',
      'GET /api/fx?from=USD&to=THB':      'Exchange rate (Frankfurter/ECB)',
      'GET /api/cache/clear':             'Clear server cache',
    },
  });
});

// ── /api/quote ────────────────────────────────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  const symbols = req.query.symbols || req.query.symbol;
  if (!symbols) return res.status(400).json({ error: 'symbols query param required' });

  const syms = symbols.split(',').map(s => s.trim()).filter(Boolean);
  if (syms.length > 20) return res.status(400).json({ error: 'Max 20 symbols per request' });

  // Try v7/quote with crumb first (more fields), fall back to v8/chart per-symbol
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

  try {
    // Attempt 1: v7 with crumb
    await refreshCrumb();
    const crumbParam = yfCrumb ? `&crumb=${encodeURIComponent(yfCrumb)}` : '';
    const path = `/v7/finance/quote?symbols=${encodeURIComponent(syms.join(','))}&fields=${fields}${crumbParam}`;

    let quotes = [];
    let usedChart = false;
    let cached = false;

    try {
      // Build headers with cookie if available
      const cacheKey = 'yf:' + path;
      const hit = getCache(cacheKey);
      if (hit) {
        quotes = hit?.quoteResponse?.result || [];
        cached = true;
      } else {
        const data = await new Promise((resolve, reject) => {
          const url = YF_BASE + path;
          const reqOpts = {
            headers: {
              'User-Agent': nextUA(),
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': 'https://finance.yahoo.com/',
              ...(yfCookie && { 'Cookie': yfCookie }),
            },
            timeout: 10000,
          };
          const req = https.get(url, reqOpts, (r) => {
            if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
            let body = '';
            r.setEncoding('utf8');
            r.on('data', c => body += c);
            r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); }});
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        setCache(cacheKey, data);
        quotes = data?.quoteResponse?.result || [];
      }

      // If v7 returned empty or HTTP error, fall through to chart fallback
      if (quotes.length === 0) throw new Error('v7 returned 0 quotes');

    } catch (v7err) {
      // Attempt 2: v8/chart per-symbol (no crumb required)
      console.warn('[quote] v7 failed (' + v7err.message + '), using chart fallback');
      usedChart = true;
      const results = await Promise.allSettled(syms.map(s => yfChartQuote(s)));
      quotes = results
        .map((r, i) => r.status === 'fulfilled' ? r.value : { symbol: syms[i], error: r.reason?.message })
        .filter(q => q.regularMarketPrice != null);
    }

    res.json({
      ok:        true,
      cached,
      source:    usedChart ? 'chart_fallback' : 'v7_quote',
      count:     quotes.length,
      quotes,
      timestamp: new Date().toISOString(),
    });

  } catch (e) {
    res.status(502).json({ error: e.message, hint: 'Yahoo Finance may be rate-limiting this server IP. Try again in 60s.' });
  }
});

// ── /api/spark ────────────────────────────────────────────────────────────────
// Yahoo deprecated /v8/finance/spark — use /v8/finance/chart instead
app.get('/api/spark', async (req, res) => {
  const symbol   = req.query.symbol;
  const range    = ['1d','5d','1mo','3mo'].includes(req.query.range)    ? req.query.range    : '1d';
  const interval = ['1m','2m','5m','15m','30m','60m','1d'].includes(req.query.interval) ? req.query.interval : '5m';

  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });

  // /v8/finance/chart is the live endpoint (spark was a thin wrapper around this)
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;

  try {
    const { data, cached } = await yfFetch(path);
    const result = data?.chart?.result?.[0];
    if (!result) {
      const errMsg = data?.chart?.error?.description || 'No chart data for ' + symbol;
      return res.status(404).json({ error: errMsg });
    }

    const timestamps = result.timestamp || [];
    const quote      = result.indicators?.quote?.[0] || {};
    const meta       = result.meta || {};

    res.json({
      ok:        true,
      cached,
      symbol,
      range,
      interval,
      currency:  meta.currency,
      exchange:  meta.exchangeName,
      meta: {
        regularMarketPrice:         meta.regularMarketPrice,
        previousClose:              meta.previousClose || meta.chartPreviousClose,
        regularMarketTime:          meta.regularMarketTime,
      },
      timestamps,
      closes:  (quote.close  || []).map(v => v != null ? +v.toFixed(4) : null),
      opens:   (quote.open   || []).map(v => v != null ? +v.toFixed(4) : null),
      highs:   (quote.high   || []).map(v => v != null ? +v.toFixed(4) : null),
      lows:    (quote.low    || []).map(v => v != null ? +v.toFixed(4) : null),
      volumes: (quote.volume || []).map(v => v != null ? Math.round(v) : null),
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
