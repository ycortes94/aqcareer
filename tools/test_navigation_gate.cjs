// Run after tools/build.py: node tools/test_navigation_gate.cjs
// Execute the real generated head gate with a stalled analytics network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const key = 'aq_design_navigation_v1';
const html = fs.readFileSync(path.join(root, 'blog/index.html'), 'utf8');
const script = html.match(/<script>\s*\/\* Fresh-take[\s\S]*?<\/script>/)[0]
  .replace(/^<script>|<\/script>$/g, '');
function run(options = {}) {
  const local = new Map();
  if (options.consent !== null) local.set('aq_consent_v1', JSON.stringify({state: options.consent || 'granted'}));
  if (options.labs) local.set('aq_labs_v1', JSON.stringify({enabled:true, design:options.labs}));
  const session = options.session || new Map();
  const timers = new Map();
  const attrs = {'data-page': options.page || 'blog'};
  const classes = new Set(['home-exp', 'exp-pending']);
  const storage = (map, blocked) => ({
    getItem(k) { if (blocked) throw Error('blocked'); return map.get(k) || null; },
    setItem(k,v) { if (blocked) throw Error('blocked'); map.set(k,v); },
    removeItem(k) { if (blocked) throw Error('blocked'); map.delete(k); }
  });
  const ctx = {
    document: {documentElement: {
      classList: {contains:k=>classes.has(k), remove:k=>classes.delete(k)},
      setAttribute:(k,v)=>{attrs[k]=v;}, getAttribute:k=>attrs[k]
    }, createElement:()=>({}), head:{appendChild:()=>{}}},
    localStorage:storage(local, options.blockLocal),
    sessionStorage:storage(session, options.blockSession),
    navigator:{doNotTrack:options.dnt ? '1' : '0', globalPrivacyControl:!!options.gpc},
    location:{search:'',hostname:'www.aqcareer.com'}, URLSearchParams, Date,
    setTimeout(fn) { const id=timers.size+1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  ctx.window=ctx;
  vm.runInNewContext(options.noKeys ? script.replace('"has_keys": true', '"has_keys": false') : script, ctx);
  return {ctx, session, timers, attrs, classes};
}
const cache = (design, at=Date.now())=>new Map([[key, JSON.stringify({design,at})]]);
let checks=0;
function check(name, fn) { fn(); checks++; console.log('PASS '+name); }
for (const design of ['control','fresh_take','raices']) {
  check('homepage → blog → article: '+design,()=>{
    const home=run({page:'home'});
    assert(home.classes.has('exp-pending'));
    home.ctx.__aqReveal(design);
    for (const page of ['blog','post']) {
      const next=run({page,session:home.session});
      assert.equal(next.attrs['data-home-design'],design);
      assert(!next.classes.has('exp-pending'));
      assert.equal(next.timers.size,0);
      next.ctx.__aqReveal('control');
      assert.equal(next.attrs['data-home-design'],design);
    }
  });
}
for (const options of [{consent:null},{consent:'denied'},{dnt:true},{gpc:true},{noKeys:true},{blockLocal:true}]) {
  check('immediate control with privacy/config '+JSON.stringify(options),()=>{
    const r=run({...options,session:cache('raices')});
    assert.equal(r.attrs['data-home-design'],'control');
    assert.equal(r.timers.size,0);
    if (!options.blockLocal) assert(!r.session.has(key));
  });
}
for (const session of [new Map(),cache('raices',Date.now()-1800001),cache('raices',Date.now()+60000),cache('invalid'),new Map([[key,'broken JSON']])]) {
  check('cold/invalid cache keeps bounded fallback',()=>{
    const r=run({session});
    assert(r.classes.has('exp-pending'));
    assert.equal(r.timers.size,1);
    [...r.timers.values()][0]();
    assert.equal(r.attrs['data-home-design'],'control');
  });
}
check('homepage refresh obtains a new assignment',()=>{
  const r=run({page:'home',session:cache('raices')});
  assert(r.classes.has('exp-pending'));
  r.ctx.__aqReveal('fresh_take');
  assert.equal(r.attrs['data-home-design'],'fresh_take');
});
check('Labs wins without polluting the cached visitor design',()=>{
  const r=run({labs:'fresh_take',session:cache('raices')});
  assert.equal(r.attrs['data-home-design'],'fresh_take');
  assert.equal(JSON.parse(r.session.get(key)).design,'raices');
});
check('Labs works without consent',()=>{
  assert.equal(run({labs:'raices',consent:'denied'}).attrs['data-home-design'],'raices');
});
check('blocked session storage still reveals on assignment',()=>{
  const r=run({blockSession:true});
  r.ctx.__aqReveal('fresh_take');
  assert.equal(r.attrs['data-home-design'],'fresh_take');
});
console.log(checks+' navigation gate checks passed');
