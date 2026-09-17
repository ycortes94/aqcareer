/* Analytics for aqcareer.com — Amplitude + Statsig.
 *
 * Config comes from site.json and is injected by the build as
 * window.__AQ_ANALYTICS__. Nothing loads unless a key is set, so the site
 * works fine with analytics switched off.
 *
 * Privacy notes, because this site's contact form collects a name, an email
 * and a free-text message to a career counselor:
 *
 *  - Amplitude Session Replay masks text inputs by default. On top of that,
 *    maskSelector covers both form blocks entirely, so surrounding text and
 *    the message textarea are masked too. We never add `.amp-unmask`.
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

  function startStatsig() {
    var key = CFG.statsig_client_key;
    if (!key) return Promise.resolve();

    return load(SRC.statsig).then(function () {
      if (!window.Statsig) return;
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
      return client.initializeAsync();
    });
  }

  if (optedOut()) return;
  if (!CFG.amplitude_api_key && !CFG.statsig_client_key) return;

  Promise.all([
    startAmplitude().catch(function (e) { console.warn('[analytics] amplitude:', e.message); }),
    startStatsig().catch(function (e) { console.warn('[analytics] statsig:', e.message); })
  ]);
})();
