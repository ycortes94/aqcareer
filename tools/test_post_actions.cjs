// Run with: node tools/test_post_actions.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('assets/js/likes.js', 'utf8');
const canonical = 'https://www.aqcareer.com/post/test-post/';
function setup({stored = '{}', blockedRead = false, blockedWrite = false, clipboardFails = false, analytics = true} = {}) {
  const events = [], copied = [];
  function element() {
    const attrs = {}, handlers = {};
    return {attrs, handlers, hidden: true, textContent: '', setAttribute: (k,v) => attrs[k]=v,
      getAttribute: k => attrs[k], addEventListener: (k,fn) => handlers[k]=fn,
      classList: {toggle(){},add(){},remove(){}}};
  }
  const button = element(), copy = element(), popup = element(), status = element();
  const count = element(), number = element(), word = element(), label = element();
  count.attrs = {}; // Attribute lookups below represent the generated published total.
  count.getAttribute = k => k === 'data-likes' ? '4' : 'test-post';
  count.querySelector = selector => selector === '[data-like-word]' ? word : number;
  count.closest = () => ({querySelector: () => word});
  button.querySelector = () => label;
  const nodes = {'[data-like-bar]': {querySelector: () => button}, '[data-copy-link]': copy,
    '.post-share-popup': popup, '[data-share-status]': status,
    'link[rel="canonical"]': {href: canonical}, h1: {textContent: 'Post title'}};
  const docHandlers = {};
  const ctx = {Date, navigator: {clipboard: {writeText: async url => {
    if (clipboardFails) throw new Error('Denied'); copied.push(url);
  }}}, document: {readyState: 'complete', documentElement: {getAttribute: k => k === 'data-post' ? 'test-post' : 'control'},
    querySelector: s => nodes[s], querySelectorAll: () => [count], addEventListener: (k,fn) => docHandlers[k]=fn}};
  ctx.window = {location: {href: canonical + '?design=control'},
    localStorage: {getItem() {if (blockedRead) throw new Error('Blocked'); return stored;},
      setItem(k,v) {if (blockedWrite) throw new Error('Blocked'); stored=v;}}};
  if (analytics) ctx.window.amplitude = {track: (name,meta) => events.push({name,meta})};
  vm.runInNewContext(source,ctx);
  return {button,copy,popup,status,number,word,label,events,copied,docHandlers};
}
(async () => {
  const ui = setup();
  assert.equal(ui.button.hidden,false);
  assert.equal(ui.number.textContent,4);
  ui.button.handlers.click();
  assert.equal(ui.button.attrs['aria-pressed'],'true');
  assert.equal(ui.number.textContent,5);
  assert.equal(ui.events[0].name,'post_liked');
  assert.equal(ui.events[0].meta.post,'test-post');
  ui.docHandlers['aq:cards-swapped']();
  assert.equal(ui.number.textContent,5);
  ui.button.handlers.click();
  assert.equal(ui.number.textContent,4);
  assert.equal(ui.events[1].name,'post_unliked');
  await ui.copy.handlers.click();
  assert.deepEqual(ui.copied,[canonical]);
  assert.equal(ui.status.textContent,'Link copied!');
  ui.popup.handlers.beforetoggle({newState:'open'});
  assert.equal(ui.status.textContent,'');
  const saved = setup({stored: JSON.stringify({'test-post':'2026-10-15'})});
  assert.equal(saved.button.attrs['aria-pressed'],'true');
  assert.equal(saved.number.textContent,5);
  for (const options of [{blockedRead:true,blockedWrite:true}, {blockedWrite:true}, {analytics:false}]) {
    const offline = setup(options);
    offline.button.handlers.click();
    assert.equal(offline.number.textContent,5);
    offline.button.handlers.click();
    assert.equal(offline.number.textContent,4);
  }
  const fallback = setup({clipboardFails:true});
  await fallback.copy.handlers.click();
  assert.ok(fallback.status.textContent.includes(canonical));
  console.log('PASS post actions: published totals, like/unlike, saved state, blocked storage, consent declined, pagination, canonical copy, popup feedback reset and clipboard fallback');
})().catch(err => {console.error(err);process.exitCode=1;});
