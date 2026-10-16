const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('privacy/index.html','utf8');
const script=html.match(/<script>\s*\/\* Fresh-take[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g,'');
function font(cached=false){
 const handlers={};return {media:'print',sheet:cached?{}:null,handlers,
 addEventListener:(type,fn)=>{handlers[type]=fn;}};
}
const pending=font(),cached=font(true);
vm.runInNewContext(script,{document:{querySelectorAll:()=>[pending,cached],documentElement:{classList:{contains:()=>false}}}});
assert.equal(cached.media,'all','cached CSS must apply even if the load event has already fired');
assert.equal(pending.media,'print','pending remote CSS must not block the initial render');
pending.handlers.load();assert.equal(pending.media,'all','downloaded CSS must activate');
console.log('PASS fonts: non-blocking pending CSS and cached/late-load activation on non-home pages');
