const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('assets/js/forms.js', 'utf8');

async function run(kind, result) {
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
    fetch: async (url, options) => {requests.push({url, options}); return {json: async () => result};},
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
  assert.equal(memo.requests.length, 1, 'existing server validation happens first');
  assert.equal(memo.posted.length, 1);
  const target = memo.posted[0];
  assert.equal(target.action, 'https://app.kit.com/forms/10080050/subscriptions');
  assert.equal(target.method, 'post');
  assert.equal(target.className, 'amp-block');
  assert.equal(target.children.length, 1, 'only the newsletter email goes to Kit');
  assert.equal(target.children[0].name, 'email_address');
  assert.equal(target.children[0].value, 'test@example.com');
  for (const result of [{ok:false,error:'bot'}, {ok:false,error:'consent_required'}, {ok:true,skipped:'honeypot'}]) {
    assert.equal((await run('memo', result)).posted.length, 0);
  }
  for (const kind of ['contact', 'waitlist']) {
    assert.equal((await run(kind, {ok:true})).posted.length, 0);
  }
  console.log('PASS newsletter: server validation, email-only Kit handoff, rejected/bot submissions blocked, contact and waitlist unchanged');
})().catch(error => {console.error(error); process.exitCode = 1;});
