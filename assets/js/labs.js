/* Statsig Labs — a development-only switch for the fresh-take experiment.
 *
 * Why this exists: the homepage ships both layouts in the same document, and
 * a post page ships both sets of chrome around one article. Which you see is
 * decided by the `homepage_fresh_take` experiment in Statsig.
 * That makes the variant awkward to look at on purpose — you get whichever arm
 * you were bucketed into, and only after accepting measurement. This pins one.
 *
 * This file is not referenced by the built HTML. The inline gate in
 * templates/base.html decides whether Labs is on and injects it if so, so a
 * visitor downloads none of this and sees no trace of it in the page source.
 *
 * Enabling it (the same gate resolves the pin inline):
 *
 *   - automatic on localhost / 127.0.0.1 / *.local
 *   - ?labs=1  turns it on anywhere and remembers it for that browser
 *   - ?labs=0  turns it off again and forgets the pin
 *   - ?design=fresh_take / ?design=control  pins a layout straight from a URL,
 *     which is the shareable form: send someone a link to one arm.
 *
 * It is off for everyone else, so a visitor never sees the panel.
 *
 * It deliberately records nothing. A pinned pageview is not experiment data:
 * analytics.js skips asking Statsig for an assignment (asking would log an
 * exposure for a variant nobody was really bucketed into) and logs no events.
 * So use it to look at layouts, never to test whether tracking fires.
 */
