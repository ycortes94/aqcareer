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
 *  - Statsig loads the core client ONLY (no web-analytics / autocapture).
 *    Amplitude owns product analytics and Session Replay. Statsig owns
 *    experiment assignment and a small set of Pulse conversion events.
 *    The Statsig → Amplitude integration should forward exposures only.
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
  // Core Statsig client only: the +web-analytics build was dual-logging
  // pageviews/clicks into Statsig, and the outgoing Amplitude integration
  // then forwarded those as auto_capture::* on top of Amplitude autocapture.
  var SRC = {
    amplitude: 'https://cdn.jsdelivr.net/npm/@amplitude/analytics-browser@2.45.10/lib/scripts/amplitude-min.js',
    replay: 'https://cdn.amplitude.com/libs/plugin-session-replay-browser-1.35.1-min.js.gz',
    statsig: 'https://cdn.jsdelivr.net/npm/@statsig/js-client@3.33.5/build/statsig-js-client.min.js'
  };

  /* Events Statsig needs for homepage_fresh_take Pulse. Everything else is
     Amplitude-only so the Statsig → Amplitude integration cannot inflate
     charts when it forwards product events. Keep this list in sync with the
     experiment's primary/secondary metrics. */
  var STATSIG_PULSE_EVENTS = {
    hero_cta_clicked: true,
    cta_clicked: true,
    connect_form_submitted: true,
    newsletter_subscribed: true,
    waitlist_joined: true
  };

  // Everything inside the forms is masked in replays.
  var FORM_SELECTORS = ['form[data-form]'];

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

  function startAmplitude(deviceId) {
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

      var initOpts = {
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
      };
      // Same ID Statsig uses for assignment (stableID), so forwarded exposures
      // join to the same Amplitude user / Session Replay as product events.
      if (deviceId) initOpts.deviceId = deviceId;

      window.amplitude.init(key, undefined, initOpts);
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
    return document.documentElement.getAttribute('data-page') || '';
  }

  /* Amplitude is the product-analytics source of truth. Statsig only gets
     Pulse conversion events (STATSIG_PULSE_EVENTS) so experiment scorecards
     keep working without duplicating pageviews and nav clicks into Amplitude
     via the outgoing integration. */
  /* Amplitude loads after Statsig on purpose, so it can take Statsig's
     stableID as its deviceId — but the design events fire the moment the
     assignment lands, which is a beat before that. Sent straight through,
     every one of them found window.amplitude still undefined and vanished:
     home_viewed, blog_viewed and post_viewed were never reaching Amplitude
     at all. Hold anything logged before the SDK is there.

     Bounded, and emptied without sending if Amplitude never arrives — a
     blocked CDN shouldn't leave the page filling a queue for a session. */
  var ampReady = false;
  var ampQueue = [];
  var AMP_QUEUE_MAX = 40;

  function trackAmplitude(name, metadata) {
    var meta = metadata || {};
    if (!ampReady) {
      if (ampQueue.length < AMP_QUEUE_MAX) ampQueue.push([name, meta]);
      return;
    }
    try {
      if (window.amplitude && typeof window.amplitude.track === 'function') {
        window.amplitude.track(name, meta);
      }
    } catch (err) {}
  }

  /* Called once startAmplitude() has settled either way. With no key
     configured, or a CDN that never answered, window.amplitude is still
     undefined and the flush quietly drops what it is holding. */
  function amplitudeSettled() {
    ampReady = true;
    var queued = ampQueue;
    ampQueue = [];
    for (var i = 0; i < queued.length; i++) {
      trackAmplitude(queued[i][0], queued[i][1]);
    }
  }

  function logStatsigPulse(name, metadata) {
    if (!STATSIG_PULSE_EVENTS[name]) return;
    var meta = metadata || {};
    try {
      if (window.statsigClient) {
        window.statsigClient.logEvent(name, null, meta);
      }
    } catch (err) {}
  }

  /* Labs has pinned a layout for development (see assets/js/labs.js). Pinned
     sessions used to log nothing at all, which made the panel useless for the
     one question people actually asked of it — does this variant's markup
     fire anything? — because the only way to see the fresh-take layout is to
     pin it, and pinning switched the logging off.

     They log to Amplitude now, so a click can be watched landing in the Event
     Explorer while a layout is being built, and every one of them carries
     labs_pinned. Statsig still sees none of it: Pulse scorecards are the
     experiment's results and nobody pinning a layout was bucketed into an
     arm. Exclude labs_pinned in any chart meant to stand for real visitors. */
  function labsPinned() {
    var labs = window.__aqLabs;
    return !!(labs && labs.design);
  }

  function logEvent(name, metadata) {
    var meta = metadata || {};
    if (labsPinned()) {
      meta.labs_pinned = true;
      trackAmplitude(name, meta);
      return;
    }
    trackAmplitude(name, meta);
    logStatsigPulse(name, meta);
  }

  /* Events queue for a second before upload, which is fine for a click that
     stays on the page and not fine for one that leaves it. Best-effort: the
     navigation can still win the race. */
  function flushNow() {
    try {
      if (window.amplitude && typeof window.amplitude.flush === 'function') {
        window.amplitude.flush();
      }
    } catch (err) {}
    try {
      if (window.statsigClient && typeof window.statsigClient.flush === 'function') {
        window.statsigClient.flush();
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

  /* ---------- clicks ----------
     Amplitude's elementInteractions autocapture is off (see startAmplitude),
     so a control logs nothing unless this file logs it. That used to mean
     two named events — the hero CTA and the nav links — and a site where
     every other control was silent: the testimonial arrows and dots, the
     burger menu, the post cards on the blog index, the links at the foot of
     an article, the social icons. A replay showed the visitor clicking and
     the event stream showed nothing.

     One delegated listener on the document now covers all of it. Delegated
     rather than bound per node for the reasons the nav always was: it covers
     both chromes (the homepage ships each nav twice, one hidden by CSS), it
     covers pages that never run the experiment — privacy, 404 — and it
     survives anything rendered later, such as the carousel's own dots.

     One click produces one event, the most specific one that fits, with two
     deliberate exceptions:

      - The fresh-take Connect link carries data-cta and data-nav and logs
        both, as it has since the nav events shipped. One link wearing two
        hats: filter by one event or the other, never sum them.
      - A control that logs its own event logs nothing here — the like
        button (post_liked, in likes.js), the interest list's open and close
        buttons (waitlist_opened, in waitlist.js), the form submit buttons
        (form_submitted, in forms.js), the consent buttons, which are the
        measurement UI rather than the site's, and the Labs panel, which is
        development furniture no visitor ever sees. */

  var CLICKABLE = 'a[href],button,[role="button"],input[type="submit"],input[type="button"]';
  var CLICK_OWN_EVENT = '[data-like],[data-aq-consent],[data-waitlist],[type="submit"],.aq-labs';

  // Rather than a second attribute to keep in sync in four templates.
  function elementLocation(el) {
    if (el.closest('footer')) return 'footer';
    if (el.closest('header')) return 'header';
    return 'page';
  }

  /* What the visitor actually read on the control. aria-label comes first
     because the icon-only ones — the carousel arrows, the social links —
     have no text at all. Capped, since a whole card's worth of copy is a
     property nobody can chart. */
  function clickText(el) {
    var t = el.getAttribute('aria-label') || el.textContent || '';
    if (!t.trim() && el.tagName === 'INPUT') t = el.value || '';
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 80) : t;
  }

  // Null for anything that isn't a link. `leaves` is what decides a flush:
  // an in-page anchor stays put, a mail or tel link hands off without
  // unloading, everything else can take the page with it.
  function linkTarget(el) {
    var href = el.tagName === 'A' ? el.getAttribute('href') : null;
    if (!href) return null;
    if (href.charAt(0) === '#') return { kind: 'anchor', leaves: false };
    if (/^mailto:/i.test(href)) return { kind: 'email', leaves: false };
    if (/^tel:/i.test(href)) return { kind: 'phone', leaves: false };
    var host;
    try {
      host = new URL(href, window.location.href).host;
    } catch (err) {
      host = window.location.host;
    }
    return {
      kind: host === window.location.host ? 'internal' : 'external',
      leaves: true
    };
  }

  /* The pin comes first: Labs flips the layout in place without a reload, so
     revealedDesign still holds whichever arm this pageview started on. Read
     it second and a click made after pinning fresh take reports control. */
  function designNow() {
    var labs = window.__aqLabs;
    if (labs && labs.design) return labs.design;
    return revealedDesign ||
           document.documentElement.getAttribute('data-home-design') || '';
  }

  /* The blog index cards. Which post was opened is the whole point of the
     event, so it comes from data-post — the slug the build already knows —
     rather than being parsed back out of the href. The position says which
     card in the grid it was, so "the top one always wins" can be checked
     against "this post is the one people want". */
  function postCardMeta(card) {
    var cards = document.querySelectorAll('.pcard');
    var position = 0;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] === card) { position = i + 1; break; }
    }
    var title = card.querySelector('h2');
    return {
      post: card.getAttribute('data-post') || '',
      post_title: title ? title.textContent.replace(/\s+/g, ' ').trim() : '',
      card_position: position
    };
  }

  function onClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;

    var design = designNow();
    var el = t.closest(CLICKABLE);
    var named = false;

    var cta = t.closest('[data-cta]');
    if (cta) {
      logEvent(cta.getAttribute('data-cta') === 'hero'
                 ? 'hero_cta_clicked' : 'cta_clicked',
               design ? { homepage_design: design } : {});
      named = true;
    }

    var nav = t.closest('[data-nav]');
    if (nav) {
      var navMeta = {
        // The stable one: rename the link's text and this still groups.
        nav_item: nav.getAttribute('data-nav') || '',
        // What the visitor actually read on the button.
        nav_label: clickText(nav),
        nav_location: elementLocation(nav)
      };
      if (design) navMeta.homepage_design = design;
      logEvent('nav_link_clicked', navMeta);
      named = true;
    }

    var card = named ? null : t.closest('.pcard');
    if (card) {
      var cardMeta = postCardMeta(card);
      if (design) cardMeta.homepage_design = design;
      logEvent('post_card_clicked', cardMeta);
      named = true;
    }

    if (!named && el && !el.closest(CLICK_OWN_EVENT)) {
      var meta = {
        element_type: el.tagName === 'A' ? 'link' : 'button',
        element_text: clickText(el),
        element_id: el.id || '',
        element_location: elementLocation(el),
        page: pageKind() || 'other'
      };
      var link = linkTarget(el);
      if (link) {
        meta.link_type = link.kind;
        meta.link_url = el.getAttribute('href');
      }
      if (design) meta.homepage_design = design;
      logEvent('element_clicked', meta);
    }

    var target = el ? linkTarget(el) : null;
    if (target && target.leaves) flushNow();
  }

  function wireClicks() {
    document.addEventListener('click', onClick);
  }

  /* home_viewed / blog_viewed / post_viewed. One place, because a pinned
     layout reports the page the same way a bucketed visitor does — only the
     design it names and the labs_pinned stamp differ. */
  function logViewed(design) {
    var kind = pageKind() || 'home';
    var meta = { homepage_design: design };
    if (kind === 'post') {
      meta.post = document.documentElement.getAttribute('data-post') || '';
    }
    logEvent(kind + '_viewed', meta);
  }

  function applyDesignExperiment(client) {
    var html = document.documentElement;
    if (!html.classList.contains('home-exp')) return;

    // Labs has pinned a layout (see assets/js/labs.js). Don't ask Statsig for
    // an assignment — that would log an exposure for a variant nobody was
    // really bucketed into. The pageview itself is logged, carrying
    // labs_pinned like everything else from a pinned session, so the design
    // being looked at is legible in the event stream.
    var labs = window.__aqLabs;
    if (labs && labs.design) {
      revealDesign(labs.design);
      remapHash(labs.design);
      logViewed(labs.design);
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
    logViewed(design);
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

  function statsigStableId(client) {
    try {
      if (client && typeof client.getContext === 'function') {
        var ctx = client.getContext();
        if (ctx && ctx.stableID) return ctx.stableID;
      }
    } catch (err) {}
    return '';
  }

  function startStatsig() {
    var key = CFG.statsig_client_key;
    if (!key) {
      applyDesignExperiment(null);
      return Promise.resolve('');
    }

    return load(SRC.statsig).then(function () {
      if (!window.Statsig) {
        applyDesignExperiment(null);
        return '';
      }
      var StatsigClient = window.Statsig.StatsigClient;
      var client = new StatsigClient(key, {});

      // No runStatsigAutoCapture — Amplitude owns pageviews, clicks, forms.
      window.statsigClient = client;
      return client.initializeAsync().then(function () {
        applyDesignExperiment(client);
        return statsigStableId(client);
      });
    });
  }

  var started = false;

  function startTracking() {
    if (started) return;
    started = true;
    // Bound here, not at load: with measurement declined there is no listener
    // on the page at all.
    wireClicks();
    // Statsig first so Amplitude can init with the same stableID as deviceId.
    // Parallel init used to race and leave exposures unjoinable to Replay.
    startStatsig()
      .catch(function (e) {
        console.warn('[analytics] statsig:', e.message);
        applyDesignExperiment(null);
        return '';
      })
      .then(function (stableId) {
        return startAmplitude(stableId).catch(function (e) {
          console.warn('[analytics] amplitude:', e.message);
        });
      })
      // Whatever happened above, stop holding events for an SDK that is
      // either ready now or never coming.
      .then(amplitudeSettled);
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
           2. "All sensitive text fields are masked" rests on two layers.
              The project's remote mask level is "medium" (all form fields
              and text inputs) as checked on 2026-09-18, and build.py also
              puts amp-block on both <form> elements, which blanks them in
              replays and cannot be switched off from the Amplitude UI.
              Either alone would cover the forms; together they also cover
              an input added outside them. */
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
