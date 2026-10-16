/**
 * Form handler for aqcareer.com — Google Apps Script web app.
 *
 * Receives the Career Disruptor Memo signup, the 2027 counseling interest
 * list, and the "let's connect" contact form and emails them on. Runs on
 * Alina's own Google account, so there is no server
 * to maintain and no new service to sign up for.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — DO NOT PUT THE EMAIL ADDRESS OR THE TURNSTILE SECRET IN THIS FILE.
 * This file lives in a PUBLIC GitHub repository. Anything written here is
 * visible to anyone, and scraped by spam bots.
 *
 * The address and the Turnstile secret are set once inside the Apps Script
 * editor instead, as Script Properties. Setup instructions: docs/FORMS.md
 * ---------------------------------------------------------------------------
 */

// Where the notification is sent. Read at runtime from Script Properties
// (Project Settings -> Script Properties -> add "RECIPIENT").
function recipient() {
  var to = PropertiesService.getScriptProperties().getProperty('RECIPIENT');
  if (!to) {
    throw new Error('RECIPIENT script property is not set — see docs/FORMS.md');
  }
  return to;
}

// This body field is only a consistency check, not authentication.
// Turnstile hostname/action verification below is mandatory.
var ALLOWED_ORIGINS = [
  'https://www.aqcareer.com',
  'https://aqcareer.com'
];

var TURNSTILE_HOSTS = ['www.aqcareer.com', 'aqcareer.com'];
var TURNSTILE_ACTION = 'aq_form';
var FORM_HANDLER_VERSION = '2026-10-16-security-1';
var CONSENT_VERSION = '2026-10-07';
var INQUIRY_TYPES = ['Curriculum contract', 'Workshop', 'Speaking',
  'Partnership or other project', 'Individual counseling question'];

