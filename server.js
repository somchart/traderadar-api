'use strict';

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_KEY       = process.env.API_KEY      || 'change-me-in-env';
const CACHE_TTL_MS  = parseInt(process.env.CACHE_TTL_MS || '60000');   // 60s
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT   || '120');     // req/min
const ALLOWED_ORIGIN= process.env.ALLOWED_ORIGIN || '*';

// ─── YAHOO FINANCE LIBRARY — lazy loaded ─────────────────────────────────────
// yahoo-finance2@2.8.0 = last CommonJS-compatible version (pinned in package.json).
// Loaded lazily so /health responds IMMEDIATELY on container start.
// Railway healthcheck hits /health within seconds of boot — yf must not block.
let yf       = null;
let yfReady  = false;
let yfError  = null;

function loadYF() {
  if (yfReady) return;
  try {
    // v2.8.0 CommonJS: handle both module shapes
    const mod = require('yahoo-finance2');
    yf = (mod && mod.default && typeof mod.default.quote === 'function')
      ? mod.default
      : mod;
    if (typeof yf.quote !== 'function') {
      throw new Error('yf.quote not found — check yahoo-finance2 version');
    }
    yf.setGlobalConfig({ validation: { logErrors: false } });
    yfReady = true;
    yfError = null;
    console.log('[yf] yahoo-finance2@2.8.0 loaded OK');
  } catch (e) {
    yf      = null;
    yfReady = false;
    yfError = e.message;
    console.error('[yf] load failed:', e.message);
  }
}

function getYF() {
  if (!yfReady) {
    loadYF();
    if (!yfReady) {
      throw new Error('yahoo-finance2 unavailable: ' + (yfError || 'still loading'));
    }
  }
  return yf;
}


// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, exp: Date.now() + ttl });
}
function cacheStats() {
  let valid = 0;
  const now = Date.now();
  cache.forEach(v => { if (now < v.exp) valid++; });
  return { total: cache.size, valid, ttl_ms: CACHE_TTL_MS };
}

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const buckets = new Map();
function checkRate(ip) {
  const now = Date.now();
  const e = buckets.get(ip) || { n: 0, reset: now + 60_000 };
  if (now > e.reset) { e.n = 0; e.reset = now + 60_000; }
  e.n++;
  buckets.set(ip, e);
  return e.n <= RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  buckets.forEach((v, k) => { if (now > v.reset + 60_000) buckets.delete(k); });
}, 300_000);

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN.split(','),
  methods: ['GET'],
}));

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ error: `Rate limit: max ${RATE_LIMIT} req/min` });
  next();
});

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Invalid or missing X-API-Key header' });
  next();
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function safeNum(v, digits = 4) {
  if (v == null || !isFinite(v)) return null;
  return +Number(v).toFixed(digits);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// ── GET /health ───────────────────────────────────────────────────────────────
// MUST respond instantly — no async operations here
app.get('/health', (req, res) => {
  res.status(200).json({
    status:  'ok',
    uptime:  Math.round(process.uptime()) + 's',
    cache:   cacheStats(),
    version: '2.0.0',
    lib:     'yahoo-finance2',
    yf:      yfReady ? 'ready' : yfError ? 'error: ' + yfError : 'loading',
    time:    new Date().toISOString(),
  });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name:    'TradeRadar API v2',
    version: '2.0.0',
    lib:     'yahoo-finance2 (server-native, no CORS issues)',
    auth:    'X-API-Key header required on all /api/* endpoints',
    endpoints: {
      '/health':                          'Server health (no auth)',
      '/api/quote?symbols=AAPL,GC=F':    'Quotes for up to 20 symbols',
      '/api/spark?symbol=AAPL':          'Intraday OHLCV chart data',
      '/api/spark?symbol=AAPL&range=5d': 'range: 1d 5d 1mo 3mo | interval: 1m 5m 15m 60m 1d',
      '/api/search?q=apple':             'Symbol search',
      '/api/fear-greed':                 'Crypto Fear & Greed Index',
      '/api/fx?from=USD&to=THB':         'Exchange rate (Frankfurter/ECB)',
      '/api/cache/clear':                'Clear server cache',
    },
  });
});

