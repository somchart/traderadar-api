#!/usr/bin/env node
// TradeRadar API Test Script v3 (ESM)
// Usage: node test.js [BASE_URL] [API_KEY]

const BASE = process.argv[2] || 'http://localhost:3000';
const KEY  = process.argv[3] || process.env.API_KEY || 'change-me-in-env';
const H    = { 'X-API-Key': KEY };

async function req(path, noAuth=false) {
  const start=Date.now();
  try {
    const r=await fetch(BASE+path,{headers:noAuth?{}:H});
    return {ok:r.ok,status:r.status,data:await r.json(),ms:Date.now()-start};
  } catch(e) {
    return {ok:false,status:0,data:{error:e.message},ms:Date.now()-start};
  }
}
const pass=(l,ms,n='')=>console.log(`  ✅ ${l.padEnd(40)} ${ms}ms ${n}`);
const fail=(l,m)=>       console.log(`  ❌ ${l.padEnd(40)} ${m}`);

async function run() {
  console.log('\n🔌 TradeRadar API Test v3');
  console.log('━'.repeat(60));
  console.log(`  Server : ${BASE}\n  Key    : ${KEY.slice(0,8)}...`);
  console.log('━'.repeat(60));
  let passed=0,failed=0;

  const t=async(label,fn)=>{ try{ await fn(); passed++; }catch(e){ fail(label,e.message); failed++; } };

  // 1. Health
  await t('GET /health',async()=>{
    const {ok,data,ms}=await req('/health',true);
    if(!ok||data.status!=='ok') throw new Error('status:'+data.status);
    pass('GET /health',ms,`uptime:${data.uptime} yf:${data.yf}`);
  });

  // 2. Auth reject
  await t('Auth reject → 401',async()=>{
    const r=await fetch(BASE+'/api/quote?symbols=AAPL');
    if(r.status!==401) throw new Error('Expected 401, got '+r.status);
    pass('Auth reject → 401',0);
  });

  // 3. Quote single
  await t('GET /api/quote AAPL',async()=>{
    const {ok,data,ms}=await req('/api/quote?symbols=AAPL');
    if(!ok||!data.quotes?.length) throw new Error(data.error||'no quotes');
    pass('GET /api/quote AAPL',ms,`$${data.quotes[0].regularMarketPrice?.toFixed(2)}`);
  });

  // 4. Quote multi (TH + futures)
  await t('GET /api/quote PTT.BK,GC=F',async()=>{
    const {ok,data,ms}=await req('/api/quote?symbols=PTT.BK,GC=F');
    if(!ok||data.count<1) throw new Error(data.error||'count:'+data.count);
    pass('GET /api/quote PTT.BK,GC=F',ms,`${data.count} quotes`);
  });

  // 5. Spark
  await t('GET /api/spark AAPL',async()=>{
    const {ok,data,ms}=await req('/api/spark?symbol=AAPL');
    if(!ok||data.count<1) throw new Error(data.error||'count:'+data.count);
    pass('GET /api/spark AAPL',ms,`${data.count} candles`);
  });

  // 6. Search
  await t('GET /api/search',async()=>{
    const {ok,data,ms}=await req('/api/search?q=apple');
    if(!ok||!data.quotes?.length) throw new Error(data.error||'no results');
    pass('GET /api/search',ms,`${data.quotes.length} results`);
  });

  // 7. Fear & Greed
  await t('GET /api/fear-greed',async()=>{
    const {ok,data,ms}=await req('/api/fear-greed');
    if(!ok||data.value==null) throw new Error(data.error||'no value');
    pass('GET /api/fear-greed',ms,`${data.value}/100 — ${data.classification}`);
  });

  // 8. FX
  await t('GET /api/fx',async()=>{
    const {ok,data,ms}=await req('/api/fx?from=USD&to=THB');
    if(!ok||!data.rate) throw new Error(data.error||'no rate');
    pass('GET /api/fx USD/THB',ms,`rate:${data.rate}`);
  });

  // 9. Cache hit
  await t('Cache hit (2nd request)',async()=>{
    await req('/api/quote?symbols=MSFT');
    const {data,ms}=await req('/api/quote?symbols=MSFT');
    pass('Cache hit (2nd request)',ms,`cached:${data.cached}`);
  });

  // 10. 404
  await t('404 handler',async()=>{
    const r=await fetch(BASE+'/not-found',{headers:H});
    if(r.status!==404) throw new Error('Expected 404, got '+r.status);
    pass('404 handler',0);
  });

  console.log('━'.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  failed===0 ? console.log('  🎉 All tests passed!\n') : console.log(`  ⚠️  ${failed} failed\n`);
  process.exit(failed>0?1:0);
}

run().catch(e=>{console.error('Fatal:',e.message);process.exit(1);});
