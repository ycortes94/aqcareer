import assert from 'node:assert/strict';
import worker, { secureResponse } from '../edge/security-worker.mjs';
for (const status of [200, 404, 500]) {
  const r = secureResponse(new Response('body', {status,headers:{'Content-Type':'text/html','Cache-Control':'max-age=600'}}));
  assert.equal(r.status, status);
  assert.equal(await r.text(), 'body');
  assert.equal(r.headers.get('Cache-Control'), 'max-age=600');
  assert.equal(r.headers.get('Content-Type'), 'text/html');
  assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
  assert.match(r.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.match(r.headers.get('Permissions-Policy'), /microphone=\(\)/);
}
let calls=0;
globalThis.fetch=async request=>{calls++;assert.equal(request.url,'https://www.aqcareer.com/privacy/');return new Response('upstream');};
let r=await worker.fetch(new Request('http://www.aqcareer.com/path?q=1'));
assert.equal(r.status,301);assert.equal(r.headers.get('Location'),'https://www.aqcareer.com/path?q=1');assert.equal(calls,0);
r=await worker.fetch(new Request('https://www.aqcareer.com/privacy/'));
assert.equal(await r.text(),'upstream');assert.equal(calls,1);
console.log('PASS edge headers, response preservation, HTTPS redirect and origin forwarding');
