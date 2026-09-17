/**
 * Form handler for aqcareer.com — Google Apps Script web app.
 *
 * Receives the newsletter signup and the "let's connect" contact form and
 * emails them on. Runs on Alina's own Google account, so there is no server
 * to maintain and no new service to sign up for.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — DO NOT PUT THE EMAIL ADDRESS IN THIS FILE.
 * This file lives in a PUBLIC GitHub repository. Anything written here is
 * visible to anyone, and scraped by spam bots.
 *
 * The address is set once inside the Apps Script editor instead, as a Script
 * Property. Setup instructions: docs/FORMS.md
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

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // Honeypot: a field hidden from humans. Anything that fills it is a bot.
    // Return success so the bot doesn't retry, but send nothing.
    if (p.website) {
      return ok({ ok: true });
    }

    // Reject submissions that didn't come from the site.
    var origin = String(p.origin || '');
    if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
      return ok({ ok: false, error: 'bad_origin' });
    }

    var kind = p.form === 'contact' ? 'contact' : 'newsletter';
    var email = String(p.email || '').trim();

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return ok({ ok: false, error: 'invalid_email' });
    }

    var subject, body;

    if (kind === 'contact') {
      var first = String(p.first_name || '').trim();
      var last = String(p.last_name || '').trim();
      var name = (first + ' ' + last).trim() || '(no name given)';
      var message = String(p.message || '').trim() || '(no message)';

      subject = 'aqcareer.com — new inquiry from ' + name;
      body = [
        'New message from the "let\'s connect" form on aqcareer.com.',
        '',
        'Name:    ' + name,
        'Email:   ' + email,
        'Sent:    ' + new Date().toLocaleString('en-US',
                        { timeZone: 'America/Los_Angeles' }),
        '',
        'Message:',
        message,
        '',
        '---',
        'Reply straight to this email to answer them.'
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

// Appends each submission to a Google Sheet, if one is linked.
// Optional: set a SHEET_ID script property to turn this on.
function log_(kind, email, p) {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) return;
    SpreadsheetApp.openById(id).getSheets()[0].appendRow([
      new Date(), kind, email,
      String(p.first_name || ''), String(p.last_name || ''),
      String(p.message || ''), p.consent ? 'yes' : ''
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
