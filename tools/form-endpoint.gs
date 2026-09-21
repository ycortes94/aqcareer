/**
 * Form handler for aqcareer.com — Google Apps Script web app.
 *
 * Receives the newsletter signup and the "let's connect" contact form and
 * emails them on. Runs on Alina's own Google account, so there is no server
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

// Only accept submissions that say they came from the real site.
var ALLOWED_ORIGINS = [
  'https://www.aqcareer.com',
  'https://aqcareer.com',
  'https://ycortes94.github.io'
];

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
    if (p.website) {
      return ok({ ok: true });
    }

    // Reject submissions that didn't come from the site. Origin is omitted
    // when JavaScript is off (the HTML form has no origin field), so a
    // missing value is allowed; a forged one is not.
    var origin = String(p.origin || '');
    if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
      return ok({ ok: false, error: 'bad_origin' });
    }

    var kind = p.form === 'contact' || p.form === 'waitlist'
      ? p.form : 'newsletter';
    var email = clip_(p.email, LIMITS.email).toLowerCase();

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return ok({ ok: false, error: 'invalid_email' });
    }

    var first = clip_(p.first_name, LIMITS.name);
    var last = clip_(p.last_name, LIMITS.name);
    var organization = clip_(p.organization, LIMITS.organization);
    var inquiryType = clip_(p.inquiry_type, LIMITS.inquiryType);
    var rawMessage = String(p.message || '');
    if (rawMessage.length > LIMITS.message) {
      return ok({ ok: false, error: 'too_long' });
    }
    var message = rawMessage.replace(/\0/g, '').trim();

    // JS adds loaded_at (ms since the page opened). Instant POSTs are bots.
    // No-JS visitors omit it, so a missing value is allowed.
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
        'Consent:  ' + (p.consent ? 'yes, checked the box' : 'not checked'),
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
        'Consent:  ' + (p.consent ? 'yes, checked the box' : 'not checked'),
        'Sent:     ' + new Date().toLocaleString('en-US',
                         { timeZone: 'America/Los_Angeles' }),
        '',
        '---',
        'Add this address to the mailing list.'
      ].join('\n');
    }

    MailApp.sendEmail({
      to: recipient(),
      subject: subject,
      body: body,
      replyTo: email,      // so replying goes to the visitor, not to herself
      name: 'aqcareer.com forms'
    });

    // Keep a running log as a backup, in case an email is ever missed.
    log_(kind, email, p);

    return ok({ ok: true });

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
  if (!secret) return true;
  if (!token) return false;
  try {
    var resp = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post',
      payload: {
        secret: secret,
        response: String(token)
      },
      muteHttpExceptions: true
    });
    var body = JSON.parse(resp.getContentText() || '{}');
    return !!(body && body.success);
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

// Cheap throttle in Apps Script's shared cache. Not a firewall: it stops
// a script from mailing Alina 200 times in a minute. Cache is best-effort.
function rateLimited_(email) {
  var cache = CacheService.getScriptCache();
  var hour = 3600;
  var globalKey = 'aq_rate_global';
  var emailKey = 'aq_rate_' + email;
  var global = parseInt(cache.get(globalKey) || '0', 10);
  var perEmail = parseInt(cache.get(emailKey) || '0', 10);
  if (global >= LIMITS.sitePerHour || perEmail >= LIMITS.perEmailPerHour) {
    return true;
  }
  cache.put(globalKey, String(global + 1), hour);
  cache.put(emailKey, String(perEmail + 1), hour);
  return false;
}

// Appends each submission to a Google Sheet, if one is linked.
// Optional: set a SHEET_ID script property to turn this on.
function log_(kind, email, p) {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) return;
    SpreadsheetApp.openById(id).getSheets()[0].appendRow([
      new Date(), kind, email,
      clip_(p.first_name, LIMITS.name), clip_(p.last_name, LIMITS.name),
      String(p.message || '').replace(/\0/g, '').slice(0, LIMITS.message),
      p.consent ? 'yes' : '',
      clip_(p.organization, LIMITS.organization),
      clip_(p.inquiry_type, LIMITS.inquiryType)
    ]);
  } catch (err) {
    console.error('log failed: ' + err);   // never block the email on this
  }
}

function ok(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Visiting the URL in a browser should not look broken.
function doGet() {
  return ContentService
    .createTextOutput('This endpoint accepts form submissions from aqcareer.com.')
    .setMimeType(ContentService.MimeType.TEXT);
}
