const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function setup({ failingSheets = [], mailFails = false, ids = 'original,backup',
  secret = 'test-secret', verification = {}, verifyThrows = false,
  responseCode = 200, lockAvailable = true, propertyFails = false } = {}) {
  const writes = [], attempts = [], mails = [], verifications = [];
  let held = false, now = 1792152000000;
  const props = { RECIPIENT: 'owner@example.com', SHEET_ID: 'original', SHEET_IDS: ids,
    TURNSTILE_SECRET: secret };
  const context = {
    console: { error() {}, log() {} },
    Date: class extends Date { static now() { return now; } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) {
        if (key === 'AQ_RATE_WINDOW') assert.equal(held, true, 'read requires lock');
        return props[key];
      },
      setProperty(key, value) {
        assert.equal(held, true, 'write requires lock');
        if (propertyFails) throw Error('Storage unavailable');
        props[key] = value;
      }
    }) },
    LockService: { getScriptLock: () => ({
      tryLock() { if (!lockAvailable || held) return false; held = true; return true; },
      releaseLock() { assert.equal(held, true); held = false; }
    }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => [...crypto.createHash('sha256').update(value).digest()] },
    UrlFetchApp: { fetch(url, options) {
      verifications.push({ url, options });
      if (verifyThrows) throw Error('Verification unavailable');
      return { getResponseCode: () => responseCode, getContentText: () => JSON.stringify({
        success: true, hostname: 'www.aqcareer.com', action: 'aq_form', ...verification
      }) };
    } },
    SpreadsheetApp: { openById(id) {
      attempts.push(id);
      if (failingSheets.includes(id)) throw new Error('Storage full');
      return { getSheets: () => [{ appendRow: row => writes.push({ id, row }) }] };
    } },
    MailApp: { sendEmail(mail) { if (mailFails) throw new Error('Mail unavailable'); mails.push(mail); } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({
      setMimeType: () => JSON.parse(text)
    }) }
  };
  vm.runInNewContext(fs.readFileSync(__dirname + '/form-endpoint.gs', 'utf8'), context);
  const submit = (fields = {}) => context.doPost({ parameter: {
    form: 'contact', email: 'visitor@example.com', first_name: 'Test', message: 'Hello',
    inquiry_type: 'Workshop', origin: 'https://www.aqcareer.com', turnstile_token: 'test-token', ...fields
  } });
  return { context, submit, writes, attempts, mails, props, verifications,
    advance: ms => { now += ms; }, locked: () => held };
}
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
check('both Sheets and email; independent delivery failures; duplicate destinations', () => {
  let a = setup(); assert.equal(a.submit().ok, true);
  assert.deepEqual(a.writes.map(w => w.id), ['original', 'backup']);
  assert.equal(a.writes[1].row[2], 'visitor@example.com'); assert.equal(a.writes[1].row[5], 'Hello');
  a = setup({ failingSheets: ['original'], mailFails: true }); assert.equal(a.submit().ok, true);
  assert.deepEqual(a.writes.map(w => w.id), ['backup']);
  a = setup({ failingSheets: ['backup'] }); assert.equal(a.submit().ok, true);
  assert.deepEqual(a.writes.map(w => w.id), ['original']);
  a = setup({ failingSheets: ['original','backup'], mailFails: true });
  assert.equal(a.submit().error, 'server_error'); assert.deepEqual(a.attempts, ['original','backup']);
  a = setup({ ids: ' original, backup,backup, ' }); a.submit();
  assert.deepEqual(a.writes.map(w => w.id), ['original','backup']);
});
check('formula prefixes escaped in every visitor-controlled spreadsheet column', () => {
  const a = setup(); const fields = {email: '=1+1@example.com', first_name: '=1+1', last_name: '+42',
    message: '\t=1+1', organization: '-42', inquiry_type: '@example'};
  a.context.log_('contact', fields.email, fields);
  for (const {row} of a.writes) {
    for (const index of [2,3,4,5,7,8]) assert.equal(row[index][0], "'");
    assert.equal(row[6], '');
  }
  assert.equal(a.context.sheetText_('Ordinary text'), 'Ordinary text');
});
check('missing secret/token, oversized token, verification failure and outages fail closed', () => {
  for (const options of [{secret:''}, {verification:{success:false}}, {verification:{success:'true'}},
    {verification:{hostname:'attacker.example'}}, {verification:{action:'wrong'}},
    {verifyThrows:true}, {responseCode:503}]) {
    const a = setup(options); assert.equal(a.submit().error, 'bot');
    assert.equal(a.mails.length,0); assert.equal(a.writes.length,0);
  }
  for (const token of ['', 'x'.repeat(2049)]) {
    const a = setup(); assert.equal(a.submit({turnstile_token:token}).error,'bot');
    assert.equal(a.verifications.length,0);
  }
});
check('both production hostnames accepted; token sent only to Cloudflare', () => {
  const a = setup({verification:{hostname:'aqcareer.com'}}); assert.equal(a.submit().ok,true);
  assert.equal(a.verifications[0].url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(a.verifications[0].options.payload.response,'test-token');
});
check('signup consent exact match; policy version; legacy newsletter alias', () => {
  for (const form of ['memo','waitlist','newsletter']) {
    for (const consent of [undefined,'','no','false','1']) {
      const a = setup(); assert.equal(a.submit({form,consent}).error,'consent_required');
      assert.equal(a.mails.length,0); assert.equal(a.writes.length,0);
    }
    const a = setup(); assert.equal(a.submit({form,consent:'yes'}).ok,true);
    assert.equal(a.writes[0].row[6],'yes'); assert.equal(a.writes[0].row[9],'2026-10-07');
  }
  const a = setup(); assert.equal(a.submit({consent:'no'}).ok,true); assert.equal(a.writes[0].row[6],'');
});
check('invalid form/inquiry/email/message and bad origin rejected without delivery', () => {
  for (const [fields,error] of [[{form:'unknown'},'invalid_form'],
    [{inquiry_type:'unknown'},'invalid_inquiry'], [{email:'broken'},'invalid_email'],
    [{email:'a'.repeat(250)+'@example.com'},'invalid_email'],
    [{message:'a'.repeat(4001)},'too_long'], [{origin:'https://evil.example'},'bad_origin']]) {
    const a=setup(); assert.equal(a.submit(fields).error,error); assert.equal(a.mails.length,0);
  }
});
check('honeypot skipped; optional origin/timing never bypass mandatory token', () => {
  const a=setup(); assert.equal(a.submit({website:'bot'}).skipped,'honeypot'); assert.equal(a.mails.length,0);
  assert.equal(a.submit({origin:'',loaded_at:'',turnstile_token:''}).error,'bot');
  assert.equal(a.submit({origin:'',loaded_at:''}).ok,true);
  assert.equal(a.submit({loaded_at:'garbage'}).error,'too_fast');
});
check('per-email cap and fixed-hour reset survive separate requests', () => {
  const a=setup(); for(let i=0;i<3;i++) assert.equal(a.submit().ok,true);
  assert.equal(a.submit().error,'rate_limited'); assert.equal(a.mails.length,3);
  assert.equal(a.locked(),false);
  const state=JSON.parse(a.props.AQ_RATE_WINDOW); assert.equal(state.total,3);
  assert.equal(Object.keys(state.emails).length,1); assert.equal(a.props.AQ_RATE_WINDOW.includes('@'),false);
  a.advance(3600000); assert.equal(a.submit().ok,true);
  assert.equal(JSON.parse(a.props.AQ_RATE_WINDOW).total,1);
});
check('global cap; unavailable lock and durable-store failure reject without delivery', () => {
  const a=setup(); for(let i=0;i<20;i++) assert.equal(a.submit({email:`visitor${i}@example.com`}).ok,true);
  assert.equal(a.submit({email:'other@example.com'}).error,'rate_limited'); assert.equal(a.mails.length,20);
  for (const options of [{lockAvailable:false},{propertyFails:true}]) {
    const b=setup(options); assert.equal(b.submit().ok,false); assert.equal(b.mails.length,0);
    assert.equal(b.writes.length,0); assert.equal(b.locked(),false);
  }
});
check('malformed durable counter fails closed and releases lock', () => {
  const a=setup(); a.props.AQ_RATE_WINDOW='{'; assert.equal(a.submit().error,'server_error');
  assert.equal(a.locked(),false); assert.equal(a.mails.length,0);
});
console.log(`${checks} form security/delivery groups passed.`);
