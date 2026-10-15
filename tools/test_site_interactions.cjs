// Run with: node tools/test_site_interactions.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '../assets/js', name), 'utf8');
function navigation(prefix = '', page = 'home', hash = '') {
  const handlers = {}, frames = [], timers = [];
  const sections = {};
  const names = prefix ? ['about','services','blog','connect'] : ['home','services','blog','connect'];
  const links = names.map(name => {
    const attrs = {'data-nav':name};
    if (name === 'home' || name === 'blog') attrs['aria-current']='page';
    return {href:'http://site.test/' + (name === 'blog' ? 'blog/' : name === 'home' ? '' : '#'+prefix+name),
      getAttribute:k=>attrs[k] || null, setAttribute:(k,v)=>attrs[k]=v,
      removeAttribute:k=>delete attrs[k], hasAttribute:()=>false, attrs};
  });
  let scroll=0;
  ['about','services','connect'].forEach((name,i)=>{
    sections[prefix+name]={getClientRects:()=>[{}],getBoundingClientRect:()=>({top:[600,1500,3000][i]-scroll})};
  });
  const nav={getClientRects:()=>[{}], querySelectorAll:()=>links};
  const ctx={URL, location:{href:'http://site.test/'+hash,hash,origin:'http://site.test',pathname:'/'},
    document:{documentElement:{getAttribute:()=>page,scrollHeight:4500},
      querySelectorAll:()=>[nav],querySelector:()=>null,getElementById:id=>sections[id] || null,
      addEventListener:(k,fn)=>handlers[k]=fn},
    innerHeight:1000,scrollY:0, addEventListener:(k,fn)=>handlers[k]=fn,
    requestAnimationFrame:fn=>frames.push(fn),setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},
    history:{pushState:()=>{}},scrollTo:()=>{scroll=0;ctx.scrollY=0;}};
  ctx.window=ctx;
  vm.runInNewContext(source('navigation.js'),ctx);
  const flush=()=>{while(frames.length) frames.shift()();};
  flush();
  return {links,handlers,ctx,flush,
    scroll(y){scroll=y;ctx.scrollY=y;handlers.wheel();flush();},
    click(name,extra={}){handlers.click({target:{closest:()=>links.find(l=>l.attrs['data-nav']===name)},button:0,preventDefault(){},...extra});},
    current:()=>links.filter(l=>l.attrs['aria-current']).map(l=>l.attrs['data-nav'])};
}
for (const prefix of ['', 'ft-', 'rz-']) {
  const n=navigation(prefix);
  assert.deepEqual(n.current(),prefix ? [] : ['home']);
  n.click('connect');
  assert.deepEqual(n.current(),['connect']);
  n.scroll(2900);
  assert.deepEqual(n.current(),['connect']);
  n.click('services');
  assert.deepEqual(n.current(),['services']);
  n.scroll(1400);
  assert.deepEqual(n.current(),['services']);
  n.scroll(0);
  assert.deepEqual(n.current(),prefix ? [] : ['home']);
  n.click('connect',{ctrlKey:true});
  assert.deepEqual(n.current(),prefix ? [] : ['home']);
  assert.deepEqual(navigation(prefix,'home','#'+prefix+'connect').current(),['connect']);
}
assert.deepEqual(navigation('','blog').current(),['home','blog']); // Script must leave non-home pages untouched.
const n=navigation(); n.scroll(2900); n.click('home'); assert.deepEqual(n.current(),['home']);
console.log('PASS navigation: clicks, scrolling, initial anchors, modified clicks, Home and non-home pages across all three designs');

let observe, loads=0, rendered=0;
function form(visible=true,closed=false) {
  const handlers={}, attrs={};
  const slot={getAttribute:k=>attrs[k],setAttribute:(k,v)=>attrs[k]=v};
  return {handlers,getAttribute:()=> 'memo',querySelector:s=>s==='.js-turnstile'?slot:null,
    addEventListener:(k,fn)=>handlers[k]=fn,getClientRects:()=>visible?[{}]:[],
    closest:()=>closed?{open:false}:null};
}
const visible=form(), hidden=form(false), dialog=form(true,true);
const appended=[];
const ctx={document:{documentElement:{getAttribute:k=>k==='data-turnstile-sitekey'?'key':'https://example.test'},
  querySelectorAll:()=>[visible,hidden,dialog],addEventListener:()=>{},createElement:()=>({}),
  head:{appendChild:s=>{loads++;appended.push(s);}}},
  IntersectionObserver:function(fn){observe=fn;this.observe=()=>{};this.unobserve=()=>{};},Date};
ctx.window=ctx;
vm.runInNewContext(source('forms.js'),ctx);
assert.equal(loads,0);
for (const f of [visible,hidden,dialog]) assert.equal(typeof f.handlers.submit,'function');
observe([{target:hidden,isIntersecting:true},{target:dialog,isIntersecting:true}]);
assert.equal(loads,0);
visible.handlers.focusin();
assert.equal(loads,1);
visible.handlers.pointerdown();
assert.equal(loads,1);
ctx.turnstile={render(){rendered++;return 'widget';}};
appended[0].onload();
assert.equal(rendered,1);
console.log('PASS forms: handlers ready while external service stalls, no eager widgets, hidden/closed forms skipped, SDK loaded once, widget rendered once');
