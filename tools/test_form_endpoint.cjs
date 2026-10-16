const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function submit({ failingSheets = [], mailFails = false, ids = 'original,backup' } = {}) {
  const writes = [];
  const attempts = [];
  const context = {
    console: { error() {}, log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => ({ RECIPIENT: 'owner@example.com', SHEET_ID: 'original', SHEET_IDS: ids })[key]
    }) },
    SpreadsheetApp: { openById(id) {
      attempts.push(id);
      if (failingSheets.includes(id)) throw new Error('Storage full');
      return { getSheets: () => [{ appendRow: row => writes.push({ id, row }) }] };
    } },
    MailApp: { sendEmail() { if (mailFails) throw new Error('Mail unavailable'); } },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({
      setMimeType: () => JSON.parse(text)
    }) }
  };
  vm.runInNewContext(fs.readFileSync(__dirname + '/form-endpoint.gs', 'utf8'), context);
  const result = context.doPost({ parameter: {
    form: 'contact', email: 'visitor@example.com', first_name: 'Test', message: 'Hello',
    origin: 'https://www.aqcareer.com'
  } });
  return { result, writes, attempts };
}

let run = submit();
assert.equal(run.result.ok, true);
assert.deepEqual(run.writes.map(w => w.id), ['original', 'backup']);
assert.equal(run.writes[1].row[2], 'visitor@example.com');
assert.equal(run.writes[1].row[5], 'Hello');
run = submit({ failingSheets: ['original'], mailFails: true });
assert.equal(run.result.ok, true);
assert.deepEqual(run.writes.map(w => w.id), ['backup']);
run = submit({ failingSheets: ['backup'] });
assert.equal(run.result.ok, true);
assert.deepEqual(run.writes.map(w => w.id), ['original']);
run = submit({ failingSheets: ['original', 'backup'], mailFails: true });
assert.equal(run.result.ok, false);
assert.equal(run.result.error, 'server_error');
assert.deepEqual(run.attempts, ['original', 'backup']);
run = submit({ ids: ' original, backup,backup, ' });
assert.deepEqual(run.attempts, ['original', 'backup']);
console.log('PASS: both Sheets, independent storage/mail failures, total failure, duplicate IDs.');
