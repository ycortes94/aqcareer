/* Analytics for aqcareer.com — Amplitude + Statsig.
 *
 * Config comes from site.json and is injected by the build as
 * window.__AQ_ANALYTICS__. Nothing loads unless a key is set, so the site
 * works fine with analytics switched off.
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
 *  - Both are skipped entirely for visitors sending Do Not Track or Global
 *    Privacy Control, when respect_dnt is on.
 */
(function () {
  'use strict';

  var CFG = window.__AQ_ANALYTICS__ || {};
  var SR = CFG.session_replay || {};

  // Pinned exact versions — a floating major could change behaviour under us.
  var SRC = {
    amplitude: 'https://cdn.jsdelivr.net/npm/@amplitude/analytics-browser@2.45.10/lib/scripts/amplitude-min.js',
    replay: 'https://cdn.amplitude.com/libs/plugin-session-replay-browser-1.35.1-min.js.gz',
    statsig: 'https://cdn.jsdelivr.net/npm/@statsig/js-client@3.33.5/build/statsig-js-client+web-analytics.min.js'
  };

  // Everything inside the forms is masked in replays.
  var FORM_SELECTORS = ['#memo-form', 'form.contact'];

  function optedOut() {
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
  var homeRevealTimer = null;

  function logEvent(name, metadata) {
    try {
      if (window.statsigClient) {
        window.statsigClient.logEvent(name, null, metadata || {});
      }
    } catch (err) {}
  }

  function revealHome(design) {
    var html = document.documentElement;
    if (!html.classList.contains('home-exp')) return;
    // The real reveal lives in an inline script in the page head, so that a
    // blocked or failed analytics.js can't leave the page hidden. Defer to it.
    if (typeof window.__aqReveal === 'function') {
      window.__aqReveal(design);
      return;
    }
    if (homeRevealTimer) {
      clearTimeout(homeRevealTimer);
      homeRevealTimer = null;
    }
    html.setAttribute('data-home-design', design === 'fresh_take' ? 'fresh_take' : 'control');
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

  function applyHomeExperiment(client) {
    var html = document.documentElement;
    if (!html.classList.contains('home-exp')) return;
    var design = 'control';
    if (client && typeof client.getExperiment === 'function') {
      var exp = client.getExperiment(HOME_EXP);
      if (exp && typeof exp.get === 'function') {
        design = exp.get(HOME_PARAM, 'control') || 'control';
      }
    }
    revealHome(design);
    logEvent('home_viewed', { homepage_design: design });
    wireCtas(design);
    if (design === 'fresh_take') {
      var map = { services: 'ft-services', connect: 'ft-connect', about: 'ft-about', main: 'ft-main' };
      var id = (window.location.hash || '').replace('#', '');
      if (map[id]) {
        var target = document.getElementById(map[id]);
        if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView();
      }
    }
  }

  function startStatsig() {
    var key = CFG.statsig_client_key;
    if (!key) {
      applyHomeExperiment(null);
      return Promise.resolve();
    }

    return load(SRC.statsig).then(function () {
      if (!window.Statsig) {
        applyHomeExperiment(null);
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
        applyHomeExperiment(client);
      });
    });
  }

  if (document.documentElement.classList.contains('home-exp')) {
    homeRevealTimer = setTimeout(function () { revealHome('control'); }, REVEAL_MS);
  }

  if (optedOut()) {
    revealHome('control');
    return;
  }
  if (!CFG.amplitude_api_key && !CFG.statsig_client_key) {
    revealHome('control');
    return;
  }

  Promise.all([
    startAmplitude().catch(function (e) { console.warn('[analytics] amplitude:', e.message); }),
    startStatsig().catch(function (e) {
      console.warn('[analytics] statsig:', e.message);
      applyHomeExperiment(null);
    })
  ]);
})();