// Caps so one POST cannot dump a novel into Gmail or the sheet.
var LIMITS = {
  email: 254,
  name: 80,
  organization: 120,
  inquiryType: 80,
  message: 4000,
  minFillMs: 2000,
  maxFillMs: 24 * 60 * 60 * 1000,
  perEmailPerHour: 3,
  sitePerHour: 20
};

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // Honeypot: a field hidden from humans. Anything that fills it is a bot.
    // Return success so the bot doesn't retry, but send nothing.
    //
    // `skipped` tells the page this was not a real submission, so it doesn't
    // log a conversion for it. Without that, every bot that trips the honeypot
    // inflates the conversion metric the homepage experiment reads.
    if (p.website) {
      return ok({ ok: true, skipped: 'honeypot' });
    }

    // Optional consistency check. An attacker can omit or forge this field;
    // it must never substitute for the token verification below.
    var origin = String(p.origin || '');
    if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
      return ok({ ok: false, error: 'bad_origin' });
    }

    // Spreadsheet column: waitlist, memo, or contact. Older pages still
    // post "newsletter"; that is the same list as memo.
    var kind = p.form === 'newsletter' ? 'memo' : p.form;
    if (['contact', 'waitlist', 'memo'].indexOf(kind) === -1) {
      return ok({ ok: false, error: 'invalid_form' });
    }
    if (kind !== 'contact' && p.consent !== 'yes') {
      return ok({ ok: false, error: 'consent_required' });
    }
    var email = String(p.email || '').trim().toLowerCase();
    if (email.length > LIMITS.email) {
      return ok({ ok: false, error: 'invalid_email' });
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return ok({ ok: false, error: 'invalid_email' });
    }

    var first = clip_(p.first_name, LIMITS.name);
    var last = clip_(p.last_name, LIMITS.name);
    var organization = clip_(p.organization, LIMITS.organization);
    var inquiryType = clip_(p.inquiry_type, LIMITS.inquiryType);
    if (kind === 'contact' && INQUIRY_TYPES.indexOf(inquiryType) === -1) {
      return ok({ ok: false, error: 'invalid_inquiry' });
    }
    var rawMessage = String(p.message || '');
    if (rawMessage.length > LIMITS.message) {
      return ok({ ok: false, error: 'too_long' });
    }
    var message = rawMessage.replace(/\0/g, '').trim();

    // JS adds loaded_at (ms since the page opened). Instant POSTs are bots.
    // Optional hint only. A forged timestamp never bypasses Turnstile.
    var timing = timingError_(p.loaded_at);
    if (timing) {
      return ok({ ok: false, error: timing });
    }

    if (!turnstileOk_(p.turnstile_token)) {
      return ok({ ok: false, error: 'bot' });
    }

    if (rateLimited_(email)) {
      return ok({ ok: false, error: 'rate_limited' });
    }

    var subject, body;

    if (kind === 'contact') {
      var name = (first + ' ' + last).trim() || '(no name given)';
      if (!message) message = '(no message)';

      subject = 'aqcareer.com — new inquiry from ' + name;
      body = [
        'New message from the "let\'s connect" form on aqcareer.com.',
        '',
        'Name:         ' + name,
        'Email:        ' + email,
        'Organization: ' + (organization || '(not provided)'),
        'Interest:     ' + (inquiryType || '(not selected)'),
        'Sent:         ' + new Date().toLocaleString('en-US',
                        { timeZone: 'America/Los_Angeles' }),
        '',
        'Message:',
        message,
        '',
        '---',
        'Reply straight to this email to answer them.'
      ].join('\n');
    } else if (kind === 'waitlist') {
      var waitlistName = (first + ' ' + last).trim() || '(no name given)';
      subject = 'aqcareer.com — new 2027 counseling interest';
      body = [
        'Someone joined the 2027 career counseling interest list.',
        '',
        'Name:     ' + waitlistName,
        'Email:    ' + email,
        'Consent:  ' + (p.consent === 'yes' ? 'yes, checked the box' : 'not checked'),
        'Sent:     ' + new Date().toLocaleString('en-US',
                         { timeZone: 'America/Los_Angeles' }),
        '',
        '---',
        'Add this address to the 2027 career counseling interest list.'
      ].join('\n');
    } else {
      subject = 'aqcareer.com — new Career Disruptor Memo signup';
      body = [
        'Someone subscribed to the Career Disruptor Memo.',
        '',
        'Email:    ' + email,
        'Consent:  ' + (p.consent === 'yes' ? 'yes, checked the box' : 'not checked'),
        'Sent:     ' + new Date().toLocaleString('en-US',
                         { timeZone: 'America/Los_Angeles' }),
        '',
        '---',
        'Add this address to the mailing list.'
      ].join('\n');
    }

    // Save independently before emailing: a full Gmail account must not
    // prevent the other account's spreadsheet from receiving a submission.
    var saved = log_(kind, email, p);
    var emailed = false;
    try {
      MailApp.sendEmail({
        to: recipient(),
        subject: subject,
        body: body,
        replyTo: email,      // so replying goes to the visitor, not to herself
        name: 'aqcareer.com forms'
      });
      emailed = true;
    } catch (mailError) {
      console.error('Email delivery failed: ' + mailError);
    }

    // A real submission must reach at least one destination before the
    // visitor sees success. Individual failures remain in Executions logs.
    return ok({ ok: emailed || saved > 0,
      error: emailed || saved > 0 ? null : 'server_error' });

  } catch (err) {
    console.error(err);
    return ok({ ok: false, error: 'server_error' });
  }
}

function clip_(value, max) {
  return String(value || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
}

function turnstileOk_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) {
    console.error('TURNSTILE_SECRET is missing; rejecting submission.');
    return false;
  }
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    var resp = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post',
      payload: {
        secret: secret,
        response: String(token)
      },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return false;
    var body = JSON.parse(resp.getContentText() || '{}');
    return !!(body && body.success === true &&
      TURNSTILE_HOSTS.indexOf(body.hostname) !== -1 &&
      body.action === TURNSTILE_ACTION);
  } catch (err) {
    console.error('turnstile: ' + err);
    return false;
  }
}

