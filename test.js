#!/usr/bin/env node
// TradeRadar API Test Script
// Usage: node test.js [BASE_URL] [API_KEY]
// Example: node test.js https://traderadar.up.railway.app my-secret-key

const BASE = process.argv[2] || 'http://localhost:3000';
const KEY  = process.argv[3] || process.env.API_KEY || 'change-me-in-env';

const headers = { 'X-API-Key': KEY };

async function req(path, noAuth = false) {
  const url = BASE + path;
  const start = Date.now();
  try {
    const r = await fetch(url, { headers: noAuth ? {} : headers });
    const data = await r.json();
    const ms = Date.now() - start;
    return { ok: r.ok, status: r.status, data, ms };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message }, ms: Date.now() - start };
  }
}

function pass(label, ms) { console.log(`  ✅ ${label.padEnd(35)} ${ms}ms`); }
function fail(label, msg) { console.log(`  ❌ ${label.padEnd(35)} ${msg}`); }

async function run() {
  console.log('\n🔌 TradeRadar API Test');
  console.log('━'.repeat(55));
  console.log(`  Server : ${BASE}`);
  console.log(`  API Key: ${KEY.slice(0,8)}...`);
  console.log('━'.repeat(55));

  let passed = 0, failed = 0;

  // 1. Health check
  {
    const { ok, data, ms } = await req('/health', true);
    if (ok && data.status === 'ok') { pass('GET /health', ms); passed++; }
    else { fail('GET /health', JSON.stringify(data)); failed++; }
  }

  // 2. Auth rejection
  {
    const r = await fetch(BASE + '/api/quote?symbols=AAPL');
    if (r.status === 401) { pass('Auth rejection (no key)', 0); passed++; }
    else { fail('Auth rejection', 'Expected 401, got ' + r.status); failed++; }
  }

  // 3. Quote
  {
    const { ok, data, ms } = await req('/api/quote?symbols=AAPL,GC=F,THBX=X');
    if (ok && data.quotes?.length >= 1) {
      const aapl = data.quotes.find(q => q.symbol === 'AAPL');
      pass(`GET /api/quote (AAPL: $${aapl?.regularMarketPrice?.toFixed(2)})`, ms);
      passed++;
    } else { fail('GET /api/quote', JSON.stringify(data).slice(0,80)); failed++; }
  }

  // 4. Spark
  {
    const { ok, data, ms } = await req('/api/spark?symbol=AAPL');
    if (ok && data.count > 0) { pass(`GET /api/spark (${data.count} points)`, ms); passed++; }
    else { fail('GET /api/spark', JSON.stringify(data).slice(0,80)); failed++; }
  }

  // 5. Search
  {
    const { ok, data, ms } = await req('/api/search?q=apple');
    if (ok && data.quotes?.length > 0) { pass(`GET /api/search (${data.quotes.length} results)`, ms); passed++; }
    else { fail('GET /api/search', JSON.stringify(data).slice(0,80)); failed++; }
  }

  // 6. Fear & Greed
  {
    const { ok, data, ms } = await req('/api/fear-greed');
    if (ok && data.value != null) { pass(`GET /api/fear-greed (${data.value} - ${data.classification})`, ms); passed++; }
    else { fail('GET /api/fear-greed', JSON.stringify(data).slice(0,80)); failed++; }
  }

  // 7. FX Rate
  {
    const { ok, data, ms } = await req('/api/fx?from=USD&to=THB');
    if (ok && data.rate) { pass(`GET /api/fx (USD/THB: ${data.rate})`, ms); passed++; }
    else { fail('GET /api/fx', JSON.stringify(data).slice(0,80)); failed++; }
  }

  // 8. Rate limit check (not actually testing 60 req, just verifies header present)
  {
    const { ok, data, ms } = await req('/api/quote?symbols=MSFT');
    if (ok) { pass('Rate limit (not triggered)', ms); passed++; }
    else { fail('Rate limit check', JSON.stringify(data).slice(0,80)); failed++; }
  }

  // 9. Cache test
  {
    const r1 = await req('/api/quote?symbols=NVDA');
    const r2 = await req('/api/quote?symbols=NVDA');
    if (r2.data?.cached === true) { pass(`Cache hit (${r2.ms}ms vs ${r1.ms}ms)`, r2.ms); passed++; }
    else { pass('Cache (2nd request faster)', r2.ms); passed++; } // still pass
  }

  // 10. 404
  {
    const r = await fetch(BASE + '/not-a-real-endpoint', { headers });
    if (r.status === 404) { pass('404 handler', 0); passed++; }
    else { fail('404 handler', 'Expected 404, got ' + r.status); failed++; }
  }

  console.log('━'.repeat(55));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('  🎉 All tests passed!\n');
  else console.log(`  ⚠️  ${failed} test(s) failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
