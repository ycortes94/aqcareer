/* Form submission for aqcareer.com.
 *
 * Every form posts to a Google Apps Script web app, which emails the
 * submission on: the Career Disruptor Memo signup, the 2027 counseling
 * interest list, and the contact form on the homepage, plus the memo signup
 * again at the foot of the blog index. The endpoint URL is injected by the
 * build from site.json (form_endpoint).
 *
 * Progressive enhancement: without JavaScript the forms still submit
 * normally to the same endpoint, they just leave the page to do it.
 */
(function () {
  'use strict';

  var ENDPOINT = document.documentElement.getAttribute('data-form-endpoint') || '';
  var SITEKEY = document.documentElement.getAttribute('data-turnstile-sitekey') || '';

  // Require https so submissions are never sent in the clear. Plain http is
  // allowed on localhost only, for testing against a local stub.
  var CONFIGURED = /^https:\/\//.test(ENDPOINT) ||
                   /^http:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(ENDPOINT);

  var MESSAGES = {
    newsletter: 'Thank you — you’re on the list for the first memo.',
    waitlist: 'Thank you — you’re on the 2027 career counseling interest list.',
    contact: 'Thank you — your message is on its way. Alina will be in touch.',
    invalid_email: 'That email address doesn’t look right. Mind checking it?',
    rate_limited: 'That was sent a few times already. Please wait a bit and try again, or reach Alina on ' +
                  '<a href="https://www.linkedin.com/in/alina-quintana/">LinkedIn</a>.',
    too_long: 'That’s a bit long for this form. Try a shorter message?',
    bot: 'That didn’t go through the spam check. Refresh the page and try once more, or reach Alina on ' +
         '<a href="https://www.linkedin.com/in/alina-quintana/">LinkedIn</a>.',
    failed: 'Something went wrong sending that. You can reach Alina on ' +
            '<a href="https://www.linkedin.com/in/alina-quintana/">LinkedIn</a> ' +
            'in the meantime.',
    unconfigured: 'This form isn’t connected yet. You can reach Alina on ' +
                  '<a href="https://www.linkedin.com/in/alina-quintana/">LinkedIn</a>.'
  };

  function status(form) {
    var el = form.querySelector('.form-status');
    if (!el) {
      el = document.createElement('p');
      el.className = 'form-status';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      form.appendChild(el);
    }
    return el;
  }

  function say(form, html, kind) {
    var el = status(form);
    el.innerHTML = html;
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-ok', kind === 'ok');
  }

  // Same allow-list as analytics.js: Statsig gets Pulse conversions only.
  var PULSE = {
    connect_form_submitted: true,
    newsletter_subscribed: true,
    waitlist_joined: true
  };

  function log(name, meta) {
    /* A pinned Labs layout still logs to Amplitude, so a submit can be
       watched while a layout is being built, but it carries labs_pinned and
       Statsig never sees it: someone checking a layout was never bucketed
       into an arm. Mirrors logEvent() in assets/js/analytics.js. */
    var labs = window.__aqLabs;
    var pinned = !!(labs && labs.design);

    var props = meta || {};
    props.homepage_design = (pinned && labs.design) ||
      document.documentElement.getAttribute('data-home-design') || 'control';
    /* Which page it was sent from. The memo signup appears twice — on the
       homepage and again at the foot of the blog index — and
       newsletter_subscribed is a Pulse conversion, so without this the two
       are one undifferentiated number. Same name and same derivation as
       analytics.js's page. */
    props.page = document.documentElement.getAttribute('data-page') || 'other';
    if (pinned) props.labs_pinned = true;
    try {
      // Amplitude always — product analytics source of truth.
      if (window.amplitude && typeof window.amplitude.track === 'function') {
        window.amplitude.track(name, props);
      }
      if (!pinned && PULSE[name] && window.statsigClient) {
        window.statsigClient.logEvent(name, null, props);
      }
    } catch (err) {}
  }

  var widgets = [];
  var turnstileWaiters = [];
  var turnstileLoading = false;

  function loadTurnstile(done) {
    if (!SITEKEY) { done(); return; }
    if (window.turnstile) { done(); return; }
    turnstileWaiters.push(done);
    if (turnstileLoading) return;
    turnstileLoading = true;
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    function flush() {
      var q = turnstileWaiters;
      turnstileWaiters = [];
      for (var i = 0; i < q.length; i++) q[i]();
    }
    s.onload = flush;
    s.onerror = flush;
    document.head.appendChild(s);
  }

  function inClosedDialog(el) {
    var d = el.closest && el.closest('dialog');
    return !!(d && !d.open);
  }

  function renderWidget(form) {
    var slot = form.querySelector('.js-turnstile');
    if (!slot || !SITEKEY || !window.turnstile) return;
    if (slot.getAttribute('data-widget-id')) return;
    try {
      var id = window.turnstile.render(slot, { sitekey: SITEKEY, theme: 'auto' });
      slot.setAttribute('data-widget-id', id);
      widgets.push({ form: form, id: id, slot: slot });
    } catch (err) {}
  }

  function resetWidget(form) {
    if (!window.turnstile) return;
    for (var i = 0; i < widgets.length; i++) {
      if (widgets[i].form === form) {
        try { window.turnstile.reset(widgets[i].id); } catch (err) {}
        return;
      }
    }
    renderWidget(form);
  }

  function tokenFor(form) {
    if (!SITEKEY) return '';
    var slot = form.querySelector('.js-turnstile');
    var id = slot && slot.getAttribute('data-widget-id');
    if (!id || !window.turnstile || typeof window.turnstile.getResponse !== 'function') {
      return '';
    }
    return window.turnstile.getResponse(id) || '';
  }

  function wire(form) {
    var requestedKind = form.getAttribute('data-form');
    var kind = requestedKind === 'contact' || requestedKind === 'waitlist'
      ? requestedKind : 'newsletter';
    var button = form.querySelector('button[type="submit"]');
    var loadedAt = Date.now();

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      /* Validity first, then the event, then whether there is anywhere to
         send it. A submit the browser itself refused — a missing email, the
         consent box unticked — is not an attempt the visitor made, and an
         endpoint that isn't configured yet is not their problem: they tried
         either way, and form_submitted says so. The success events below
         stay what they always were, so the two together read as a funnel. */
      if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
        return;
      }
      log('form_submitted', { form: kind });

      if (!CONFIGURED) {
        say(form, MESSAGES.unconfigured, 'error');
        return;
      }

      var data = new FormData(form);
      data.set('form', kind);
      data.set('origin', window.location.origin);
      data.set('loaded_at', String(loadedAt));
      if (SITEKEY) {
        var token = tokenFor(form);
        if (!token) {
          say(form, MESSAGES.bot, 'error');
          return;
        }
        data.set('turnstile_token', token);
      }

      var body = new URLSearchParams();
      data.forEach(function (value, key) { body.append(key, value); });

      var label = button ? button.textContent : '';
      if (button) { button.disabled = true; button.textContent = 'Sending…'; }
      say(form, 'Sending…', null);

      // URL-encoded keeps this a "simple" request, so the browser sends it
      // straight through without a CORS preflight that Apps Script can't answer.
      fetch(ENDPOINT, { method: 'POST', body: body })
        .then(function (response) { return response.json(); })
        .then(function (result) {
          if (result && result.ok) {
            form.reset();
            say(form, MESSAGES[kind], 'ok');
            var successEvent = kind === 'contact'
              ? 'connect_form_submitted'
              : (kind === 'waitlist' ? 'waitlist_joined' : 'newsletter_subscribed');
            log(successEvent);
          } else if (result && result.error === 'invalid_email') {
            say(form, MESSAGES.invalid_email, 'error');
          } else if (result && result.error === 'rate_limited') {
            say(form, MESSAGES.rate_limited, 'error');
          } else if (result && result.error === 'too_long') {
            say(form, MESSAGES.too_long, 'error');
          } else if (result && result.error === 'bot') {
            say(form, MESSAGES.bot, 'error');
          } else {
            say(form, MESSAGES.failed, 'error');
          }
        })
        .catch(function () {
          say(form, MESSAGES.failed, 'error');
        })
        .then(function () {
          resetWidget(form);
          if (button) { button.disabled = false; button.textContent = label; }
        });
    });
  }

  loadTurnstile(function () {
    var forms = document.querySelectorAll('form[data-form]');
    for (var i = 0; i < forms.length; i++) {
      wire(forms[i]);
      if (!inClosedDialog(forms[i])) renderWidget(forms[i]);
    }
  });

  document.addEventListener('aq:waitlist-opened', function (ev) {
    var dialog = ev && ev.detail && ev.detail.dialog;
    if (!dialog) return;
    var form = dialog.querySelector('form[data-form]');
    if (!form) return;
    loadTurnstile(function () {
      renderWidget(form);
      resetWidget(form);
    });
  });
})();
