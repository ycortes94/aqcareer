// Optional real-browser verification. Supply PLAYWRIGHT_MODULE pointing to an
// installed Playwright package; this test never submits production forms.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const source=fs.readFileSync('assets/js/analytics.js','utf8');
const bundles=[...source.matchAll(/^    (amplitude|replay|statsig): '(https:[^']+)'/gm)].map(m=>({name:m[1],url:m[2],bytes:execFileSync('curl',['-fLsS','--compressed','--max-time','45',m[2]],{maxBuffer:4*1024*1024})}));
const root=path.resolve('.');
const server=http.createServer((req,res)=>{
  let file=path.join(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(403);res.end();return;}
  try {if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch {res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
 try {
  for(const design of ['control','fresh_take','raices']) {
   const context=await browser.newContext(); const page=await context.newPage();
   await page.addInitScript(()=>{window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push(e.violatedDirective+':'+e.blockedURI));});
   await context.route('**/*',async route=>{
    if (route.request().url().startsWith(origin+'/')) return route.continue();
    const url=route.request().url(); const bundle=bundles.find(b=>b.url===url);
    if(bundle)return route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*','Content-Type':'text/javascript'},body:bundle.bytes});
    if(url.startsWith('https://fonts.googleapis.com/'))return route.fulfill({contentType:'text/css',body:''});
    if(url.includes('challenges.cloudflare.com/turnstile/v0/api.js'))return route.fulfill({contentType:'text/javascript',body:"window.turnstile={render:function(s,o){window.widgetAction=o.action;return 'widget';},reset:function(){},getResponse:function(){return 'mock-token';}};"});
    // No production analytics or form data leaves the browser during this test.
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
   });
   await page.goto(origin+'/?design='+design);
   assert.equal(await page.locator('html').getAttribute('data-home-design'),design);
   assert.equal(await page.locator('script[integrity]').count(),0,'no analytics SDK before consent');
   await page.locator('[data-aq-consent="accept"]').first().click();
   await page.waitForFunction(()=>document.querySelectorAll('script[integrity]').length===3);
   await page.waitForFunction(()=>typeof window.amplitude==='object'&&typeof window.sessionReplay==='object');
   for(const b of bundles) {
    const script=await page.locator(`script[src="${b.url}"]`).getAttribute('integrity');
    assert.equal(script,'sha384-'+crypto.createHash('sha384').update(b.bytes).digest('base64'));
   }
   // Known local inline scripts are hash-authorized; an arbitrary inline script is blocked.
   await page.evaluate(()=>{const s=document.createElement('script');s.textContent='window.injectedSecuritySentinel=true';document.head.appendChild(s);});
   assert.equal(await page.evaluate(()=>window.injectedSecuritySentinel),undefined);
   const violations=await page.evaluate(()=>window.cspViolations);
   assert.deepEqual(violations.filter(v=>v!=='script-src-elem:inline'),[],'unexpected CSP violations');
   console.log('PASS browser '+design+': consent, all three real SDK bundles, CSP script rejection');
   await context.close();
  }
  // Browser SRI enforcement: serve changed bytes at an approved CDN URL.
  const context=await browser.newContext();const page=await context.newPage();
  const integrityErrors=[]; page.on('console',m=>{if(m.text().includes('integrity'))integrityErrors.push(m.text());});
  const tamperedRequests=[];
  await context.addInitScript(()=>localStorage.setItem('aq_consent_v1',JSON.stringify({state:'granted'})));
  await context.route('**/*',async route=>{
    if (route.request().url().startsWith(origin+'/')) return route.continue();
   const b=bundles.find(b=>b.url===route.request().url());
   if(b){tamperedRequests.push(b.name);return route.fulfill({headers:{'Access-Control-Allow-Origin':'*','Content-Type':'text/javascript'},body:Buffer.concat([b.bytes,Buffer.from('\nwindow.tamperedBundleRan=true;')])});}
   return route.fulfill({contentType:'text/css',body:''});
  });
  await page.goto(origin+'/privacy/');
  await page.waitForFunction(()=>document.querySelector('script[integrity]'));
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(()=>window.tamperedBundleRan),undefined);
  assert.ok(tamperedRequests.length>0);
  assert.ok(integrityErrors.length>0,'browser must report an integrity mismatch');
  console.log('PASS browser rejects tampered SDK bytes');
  await context.close();
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