function timingError_(loadedAt) {
  if (loadedAt === undefined || loadedAt === null || loadedAt === '') {
    return null;
  }
  var started = Number(loadedAt);
  if (!isFinite(started) || started <= 0) {
    return 'too_fast';
  }
  var elapsed = Date.now() - started;
  if (elapsed < LIMITS.minFillMs || elapsed > LIMITS.maxFillMs) {
    return 'too_fast';
  }
  return null;
}

// Durable fixed UTC-hour counters, serialized across all web-app executions.
// No raw email addresses are stored in the limiter. The map is bounded by
// sitePerHour and replaced on rollover, so Script Properties cannot grow forever.
function rateLimited_(email) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return true; // fail closed under contention
  try {
    var props = PropertiesService.getScriptProperties();
    var window = Math.floor(Date.now() / 3600000);
    var raw = props.getProperty('AQ_RATE_WINDOW');
    var state = raw ? JSON.parse(raw) : null;
    if (!state || state.window !== window) {
      state = { window: window, total: 0, emails: {} };
    }
    if (!Number.isInteger(state.total) || state.total < 0 ||
        !state.emails || typeof state.emails !== 'object') {
      throw new Error('Invalid rate-limit state');
    }
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email,
      Utilities.Charset.UTF_8).map(function (b) {
        return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
      }).join('');
    var count = state.emails[digest] || 0;
    if (!Number.isInteger(count) || count < 0) throw new Error('Invalid email counter');
    if (state.total >= LIMITS.sitePerHour || count >= LIMITS.perEmailPerHour) return true;
    state.total++;
    state.emails[digest] = count + 1;
    props.setProperty('AQ_RATE_WINDOW', JSON.stringify(state));
    return false;
  } finally {
    lock.releaseLock();
  }
}

// Sheets treats a leading '=' as a formula. An apostrophe forces literal
// text; also cover common spreadsheet formula prefixes for safe CSV exports.
function sheetText_(value) {
  var text = String(value || '');
  return /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
}

// Keep the original SHEET_ID, and optionally add comma-separated SHEET_IDS.
// The deploying Google account must have edit access to each destination.
function sheetIds_() {
  var props = PropertiesService.getScriptProperties();
  var ids = [props.getProperty('SHEET_ID') || '',
    props.getProperty('SHEET_IDS') || ''].join(',').split(',');
  return ids.map(function (id) { return id.trim(); }).filter(function (id, i, all) {
    return id && all.indexOf(id) === i;
  });
}

// Try every spreadsheet even when an earlier destination is unavailable.
function log_(kind, email, p) {
  var saved = 0;
  sheetIds_().forEach(function (id) {
    try {
      SpreadsheetApp.openById(id).getSheets()[0].appendRow([
      new Date(), kind, sheetText_(email),
      sheetText_(clip_(p.first_name, LIMITS.name)),
      sheetText_(clip_(p.last_name, LIMITS.name)),
      sheetText_(String(p.message || '').replace(/\0/g, '').slice(0, LIMITS.message)),
      p.consent === 'yes' ? 'yes' : '',
      sheetText_(clip_(p.organization, LIMITS.organization)),
      sheetText_(clip_(p.inquiry_type, LIMITS.inquiryType)),
      kind === 'memo' || kind === 'waitlist' ? CONSENT_VERSION : ''
      ]);
      saved++;
    } catch (err) {
      console.error('Spreadsheet delivery failed (' + id + '): ' + err);
    }
  });
  return saved;
}

// Run manually in the editor to verify both destinations without sending
// email or changing the public form's spam checks. Leaves labeled test rows.
function testSpreadsheetDelivery() {
  var saved = log_('test', 'test@example.com', {
    first_name: 'AQ Career', last_name: 'Connection test',
    message: 'Connection test — not a customer submission.'
  });
  console.log('Saved test row to ' + saved + ' of ' + sheetIds_().length + ' spreadsheets.');
  if (!saved) throw new Error('No spreadsheet accepted the test row.');
}

function ok(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Visiting the URL in a browser should not look broken.
function doGet() {
  return ContentService
    .createTextOutput('aqcareer.com form handler ' + FORM_HANDLER_VERSION)
    .setMimeType(ContentService.MimeType.TEXT);
}
