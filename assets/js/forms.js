/* Form submission for aqcareer.com.
 *
 * Both forms post to a Google Apps Script web app, which emails the
 * submission on. The endpoint URL is injected by the build from
 * site.json (form_endpoint).
 *
 * Progressive enhancement: without JavaScript the forms still submit
 * normally to the same endpoint, they just leave the page to do it.
 */
(function () {
  'use strict';

  var ENDPOINT = document.documentElement.getAttribute('data-form-endpoint') || '';

  // Require https so submissions are never sent in the clear. Plain http is
  // allowed on localhost only, for testing against a local stub.
  var CONFIGURED = /^https:\/\//.test(ENDPOINT) ||
                   /^http:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(ENDPOINT);

  var MESSAGES = {
    newsletter: 'Thank you — you’re on the list for the first memo.',
    contact: 'Thank you — your message is on its way. Alina will be in touch.',
    invalid_email: 'That email address doesn’t look right. Mind checking it?',
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
  var PULSE = { connect_form_submitted: true, newsletter_subscribed: true };

  function log(name, meta) {
    /* A pinned Labs layout logs nothing, the same as a pinned pageview:
       these events carry the design, and someone checking a layout was
       never bucketed into an arm. See assets/js/labs.js. */
    var labs = window.__aqLabs;
    if (labs && labs.design) return;

    var props = meta || {};
    props.homepage_design =
      document.documentElement.getAttribute('data-home-design') || 'control';
    try {
      // Amplitude always — product analytics source of truth.
      if (window.amplitude && typeof window.amplitude.track === 'function') {
        window.amplitude.track(name, props);
      }
      if (PULSE[name] && window.statsigClient) {
        window.statsigClient.logEvent(name, null, props);
      }
    } catch (err) {}
  }

  function wire(form) {
    var kind = form.getAttribute('data-form') === 'contact' ? 'contact' : 'newsletter';
    var button = form.querySelector('button[type="submit"]');

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
            log(kind === 'contact' ? 'connect_form_submitted' : 'newsletter_subscribed');
          } else if (result && result.error === 'invalid_email') {
            say(form, MESSAGES.invalid_email, 'error');
          } else {
            say(form, MESSAGES.failed, 'error');
          }
        })
        .catch(function () {
          say(form, MESSAGES.failed, 'error');
        })
        .then(function () {
          if (button) { button.disabled = false; button.textContent = label; }
        });
    });
  }

  var forms = document.querySelectorAll('form[data-form]');
  for (var i = 0; i < forms.length; i++) { wire(forms[i]); }
})();
