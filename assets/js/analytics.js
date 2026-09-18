/* Analytics for aqcareer.com — Amplitude + Statsig, behind a consent gate.
 *
 * Config comes from site.json and is injected by the build as
 * window.__AQ_ANALYTICS__. Nothing loads unless a key is set, so the site
 * works fine with analytics switched off.
 *
 * Consent (consent.required, on by default):
 *
 *  - On a first visit nothing third-party loads. A disclaimer appears and the
 *    visitor chooses. Only "Accept" loads Amplitude and Statsig; the choice is
 *    remembered in localStorage, not in a cookie, so declining stores nothing
 *    a server ever sees.
 *  - The choice is changeable afterwards from the footer link on any page or
 *    from the privacy page. Withdrawing reloads the page, because Session
 *    Replay is already recording by then and stopping it mid-page is
 *    best-effort at most.
 *  - A Do Not Track or Global Privacy Control signal (respect_dnt) still wins
 *    outright: no banner, no scripts, no choice to make.
 *
 * Privacy notes, because this site's contact form collects a name, an email
 * and a free-text message to a career counselor:
 *
 *  - Session Replay masking is set per project in the Amplitude UI, and the
 *    UI overrides anything the SDK asks for. So both <form> elements carry
 *    the amp-block class in the markup, which a remote config cannot undo.
 *    maskSelector below is a secondary layer. We never add `.amp-unmask`.
 *  - Statsig loads the bundle WITHOUT session replay, and its form_submit /
 *    input autocapture events are filtered out before they're logged.
 */
