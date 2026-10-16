// Online verification of pinned CDN bytes. curl decodes HTTP content encodings,
// exactly as the browser does before evaluating Subresource Integrity.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const source = fs.readFileSync('assets/js/analytics.js','utf8');
const urls = Object.fromEntries([...source.matchAll(/^    (amplitude|replay|statsig): '(https:[^']+)'/gm)].map(m=>[m[1],m[2]]));
const hashes = Object.fromEntries([...source.matchAll(/INTEGRITY\[SRC\.(\w+)\] = '(sha384-[^']+)'/g)].map(m=>[m[1],m[2]]));
assert.equal(Object.keys(urls).length,3);
for (const [name,url] of Object.entries(urls)) {
  const bytes=execFileSync('curl',['--fail','--location','--silent','--show-error','--compressed','--max-time','45',url],{maxBuffer:4*1024*1024});
  const hash=data=>'sha384-'+crypto.createHash('sha384').update(data).digest('base64');
  assert.equal(hash(bytes),hashes[name],`${name}: CDN bytes changed; review before changing the hash`);
  const corrupted=Buffer.concat([bytes,Buffer.from('\n//modified')]);
  assert.notEqual(hash(corrupted),hashes[name]);
  console.log('PASS '+name+' pinned CDN integrity');
}
