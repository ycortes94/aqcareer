// Compare cold page loads with fonts deliberately delayed. Requires externally
// installed Playwright and Chrome; no analytics or production forms are called.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const zlib=require('node:zlib');
const baseline=process.env.PERF_BASELINE_ROOT;
assert.ok(baseline,'Set PERF_BASELINE_ROOT to a clean snapshot of the original site');
const rounds=Number(process.env.PERF_ROUNDS||5);
const designs=(process.env.PERF_DESIGNS||'control,fresh_take,raices').split(',');
const delay=1000;
function serve(root){
 const cache=new Map();
 return http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');let file=path.join(root,decodeURIComponent(url.pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{
   if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');
   const type=file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webp')?'image/webp':file.endsWith('.png')?'image/png':file.endsWith('.jpg')?'image/jpeg':'application/octet-stream';
   if(!cache.has(file))cache.set(file,zlib.gzipSync(fs.readFileSync(file),{level:9}));
   res.writeHead(200,{'Content-Type':type,'Content-Encoding':'gzip','Cache-Control':'no-store'});res.end(cache.get(file));
  }catch{res.writeHead(404);res.end();}
 });
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
(async()=>{
 const servers=[serve(path.resolve(baseline)),serve(path.resolve('.'))];let browser;
 try{
  for(const s of servers)await new Promise(r=>s.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  const data=[];
  for(const design of designs)for(let round=0;round<rounds;round++) {
   // Alternate order to reduce systematic warmup/thermal bias.
   for(const variant of round%2?['security','baseline']:['baseline','security']){
    const origin=`http://127.0.0.1:${servers[variant==='baseline'?0:1].address().port}`;
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:2});
    await context.addInitScript(()=>{
     window.perfSample={lcp:0,longTasks:0,fontsFinished:0};
     new PerformanceObserver(list=>{for(const e of list.getEntries()){window.perfSample.lcp=e.startTime;window.perfSample.lcpUrl=e.url;window.perfSample.lcpElement=e.element?.outerHTML.slice(0,300);}}).observe({type:'largest-contentful-paint',buffered:true});
     new PerformanceObserver(list=>{for(const e of list.getEntries())window.perfSample.longTasks+=e.duration;}).observe({type:'longtask',buffered:true});
     window.fontsReady=[];
     addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('link[href^="https://fonts.googleapis.com"]').forEach(l=>l.addEventListener('load',()=>window.fontsReady.push(l.href)));});
    });
    const page=await context.newPage();const cdp=await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:80,downloadThroughput:1.6*1024*1024/8,uploadThroughput:750*1024/8});
    let fontRequests=0;
    await context.route('**/*',async route=>{
     const url=route.request().url();if(url.startsWith(origin+'/'))return route.continue();
     if(url.startsWith('https://fonts.googleapis.com/')){
      fontRequests++;await new Promise(r=>setTimeout(r,delay));
      return route.fulfill({contentType:'text/css',body:'/* delayed font CSS: intentionally no remote fonts */'});
     }
     if(url.includes('challenges.cloudflare.com'))return route.fulfill({contentType:'text/javascript',body:"window.turnstile={render:function(){return 'mock';},reset:function(){},getResponse:function(){return '';}};"});
     throw Error('Unexpected external request before consent: '+url);
    });
    await page.goto(origin+'/?design='+design,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>performance.getEntriesByName('first-contentful-paint').length>0);
    // Allow both deliberately slow font stylesheets and late paint entries to settle.
    await page.waitForLoadState('load');
    await page.evaluate(()=>Promise.all([...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.width&&r.height&&r.top<innerHeight&&r.bottom>0;}).map(img=>img.decode().catch(()=>{}))));
    await page.waitForTimeout(delay+400);
    const metrics=await page.evaluate(()=>({
     fcp:performance.getEntriesByName('first-contentful-paint')[0].startTime,
     lcp:window.perfSample.lcp,lcpUrl:window.perfSample.lcpUrl,lcpElement:window.perfSample.lcpElement,domContentLoaded:performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,resources:performance.getEntriesByType('resource').map(e=>({name:e.name.replace(location.origin,''),start:e.startTime,end:e.responseEnd})),longTasks:window.perfSample.longTasks,
     requests:performance.getEntriesByType('resource').length,
     scriptRequests:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.endsWith('.js')).length,
     fontsApplied:[...document.querySelectorAll('link[data-async-font]')].every(l=>l.media==='all'),
     layout:document.documentElement.getAttribute('data-home-design')
    }));
    assert.equal(metrics.layout,design);assert.equal(metrics.fontsApplied,true);
    assert.equal(await page.locator('script[integrity]').count(),0,'analytics still waits for consent');
    const interactionMs=await page.evaluate(()=>new Promise(resolve=>{
     const trigger=[...document.querySelectorAll('[data-waitlist="open"]')].find(el=>el.getClientRects().length);
     if(!trigger)throw Error('No visible waitlist trigger');
     const start=performance.now();trigger.click();
     if(!document.querySelector('dialog[open]'))throw Error('Waitlist did not open');
     requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));
    }));
    data.push({design,round,variant,fontRequests,interactionMs,...metrics});await context.close();
   }
  }
  const summary=designs.map(design=>{
   const row={design};for(const variant of ['baseline','security']){
    const rows=data.filter(r=>r.design===design&&r.variant===variant);
    row[variant]={fcpMs:Math.round(median(rows.map(r=>r.fcp))),lcpMs:Math.round(median(rows.map(r=>r.lcp))),domReadyMs:Math.round(median(rows.map(r=>r.domContentLoaded))),longTasksMs:Math.round(median(rows.map(r=>r.longTasks))),interactionMs:Math.round(median(rows.map(r=>r.interactionMs))),requests:median(rows.map(r=>r.requests)),scriptRequests:median(rows.map(r=>r.scriptRequests)),fontRequests:median(rows.map(r=>r.fontRequests))};
   }return row;
  });
  console.log(JSON.stringify({conditions:{rounds,fontDelayMs:delay,cpuSlowdown:4,latencyMs:80,downloadMbps:1.6},summary},null,2));
  if(process.env.PERF_OUTPUT)fs.writeFileSync(process.env.PERF_OUTPUT,JSON.stringify({summary,data},null,2));
  for(const row of summary){
   assert.ok(row.security.fcpMs<=row.baseline.fcpMs+200,`${row.design}: first paint regression >200ms`);
   assert.ok(row.security.lcpMs<=row.baseline.lcpMs+250,`${row.design}: largest paint regression >250ms`);
   assert.ok(row.security.scriptRequests<=row.baseline.scriptRequests,`${row.design}: extra script requests`);
   assert.ok(row.security.domReadyMs<=row.baseline.domReadyMs+200,`${row.design}: document readiness regression >200ms`);
   assert.ok(row.security.interactionMs<=row.baseline.interactionMs+75,`${row.design}: dialog interaction regression >75ms`);
  }
  console.log('PASS cold mobile-style load comparison');
 }finally{if(browser)await browser.close();for(const s of servers)await new Promise(r=>s.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