(function () {
  'use strict';

  var CFG = window.__AQ_ANALYTICS__ || {};
  var SR = CFG.session_replay || {};
  var CONSENT = CFG.consent || {};
  var NEEDS_CONSENT = CONSENT.required !== false;

  // Versioned: if what we collect ever changes materially, bump the key and
  // every visitor is asked again rather than held to a stale answer.
  var STORE_KEY = 'aq_consent_v1';
  var GRANTED = 'granted';
  var DENIED = 'denied';

  var HAS_KEYS = !!(CFG.amplitude_api_key || CFG.statsig_client_key);

  // Pinned exact versions — a floating major could change behaviour under us.
  var SRC = {
    amplitude: 'https://cdn.jsdelivr.net/npm/@amplitude/analytics-browser@2.45.10/lib/scripts/amplitude-min.js',
    replay: 'https://cdn.amplitude.com/libs/plugin-session-replay-browser-1.35.1-min.js.gz',
    statsig: 'https://cdn.jsdelivr.net/npm/@statsig/js-client@3.33.5/build/statsig-js-client+web-analytics.min.js'
  };

  // Everything inside the forms is masked in replays.
  var FORM_SELECTORS = ['#memo-form', 'form.contact'];

  function signalOptOut() {
    if (!CFG.respect_dnt) return false;
    try {
      return navigator.globalPrivacyControl === true ||
             navigator.doNotTrack === '1' ||
             window.doNotTrack === '1' ||
             navigator.msDoNotTrack === '1';
    } catch (err) {
      return false;
    }
  }

  /* ---------- stored choice ----------
     localStorage can throw outright (Safari private mode, blocked site data),
     and a visitor who has blocked storage has effectively declined. */

  function readChoice() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var val = JSON.parse(raw);
      var state = val && val.state;
      return state === GRANTED || state === DENIED ? state : null;
    } catch (err) {
      return null;
    }
  }

  function writeChoice(state) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        state: state,
        at: new Date().toISOString()
      }));
      return true;
    } catch (err) {
      return false;   // declining is the safe outcome of a failed write
    }
  }

  function load(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function startAmplitude() {
    var key = CFG.amplitude_api_key;
    if (!key) return Promise.resolve();

    var chain = load(SRC.amplitude);
    if (SR.enabled) {
      chain = chain.then(function () { return load(SRC.replay); });
    }

    return chain.then(function () {
      if (SR.enabled && window.sessionReplay && window.amplitude) {
        var privacyConfig = {};
        if (SR.mask_forms !== false) {
          privacyConfig.maskSelector = FORM_SELECTORS;
        }
        window.amplitude.add(window.sessionReplay.plugin({
          sampleRate: typeof SR.sample_rate === 'number' ? SR.sample_rate : 1,
          privacyConfig: privacyConfig
        }));
      }

      window.amplitude.init(key, {
        // Declining calls setOptOut(true), which Amplitude persists in its own
        // AMP_<key> cookie. Nothing else ever clears it, so without this an
        // accept that follows a decline would init an SDK that silently drops
        // every event — and skips the page-view plugin entirely. Consent is
        // held in localStorage and we only reach here having been granted, so
        // state that outright rather than inheriting a stale cookie.
        optOut: false,
        autocapture: {
          attribution: true,
          pageViews: true,
          sessions: true,
          formInteractions: true,   // start/submit only — never field values
          fileDownloads: true,
          elementInteractions: false,
          pageUrlEnrichment: true,
          networkTracking: false,
          webVitals: true
        }
      });
    });
  }

  var HOME_EXP = 'homepage_fresh_take';
  var HOME_PARAM = 'homepage_design';
  var REVEAL_MS = 2500;
  var revealTimer = null;
  var revealedDesign = null;

  /* The fresh-take design covers the homepage, the blog index and the post
     pages. All three ask the same experiment which arm this visitor is in,
     so a reader given the fresh homepage doesn't then land on a
     control-styled blog. data-page says which of the three this is. */
  function pageKind() {
    return document.documentElement.getAttribute('data-page') || 'home';
  }

  function logEvent(name, metadata) {
    try {
      if (window.statsigClient) {
        window.statsigClient.logEvent(name, null, metadata || {});
      }
    } catch (err) {}
  }

  function revealDesign(design) {
    var html = document.documentElement;
    if (!html.classList.contains('home-exp')) return;
    if (revealedDesign) return;   // first reveal wins; never swap under a reader
    revealedDesign = design === 'fresh_take' ? 'fresh_take' : 'control';
    // The real reveal lives in an inline script in the page head, so that a
    // blocked or failed analytics.js can't leave the page hidden. Defer to it.
    if (typeof window.__aqReveal === 'function') {
      window.__aqReveal(revealedDesign);
      return;
    }
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    html.setAttribute('data-home-design', revealedDesign);
    html.classList.remove('exp-pending');
  }

  function wireCtas(design) {
    function bind(sel, eventName) {
      var nodes = document.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].addEventListener('click', function () {
          logEvent(eventName, { homepage_design: design });
        });
      }
    }
    bind('[data-cta="hero"]', 'hero_cta_clicked');
    bind('[data-cta="primary"]', 'cta_clicked');
  }

  function applyDesignExperiment(client) {
    var html = document.documentElement;
    if (!html.classList.contains('home-exp')) return;

    // Labs has pinned a layout for development (see assets/js/labs.js). Don't
    // ask Statsig for an assignment — that would log an exposure for a variant
    // nobody was really bucketed into — and log nothing else either. A pinned
    // pageview is someone checking a layout, not experiment data.
    var labs = window.__aqLabs;
    if (labs && labs.design) {
      revealDesign(labs.design);
      remapHash(labs.design);
      return;
    }

    var design = 'control';
    // Consent given part-way through a pageview: the page is already showing
    // control, so that is the design this visit saw. Report it as such rather
    // than asking Statsig for a variant we can no longer honour.
    if (!revealedDesign && client && typeof client.getExperiment === 'function') {
      /* Only the homepage logs an exposure. The experiment's exposed
         population is people who saw the homepage, and it has been running
         on that basis; adding everyone who arrives straight onto a post from
         search, or onto the blog index from a link, would change what the
         results mean halfway through. Those pages read the assignment so the
         design stays consistent, and report themselves with their own
         <kind>_viewed event below, which carries the design. */
      var exp = pageKind() === 'home'
        ? client.getExperiment(HOME_EXP)
        : client.getExperiment(HOME_EXP, { disableExposureLog: true });
      if (exp && typeof exp.get === 'function') {
        design = exp.get(HOME_PARAM, 'control') || 'control';
      }
    } else if (revealedDesign) {
      design = revealedDesign;
    }
    revealDesign(design);
    var kind = pageKind();
    var meta = { homepage_design: design };
    if (kind === 'post') {
      meta.post = document.documentElement.getAttribute('data-post') || '';
    }
    logEvent(kind + '_viewed', meta);
    wireCtas(design);
    remapHash(design);
  }

  /* Every path that gives up on assignment lands on control — unless Labs has
     pinned a layout, which outranks all of them: pinning has to work with
     measurement declined, with a DNT signal, and with no keys configured,
     since that is exactly when you want to look at a layout undisturbed. */
  function revealFallback() {
    var labs = window.__aqLabs;
    var design = (labs && labs.design) || 'control';
    revealDesign(design);
    remapHash(design);
  }

  // The variant's sections carry ft- prefixed ids, so a link written against
  // the control's anchors has to be pointed at the equivalent section.
  function remapHash(design) {
    if (design !== 'fresh_take') return;
    var map = { services: 'ft-services', connect: 'ft-connect', about: 'ft-about', main: 'ft-main' };
    var id = (window.location.hash || '').replace('#', '');
    if (!map[id]) return;
    var target = document.getElementById(map[id]);
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView();
  }

  function startStatsig() {
    var key = CFG.statsig_client_key;
    if (!key) {
      applyDesignExperiment(null);
      return Promise.resolve();
    }

    return load(SRC.statsig).then(function () {
      if (!window.Statsig) {
        applyDesignExperiment(null);
        return;
      }
      var StatsigClient = window.Statsig.StatsigClient;
      var runStatsigAutoCapture = window.Statsig.runStatsigAutoCapture;

      var client = new StatsigClient(key, {});

      if (typeof runStatsigAutoCapture === 'function') {
        runStatsigAutoCapture(client, {
          // Drop anything tied to form or input interaction, so field names
          // and typed content can't reach Statsig from these two forms.
          eventFilterFunc: function (event) {
            var name = (event && (event.eventName || event.name) || '') + '';
            return !/form_submit|form_start|input|change|submit/i.test(name);
          }
        });
      }

      window.statsigClient = client;   // available for gates/experiments later
      return client.initializeAsync().then(function () {
        applyDesignExperiment(client);
      });
    });
  }

  var started = false;

  function startTracking() {
    if (started) return;
    started = true;
    Promise.all([
      startAmplitude().catch(function (e) { console.warn('[analytics] amplitude:', e.message); }),
      startStatsig().catch(function (e) {
        console.warn('[analytics] statsig:', e.message);
        applyDesignExperiment(null);
      })
    ]);
  }

  /* ---------- the disclaimer ---------- */

  var POLICY_HREF = (function () {
    // Pages live at /, /blog/ and /post/<slug>/; a root-relative link works
    // for all of them and for the 404 page.
    return (CONSENT.policy_url || '/privacy/');
  })();

  var banner = null;

  function buildBanner() {
    if (banner) return banner;

    var el = document.createElement('div');
    el.className = 'aq-consent';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-labelledby', 'aq-consent-title');
    el.setAttribute('aria-describedby', 'aq-consent-body');
    el.hidden = true;
    el.innerHTML =
      '<div class="panel">' +
        '<h2 class="t" id="aq-consent-title">Data &amp; analytics notice</h2>' +
        /* Two sentences here are promises the code has to keep:

           1. "Nothing is loaded until you accept" is literally true —
              startTracking() runs only from choose(GRANTED), so no SDK is
              fetched before the click. Don't move tracking earlier without
              rewriting this line.
           2. "All sensitive text fields are masked" holds because build.py
              puts amp-block on both <form> elements, blanking them in
              replays, and every text input on this site sits inside one of
              those two forms. Add an input outside them and the sentence
              stops being true — the Amplitude project's own mask level is
              "light", which does not cover free text. */
        '<p class="b" id="aq-consent-body">We use analytics and session replay ' +
          'tools to observe real-time website interactions (such as clicks, ' +
          'scrolling, and browsing paths). This helps us improve our career ' +
          'counseling resources and troubleshoot website errors. All sensitive ' +
          'text fields are masked. We never sell your data or use it for ' +
          'targeted ads. Nothing is loaded until you accept. Read our ' +
          '<a href="' + POLICY_HREF + '">Privacy Policy</a>.</p>' +
        '<p class="b" data-aq-consent-now></p>' +
        '<div class="row">' +
          '<button type="button" class="yes" data-aq-consent="accept">Accept</button>' +
          '<button type="button" class="no" data-aq-consent="decline">No thanks</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(el);
    banner = el;
    return el;
  }

  function openBanner(focusIt) {
    var el = buildBanner();

    // Reopened from the footer or the privacy page, the first-visit wording
    // would be untrue — say where things actually stand instead.
    var state = readChoice();
    el.querySelector('.t').textContent =
      state ? 'Your tracking choice' : 'Data & analytics notice';
    // On a first visit this stays empty: the notice above already says
    // nothing is loaded until you accept, so a second line saying it again
    // is just noise. The reopened states still report where things stand.
    var now = el.querySelector('[data-aq-consent-now]');
    now.textContent =
      state === GRANTED
        ? 'Measurement is on for this browser right now. Turning it off ' +
          'reloads the page so nothing further is collected.'
        : state === DENIED
          ? 'Measurement is off for this browser. Nothing is being collected.'
          : '';
    now.hidden = !state;

    el.hidden = false;
    if (focusIt) {
      var btn = el.querySelector('[data-aq-consent="accept"]');
      if (btn) btn.focus();
    }
  }

  function closeBanner() {
    if (banner) banner.hidden = true;
  }

  /* ---------- the standing opt-out ---------- */

  function statusText(state) {
    if (signalOptOut()) {
      return 'Off. Your browser is sending a Do Not Track or Global Privacy ' +
             'Control signal, so no analytics load on this site.';
    }
    if (!HAS_KEYS) return 'Off. This site has no analytics configured.';
    if (state === GRANTED) return 'On. You accepted measurement on this browser.';
    if (state === DENIED) return 'Off. You declined measurement on this browser.';
    return 'Not chosen yet. Nothing is loaded until you choose.';
  }

  function paintUi() {
    var state = readChoice();
    var locked = signalOptOut() || !HAS_KEYS;

    var i, nodes;

    nodes = document.querySelectorAll('[data-aq-consent-status]');
    for (i = 0; i < nodes.length; i++) nodes[i].textContent = statusText(state);

    // Controls are hidden in the markup and revealed here, so they never show
    // for a visitor who has no working JavaScript or nothing to switch off.
    nodes = document.querySelectorAll('[data-aq-consent-ui]');
    for (i = 0; i < nodes.length; i++) nodes[i].hidden = locked;

    nodes = document.querySelectorAll('[data-aq-consent="accept"]');
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].closest('.aq-consent')) continue;
      nodes[i].disabled = state === GRANTED;
    }
    nodes = document.querySelectorAll('[data-aq-consent="decline"]');
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].closest('.aq-consent')) continue;
      nodes[i].disabled = state === DENIED;
    }
  }

  function choose(state) {
    var was = readChoice();
    var stored = writeChoice(state);
    closeBanner();

    if (state === GRANTED && stored) {
      startTracking();
    } else if (state === DENIED && was === GRANTED) {
      // Already loaded and already recording. Ask the SDKs to stop, then
      // reload so the next paint genuinely runs without them.
      try { if (window.amplitude) window.amplitude.setOptOut(true); } catch (err) {}
      try { if (window.statsigClient) window.statsigClient.shutdown(); } catch (err) {}
      window.location.reload();
      return;
    }
    paintUi();
  }

  function wireUi() {
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-aq-consent]');
      if (!t) return;
      var action = t.getAttribute('data-aq-consent');
      if (action === 'accept') { ev.preventDefault(); choose(GRANTED); }
      else if (action === 'decline') { ev.preventDefault(); choose(DENIED); }
      else if (action === 'open') { ev.preventDefault(); openBanner(true); }
    });

    document.addEventListener('keydown', function (ev) {
      // Escape only dismisses a banner reopened after a decision; on a first
      // visit the choice stays on screen.
      if (ev.key === 'Escape' && banner && !banner.hidden && readChoice()) {
        closeBanner();
      }
    });

    paintUi();
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  /* ---------- go ---------- */

  if (document.documentElement.classList.contains('home-exp')) {
    revealTimer = setTimeout(revealFallback, REVEAL_MS);
  }

  ready(wireUi);

  if (signalOptOut() || !HAS_KEYS) {
    revealFallback();
    return;
  }

  window.aqConsent = {
    state: readChoice,
    accept: function () { choose(GRANTED); },
    decline: function () { choose(DENIED); },
    open: function () { ready(function () { openBanner(true); }); },
    /* Forget the answer and reload, so the next paint is a genuine first
       visit with no SDK loaded. Reopening the dialog in place instead would
       show the first-visit notice while Amplitude and Replay were already
       running. Lives here rather than in a caller because STORE_KEY is
       versioned — bump it and this keeps clearing the right thing. */
    reset: function () {
      try { window.localStorage.removeItem(STORE_KEY); } catch (err) {}
      try { if (window.amplitude) window.amplitude.setOptOut(true); } catch (err) {}
      try { if (window.statsigClient) window.statsigClient.shutdown(); } catch (err) {}
      window.location.reload();
    }
  };

  if (!NEEDS_CONSENT) {
    startTracking();
    return;
  }

  var choice = readChoice();
  if (choice === GRANTED) {
    startTracking();
  } else {
    // Declined, or not asked yet. Either way the homepage shows control (or
    // whatever Labs pinned), and it shows it now rather than after the
    // reveal timeout.
    revealFallback();
    if (choice !== DENIED) ready(function () { openBanner(false); });
  }
})();
