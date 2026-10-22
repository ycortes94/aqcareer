const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('assets/js/forms.js', 'utf8');

async function run(kind, result, kit = {status: 'success'}, kitOk = true) {
  const handlers = {}, posted = [], requests = [];
  const status = {setAttribute() {}, classList: {toggle() {}}};
  const button = {textContent: 'Subscribe'};
  const form = {
    getAttribute: () => kind,
    querySelector: s => s === '.form-status' ? status : s === 'button[type="submit"]' ? button : null,
    addEventListener: (name, fn) => handlers[name] = fn,
    reportValidity: () => true, reset() {}, getClientRects: () => [], closest: () => null
  };
  const ctx = {
    Date, URLSearchParams,
    FormData: function () { return new Map([['email', 'test@example.com'], ['consent', 'yes'], ['message', 'private']]); },
    HTMLFormElement: {prototype: {submit() {posted.push(this);}}},
    fetch: async (url, options) => {requests.push({url, options}); return {ok: kitOk, json: async () => url.includes('app.kit.com') ? kit : result};},
    document: {
      documentElement: {getAttribute: k => k === 'data-form-endpoint' ? 'https://script.google.com/example' : ''},
      querySelectorAll: () => [form], addEventListener() {},
      createElement: () => ({children: [], appendChild(child) {this.children.push(child);}}),
      body: {appendChild() {}}
    },
    location: {origin: 'https://www.aqcareer.com'},
    IntersectionObserver: function () {this.observe = () => {};}
  };
  ctx.window = ctx;
  vm.runInNewContext(code, ctx);
  handlers.submit({preventDefault() {}});
  await new Promise(resolve => setImmediate(resolve));
  return {posted, requests, status};
}
(async () => {
  const memo = await run('memo', {ok: true});
  assert.equal(memo.requests.length, 2, 'server validation then Kit');
  assert.equal(memo.requests[0].url, 'https://script.google.com/example');
  assert.equal(memo.posted.length, 0, 'never navigate using a native form');
  const target = memo.requests[1];
  assert.equal(target.url, 'https://app.kit.com/forms/10080050/subscriptions');
  assert.equal(target.options.method, 'POST');
  assert.equal(target.options.headers.Accept, 'application/json');
  assert.equal(target.options.body.toString(), 'email_address=test%40example.com');
  assert.match(memo.status.innerHTML, /Check your email to confirm/);
  for (const [response, ok] of [[{status:'error'},true], [{status:'quarantined'},true], [{status:'success'},false]]) {
    const failed = await run('memo', {ok:true}, response, ok);
    assert.match(failed.status.innerHTML, /Something went wrong/);
  }
  for (const result of [{ok:false,error:'bot'}, {ok:false,error:'consent_required'}, {ok:true,skipped:'honeypot'}]) {
    assert.equal((await run('memo', result)).requests.length, 1);
  }
  for (const kind of ['contact', 'waitlist']) {
    assert.equal((await run(kind, {ok:true})).requests.length, 1);
  }
  console.log('PASS newsletter: server validation, email-only Kit handoff, rejected/bot submissions blocked, contact and waitlist unchanged');
})().catch(error => {console.error(error); process.exitCode = 1;});