// ── GET /api/quote ────────────────────────────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  const raw = req.query.symbols || req.query.symbol || '';
  if (!raw) return res.status(400).json({ error: 'symbols param required. Example: ?symbols=AAPL,GC=F' });

  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (syms.length > 20) return res.status(400).json({ error: 'Max 20 symbols per request' });

  const cacheKey = 'quote:' + syms.join(',');
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, count: hit.length, quotes: hit, timestamp: new Date().toISOString() });

  try {
    // yahoo-finance2 quoteSummary works per-symbol; batch via Promise.allSettled
    const results = await Promise.allSettled(
      syms.map(sym => getYF().quote(sym, {}, { validateResult: false }))
    );

    const quotes = results.map((r, i) => {
      if (r.status === 'rejected') {
        return { symbol: syms[i], error: r.reason?.message || 'fetch failed' };
      }
      const q = r.value || {};
      return {
        symbol:                      q.symbol     || syms[i],
        shortName:                   q.shortName  || q.longName || syms[i],
        regularMarketPrice:          safeNum(q.regularMarketPrice, 4),
        regularMarketChange:         safeNum(q.regularMarketChange, 4),
        regularMarketChangePercent:  safeNum(q.regularMarketChangePercent, 4),
        regularMarketVolume:         q.regularMarketVolume   ?? null,
        averageVolume:               q.averageDailyVolume10Day ?? q.averageVolume ?? null,
        fiftyTwoWeekHigh:            safeNum(q.fiftyTwoWeekHigh, 4),
        fiftyTwoWeekLow:             safeNum(q.fiftyTwoWeekLow, 4),
        fiftyDayAverage:             safeNum(q.fiftyDayAverage, 4),
        twoHundredDayAverage:        safeNum(q.twoHundredDayAverage, 4),
        trailingPE:                  safeNum(q.trailingPE, 2),
        forwardPE:                   safeNum(q.forwardPE, 2),
        marketCap:                   q.marketCap   ?? null,
        dividendYield:               safeNum(q.dividendYield, 4),
        regularMarketOpen:           safeNum(q.regularMarketOpen, 4),
        regularMarketDayHigh:        safeNum(q.regularMarketDayHigh, 4),
        regularMarketDayLow:         safeNum(q.regularMarketDayLow, 4),
        regularMarketPreviousClose:  safeNum(q.regularMarketPreviousClose, 4),
        currency:                    q.currency    || null,
        exchangeName:                q.fullExchangeName || q.exchange || null,
      };
    }).filter(q => q.regularMarketPrice != null);

    if (quotes.length === 0) {
      return res.status(502).json({ error: 'No valid quotes returned. Symbols may be invalid or Yahoo Finance is throttling.' });
    }

    setCache(cacheKey, quotes);
    res.json({ ok: true, cached: false, count: quotes.length, quotes, timestamp: new Date().toISOString() });

  } catch (e) {
    console.error('[quote]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/spark ────────────────────────────────────────────────────────────
app.get('/api/spark', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol param required. Example: ?symbol=AAPL' });

  const VALID_RANGES    = ['1d','5d','1mo','3mo','6mo','1y'];
  const VALID_INTERVALS = ['1m','2m','5m','15m','30m','60m','90m','1h','1d','1wk'];
  const range    = VALID_RANGES.includes(req.query.range)       ? req.query.range    : '1d';
  const interval = VALID_INTERVALS.includes(req.query.interval) ? req.query.interval : '5m';

  const cacheKey = `spark:${symbol}:${range}:${interval}`;
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, ...hit });

  try {
    const result = await getYF().chart(symbol, {
      period1:  range === '1d' ? (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })() : (() => {
        const d = new Date();
        const days = { '5d':5,'1mo':30,'3mo':90,'6mo':180,'1y':365 }[range] || 30;
        d.setDate(d.getDate() - days); return d;
      })(),
      interval,
      includePrePost: false,
    }, { validateResult: false });

    const quotes = result?.quotes || [];
    if (quotes.length === 0) {
      return res.status(404).json({ error: `No chart data for ${symbol} (range: ${range}, interval: ${interval})` });
    }

    const timestamps = quotes.map(q => Math.floor(new Date(q.date).getTime() / 1000));
    const closes  = quotes.map(q => safeNum(q.close, 4));
    const opens   = quotes.map(q => safeNum(q.open, 4));
    const highs   = quotes.map(q => safeNum(q.high, 4));
    const lows    = quotes.map(q => safeNum(q.low, 4));
    const volumes = quotes.map(q => q.volume ?? null);

    const meta = result?.meta || {};
    const payload = {
      symbol,
      range,
      interval,
      currency: meta.currency,
      exchange: meta.exchangeName,
      meta: {
        regularMarketPrice:  safeNum(meta.regularMarketPrice, 4),
        previousClose:       safeNum(meta.chartPreviousClose || meta.previousClose, 4),
        regularMarketTime:   meta.regularMarketTime,
      },
      timestamps,
      closes,
      opens,
      highs,
      lows,
      volumes,
      count: timestamps.length,
    };

    setCache(cacheKey, payload);
    res.json({ ok: true, cached: false, ...payload });

  } catch (e) {
    console.error('[spark]', symbol, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/search ───────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q param required' });

  const cacheKey = 'search:' + q.toLowerCase();
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, quotes: hit });

  try {
    const result = await getYF().search(q, { quotesCount: 8, newsCount: 0 }, { validateResult: false });
    const quotes = (result?.quotes || []).map(r => ({
      symbol:    r.symbol,
      shortname: r.shortname || r.longname || r.symbol,
      type:      r.typeDisp  || r.quoteType || '—',
      exchange:  r.exchDisp  || r.exchange  || '—',
    }));
    setCache(cacheKey, quotes, 300_000); // 5 min for search
    res.json({ ok: true, cached: false, quotes });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/fear-greed ───────────────────────────────────────────────────────
app.get('/api/fear-greed', async (req, res) => {
  const cacheKey = 'fng';
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, ...hit });

  try {
    // Use native https since this endpoint works fine from Railway
    const data = await new Promise((resolve, reject) => {
      const https = require('https');
      const req = https.get('https://api.alternative.me/fng/?limit=1&format=json', {
        headers: { 'User-Agent': 'TradeRadar/2.0', 'Accept': 'application/json' },
        timeout: 8000,
      }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    const item = data?.data?.[0];
    if (!item) throw new Error('Unexpected response from alternative.me');

    const payload = {
      value:          parseInt(item.value),
      classification: item.value_classification,
      timestamp:      item.timestamp,
    };
    setCache(cacheKey, payload, 4 * 60 * 60 * 1000); // 4h
    res.json({ ok: true, cached: false, ...payload });
  } catch (e) {
    console.error('[fear-greed]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/fx ───────────────────────────────────────────────────────────────
app.get('/api/fx', async (req, res) => {
  const from = (req.query.from || 'USD').toUpperCase().slice(0, 3);
  const to   = (req.query.to   || 'THB').toUpperCase().slice(0, 3);

  const cacheKey = `fx:${from}:${to}`;
  const hit = getCache(cacheKey);
  if (hit) return res.json({ ok: true, cached: true, from, to, ...hit });

  try {
    const data = await new Promise((resolve, reject) => {
      const https = require('https');
      const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
      const req = https.get(url, {
        headers: { 'User-Agent': 'TradeRadar/2.0', 'Accept': 'application/json' },
        timeout: 8000,
      }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    const rate = data?.rates?.[to];
    if (!rate) throw new Error(`No rate for ${from}/${to} — check currency codes`);

    const payload = { rate, date: data.date };
    setCache(cacheKey, payload, 60 * 60 * 1000); // 1h
    res.json({ ok: true, cached: false, from, to, ...payload });
  } catch (e) {
    console.error('[fx]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/cache/clear ──────────────────────────────────────────────────────
app.get('/api/cache/clear', (req, res) => {
  const before = cache.size;
  cache.clear();
  res.json({ ok: true, cleared: before });
});

// ─── 404 / ERROR ──────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found. See GET / for docs.' }));
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
    '║    TradeRadar API Server v2.0          ║',
    '╠════════════════════════════════════════╣',
    '║  Port  : ' + String(PORT).padEnd(29)           + '║',
    '║  Cache : ' + cacheLbl.padEnd(29)               + '║',
    '║  Rate  : ' + (RATE_LIMIT+' req/min').padEnd(29) + '║',
    '║  Lib   : yahoo-finance2 (lazy)        ║',
    '║  Auth  : API Key required             ║',
    '╚════════════════════════════════════════╝',
  ].join('\n'));

  // ⚡ Load yahoo-finance2 in background AFTER server is already listening.
  // This guarantees /health responds immediately for Railway healthcheck.
  setImmediate(() => {
    console.log('[yf] loading yahoo-finance2...');
    loadYF();
  });
});

module.exports = app;