(function () {
  'use strict';

  var LABS = window.__aqLabs;
  if (!LABS || !LABS.enabled) return;

  var KEY = 'aq_labs_v1';
  var HIDE_KEY = 'aq_labs_hidden';
  var DESIGNS = [
    { id: 'control', label: 'Control' },
    { id: 'fresh_take', label: 'Fresh take' }
  ];

  function store(patch) {
    try {
      var st = JSON.parse(window.localStorage.getItem(KEY) || 'null') || {};
      for (var k in patch) {
        if (patch[k] === null) delete st[k]; else st[k] = patch[k];
      }
      st.enabled = true;
      window.localStorage.setItem(KEY, JSON.stringify(st));
    } catch (err) {}
  }

  function current() {
    return document.documentElement.getAttribute('data-home-design') || 'control';
  }

  /* Both layouts are already in the DOM and CSS decides which is shown, so
     switching is an attribute flip — no reload, no rebuild. */
  function pin(design) {
    store({ design: design });
    document.documentElement.setAttribute('data-home-design', design);
    document.documentElement.classList.remove('exp-pending');
    LABS.design = design;
    render();
  }

  function unpin() {
    store({ design: null });
    LABS.design = null;
    render();
  }

  /* z-index sits BELOW the consent dialog's 200 on purpose. Both are fixed to
     the bottom of the viewport, and under about 970px wide the dialog's button
     row reaches across into this panel — where, sitting on top, it swallowed
     the click on "Accept measurement". Consent has to win that overlap. The
     dialog's own container is pointer-events:none with only its white panel
     clickable, so this panel stays usable everywhere the panel isn't. */
  var css =
    '.aq-labs{position:fixed;z-index:150;left:14px;bottom:14px;' +
      'font:500 12px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;' +
      'color:#16211d;-webkit-font-smoothing:antialiased}' +
    '.aq-labs *{box-sizing:border-box}' +
    '.aq-labs button{font:inherit;cursor:pointer;margin:0}' +
    '.aq-labs .tab{display:flex;align-items:center;gap:7px;background:#16211d;color:#fff;' +
      'border:0;border-radius:999px;padding:9px 15px;box-shadow:0 2px 10px rgba(0,0,0,.28)}' +
    '.aq-labs .dot{width:7px;height:7px;border-radius:50%;background:#7ee0c2;flex:none}' +
    '.aq-labs .dot.off{background:#8a9a94}' +
    '.aq-labs .panel{width:232px;background:#fff;border:1px solid rgba(1,66,53,.16);' +
      'border-radius:10px;padding:13px;box-shadow:0 8px 30px rgba(0,0,0,.2)}' +
    '.aq-labs .hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px}' +
    '.aq-labs .ttl{font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:10.5px;color:#4c5b56}' +
    '.aq-labs .x{background:none;border:0;color:#4c5b56;font-size:15px;line-height:1;padding:0 2px}' +
    '.aq-labs .seg{display:flex;border:1px solid rgba(1,66,53,.2);border-radius:7px;overflow:hidden}' +
    '.aq-labs .seg button{flex:1;background:#fff;border:0;padding:8px 6px;color:#16211d}' +
    '.aq-labs .seg button+button{border-left:1px solid rgba(1,66,53,.2)}' +
    '.aq-labs .seg button[aria-pressed="true"]{background:#014235;color:#fff;font-weight:700}' +
    '.aq-labs .note{margin:10px 0 0;font-size:11px;line-height:1.5;color:#4c5b56}' +
    '.aq-labs .note code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}' +
    '.aq-labs .live{background:none;border:0;padding:0;margin-top:9px;color:#014235;' +
      'text-decoration:underline;font-size:11px;text-align:left}' +
    '.aq-labs .live[disabled]{color:#8a9a94;text-decoration:none;cursor:default}' +
    '.aq-labs .sep{border:0;border-top:1px solid rgba(1,66,53,.12);margin:12px 0 9px}' +
    '@media print{.aq-labs{display:none}}';

  var root = document.createElement('div');
  root.className = 'aq-labs';

  function render() {
    var pinned = !!LABS.design;
    var hidden = false;
    try { hidden = window.sessionStorage.getItem(HIDE_KEY) === '1'; } catch (err) {}

    if (hidden) {
      root.innerHTML =
        '<button type="button" class="tab" data-act="show">' +
          '<span class="dot' + (pinned ? '' : ' off') + '"></span>Labs</button>';
      return;
    }

    var seg = DESIGNS.map(function (d) {
      var on = pinned && LABS.design === d.id;
      return '<button type="button" data-act="pin" data-design="' + d.id + '"' +
             ' aria-pressed="' + (on ? 'true' : 'false') + '">' + d.label + '</button>';
    }).join('');

    root.innerHTML =
      '<div class="panel" role="group" aria-label="Statsig Labs: site layout">' +
        '<div class="hd"><span class="ttl">Statsig Labs</span>' +
          '<button type="button" class="x" data-act="hide" aria-label="Hide Labs panel"' +
          ' title="Hide for this tab">&times;</button></div>' +
        '<div class="seg">' + seg + '</div>' +
        (pinned
          ? '<p class="note">Pinned to <strong>' + LABS.design + '</strong>. ' +
            'Nothing is being recorded for this pageview.</p>' +
            '<button type="button" class="live" data-act="unpin">Use the real experiment</button>'
          : '<p class="note">Not pinned — showing <strong>' + current() + '</strong> from the ' +
            'experiment. Pick a layout to pin it.</p>') +
        consentRow() +
        '<p class="note">Off with <code>?labs=0</code></p>' +
      '</div>';
  }

  /* The measurement dialog only appears until it has been answered once, which
     makes it awkward to look at again. Reset forgets the answer and reloads. */
  function consentRow() {
    var api = window.aqConsent;
    if (!api || typeof api.reset !== 'function') {
      // No keys configured, or a Do Not Track signal: there is no dialog and
      // nothing was stored, so there is nothing to reset.
      return '<hr class="sep"><p class="note">Measurement is off for this ' +
             'browser or not configured, so there is no disclaimer to reset.</p>';
    }
    var state = null;
    try { state = api.state(); } catch (err) {}
    var said = state === 'granted' ? 'accepted'
             : state === 'denied' ? 'declined'
             : 'not answered yet';
    return '<hr class="sep">' +
      '<p class="note">Disclaimer: <strong>' + said + '</strong></p>' +
      '<button type="button" class="live" data-act="reset-consent"' +
      (state ? '' : ' disabled') + '>Reset it and show the disclaimer</button>';
  }

  root.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'pin') pin(btn.getAttribute('data-design'));
    else if (act === 'unpin') unpin();
    else if (act === 'reset-consent') {
      // analytics.js owns the stored answer and the reload; it knows the
      // versioned key and shuts the SDKs down on the way out.
      if (window.aqConsent && window.aqConsent.reset) window.aqConsent.reset();
    }
    else if (act === 'hide' || act === 'show') {
      try { window.sessionStorage.setItem(HIDE_KEY, act === 'hide' ? '1' : '0'); } catch (err) {}
      render();
    }
  });

  /* Dropping below the dialog keeps it clickable, but on a narrow window the
     dialog is opaque and would simply bury this panel. So step aside while it
     is open — there is nothing to pin until the reader has answered it. */
  function consentOpen() {
    var el = document.querySelector('.aq-consent');
    return !!(el && !el.hidden);
  }

  function syncToConsent() {
    root.style.display = consentOpen() ? 'none' : '';
  }

  /* Re-render as well as re-hide, so the "Disclaimer: accepted/declined" line
     is right after the reader answers it. Guarded because render() rewrites
     this panel's own markup, which is itself a mutation inside body — without
     the flag the observer would retrigger on our own work, forever. The
     observer's records land in a microtask, so a macrotask timeout is late
     enough to have seen them all. */
  var syncing = false;
  function onConsentChange() {
    if (syncing) return;
    syncing = true;
    render();
    syncToConsent();
    setTimeout(function () { syncing = false; }, 0);
  }

  function watchConsent() {
    if (typeof window.MutationObserver !== 'function') return;
    // analytics.js builds the dialog lazily, so watch for it being added as
    // well as for it being shown and hidden again.
    new window.MutationObserver(onConsentChange).observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['hidden']
    });
  }

  function mount() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    render();
    document.body.appendChild(root);
    syncToConsent();
    watchConsent();
    /* labs.js and analytics.js load independently, so window.aqConsent may not
       exist yet. When the answer is already stored no dialog is ever built and
       the observer above never fires, so pick the state up once on a delay. */
    setTimeout(render, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
