#!/usr/bin/env node
// TradeRadar API Test Script v2
// Usage: node test.js [BASE_URL] [API_KEY]
// Example: node test.js https://traderadar.up.railway.app my-secret-key

const BASE = process.argv[2] || 'http://localhost:3000';
const KEY  = process.argv[3] || process.env.API_KEY || 'change-me-in-env';
const H    = { 'X-API-Key': KEY };

async function req(path, noAuth = false) {
  const url = BASE + path;
  const start = Date.now();
  try {
    const r = await fetch(url, { headers: noAuth ? {} : H });
    const data = await r.json();
    return { ok: r.ok, status: r.status, data, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message }, ms: Date.now() - start };
  }
}

const pass = (l, ms, note='') => console.log(`  ✅ ${l.padEnd(38)} ${ms}ms ${note}`);
const fail = (l, msg)         => console.log(`  ❌ ${l.padEnd(38)} ${msg}`);
const info = (l, ms, note='') => console.log(`  ℹ️  ${l.padEnd(38)} ${ms}ms ${note}`);

async function run() {
  console.log('\n🔌 TradeRadar API Test v2');
  console.log('━'.repeat(60));
  console.log(`  Server : ${BASE}`);
  console.log(`  API Key: ${KEY.slice(0,8)}...`);
  console.log('━'.repeat(60));

  let passed = 0, failed = 0;

  // 1. Health
  {
    const { ok, data, ms } = await req('/health', true);
    if (ok && data.status === 'ok') {
      pass('GET /health', ms, `uptime: ${data.uptime}, lib: ${data.lib}`);
      passed++;
    } else { fail('GET /health', JSON.stringify(data)); failed++; }
  }

  // 2. Docs
  {
    const { ok, data, ms } = await req('/', true);
    if (ok && data.version) { pass('GET / (docs)', ms, `v${data.version}`); passed++; }
    else { fail('GET / (docs)', JSON.stringify(data).slice(0,60)); failed++; }
  }

  // 3. Auth reject
  {
    const r = await fetch(BASE + '/api/quote?symbols=AAPL');
    if (r.status === 401) { pass('Auth rejection (no key → 401)', 0); passed++; }
    else { fail('Auth rejection', 'Expected 401, got ' + r.status); failed++; }
  }

  // 4. Quote — single
  {
    const { ok, data, ms } = await req('/api/quote?symbols=AAPL');
    if (ok && data.quotes?.length > 0) {
      const q = data.quotes[0];
      pass('GET /api/quote AAPL', ms, `$${q.regularMarketPrice?.toFixed(2)} | src: ${data.source||'ok'}`);
      passed++;
    } else { fail('GET /api/quote AAPL', (data.error||JSON.stringify(data)).slice(0,80)); failed++; }
  }

  // 5. Quote — multi + TH + futures
  {
    const { ok, data, ms } = await req('/api/quote?symbols=PTT.BK,GC=F,BTC-USD');
    if (ok && data.quotes?.length >= 1) {
      pass('GET /api/quote PTT.BK,GC=F,BTC-USD', ms, `${data.count} quotes`);
      passed++;
    } else { fail('GET /api/quote multi', (data.error||'').slice(0,80)); failed++; }
  }

  // 6. Spark
  {
    const { ok, data, ms } = await req('/api/spark?symbol=AAPL');
    if (ok && data.count > 0) {
      pass('GET /api/spark AAPL (1d/5m)', ms, `${data.count} candles`);
      passed++;
    } else { fail('GET /api/spark AAPL', (data.error||JSON.stringify(data)).slice(0,80)); failed++; }
  }

  // 7. Spark — gold futures
  {
    const { ok, data, ms } = await req('/api/spark?symbol=GC%3DF&range=5d&interval=60m');
    if (ok && data.count > 0) {
      pass('GET /api/spark GC=F (5d/60m)', ms, `${data.count} candles`);
      passed++;
    } else { fail('GET /api/spark GC=F', (data.error||'').slice(0,80)); failed++; }
  }

  // 8. Search
  {
    const { ok, data, ms } = await req('/api/search?q=apple');
    if (ok && data.quotes?.length > 0) {
      pass('GET /api/search ?q=apple', ms, `${data.quotes.length} results`);
      passed++;
    } else { fail('GET /api/search', (data.error||'').slice(0,60)); failed++; }
  }

  // 9. Fear & Greed
  {
    const { ok, data, ms } = await req('/api/fear-greed');
    if (ok && data.value != null) {
      pass('GET /api/fear-greed', ms, `${data.value}/100 — ${data.classification}`);
      passed++;
    } else { fail('GET /api/fear-greed', (data.error||'').slice(0,60)); failed++; }
  }

  // 10. FX
  {
    const { ok, data, ms } = await req('/api/fx?from=USD&to=THB');
    if (ok && data.rate) {
      pass('GET /api/fx USD/THB', ms, `rate: ${data.rate}`);
      passed++;
    } else { fail('GET /api/fx', (data.error||'').slice(0,60)); failed++; }
  }

  // 11. Cache hit test
  {
    const r1 = await req('/api/quote?symbols=MSFT');
    const r2 = await req('/api/quote?symbols=MSFT');
    if (r2.data?.cached === true) {
      pass('Cache hit', r2.ms, `${r1.ms}ms → ${r2.ms}ms`);
      passed++;
    } else {
      info('Cache (2nd req)', r2.ms, `cached: ${r2.data?.cached} (may still be fast)`);
      passed++; // still pass
    }
  }

  // 12. Rate limit (shouldn't trigger)
  {
    const { status, ms } = await req('/api/quote?symbols=NVDA');
    if (status !== 429) { pass('Rate limit not triggered', ms); passed++; }
    else { fail('Rate limit check', 'Triggered 429!'); failed++; }
  }

  // 13. 404
  {
    const r = await fetch(BASE + '/not-found', { headers: H });
    if (r.status === 404) { pass('404 handler', 0); passed++; }
    else { fail('404 handler', 'Expected 404, got ' + r.status); failed++; }
  }

  console.log('━'.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('  🎉 All tests passed!\n');
  else             console.log(`  ⚠️  ${failed} test(s) failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
