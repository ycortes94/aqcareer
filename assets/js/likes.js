/* Post likes for aqcareer.com.
 *
 * Shipped with the fresh-take post page only; the control post page has no
 * like bar. The button is hidden in the markup and revealed here, so it is
 * never a dead control for a visitor without working JavaScript.
 *
 * What a like is, exactly: this site is static — GitHub Pages serves files
 * and there is nothing to POST a count to. So a like is remembered in the
 * visitor's own browser, in localStorage, and nothing is shared between
 * visitors. Pressing the button also logs post_liked, which is where the
 * real numbers come from: exported from Amplitude into content/likes.json,
 * committed, and rendered onto the blog index cards by the build. Those
 * totals are therefore as fresh as the last export and deploy.
 *
 * A live, always-accurate count would need somewhere to store a per-post
 * tally and an endpoint to read and increment it. That's a service to build
 * and look after, and this repo doesn't have one.
 *
 * Like state is deliberately kept out of the consent gate: it is this
 * browser's own record of what it liked, stored locally, never sent
 * anywhere. The *event* about it is gated, because logging one needs an SDK
 * that only loads once measurement is accepted.
 */
(function () {
  'use strict';

  var KEY = 'aq_likes_v1';

  var LABEL = { off: 'Like this post', on: 'Liked' };

  function slug() {
    return document.documentElement.getAttribute('data-post') || '';
  }

  /* localStorage throws outright in some settings (Safari private mode,
     blocked site data). A like still works for the pageview in that case —
     it just won't be there on the next one. */
  function read() {
    try {
      var raw = window.localStorage.getItem(KEY);
      var val = raw ? JSON.parse(raw) : null;
      return (val && typeof val === 'object') ? val : {};
    } catch (err) {
      return {};
    }
  }

  function write(map) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(map));
    } catch (err) {}
  }

  function log(name) {
    /* Labs has pinned a design for development (see assets/js/labs.js). This
       event carries the design, and a pinned pageview is someone looking at a
       layout rather than a visitor in an arm — logging it would file their
       like under a group nobody was bucketed into. The like itself still
       saves; it is this browser's own state, not experiment data. */
    var labs = window.__aqLabs;
    if (labs && labs.design) return;

    var meta = {
      post: slug(),
      homepage_design: document.documentElement.getAttribute('data-home-design') || 'control'
    };
    try {
      // Amplitude only — likes are not Pulse metrics for homepage_fresh_take.
      if (window.amplitude && typeof window.amplitude.track === 'function') {
        window.amplitude.track(name, meta);
      }
    } catch (err) {}
  }

  function paint(btn, liked) {
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    var label = btn.querySelector('.ft-like-label');
    if (label) label.textContent = liked ? LABEL.on : LABEL.off;
  }

  function beat(btn) {
    btn.classList.remove('is-beating');
    // Reading offsetWidth restarts the animation; without it a second like
    // in the same pageview re-adds a class the element already had and
    // nothing plays.
    void btn.offsetWidth;
    btn.classList.add('is-beating');
  }

  /* ---------- the blog index ----------
     A tally on each card. The published total is rendered by the build from
     content/likes.json — numbers exported from Amplitude by hand, because a
     static site has no server keeping a live one — and arrives in
     data-likes. All this adds is the visitor's own like on top, so the
     number moves when they press the button rather than sitting still until
     the next export.

     That means a like can be counted twice for one visitor: once here, and
     again in the next export once their event is in it. Off by one on their
     own screen only, and the alternative is a button that appears to do
     nothing. */

  function published(el) {
    var n = parseInt(el.getAttribute('data-likes'), 10);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  function paintCards() {
    var cards = document.querySelectorAll('[data-like-count]');
    if (!cards.length) return;
    var map = read();
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      var liked = !!map[el.getAttribute('data-like-count')];
      var n = published(el) + (liked ? 1 : 0);
      var out = el.querySelector('.n');
      if (out) out.textContent = n;
      el.classList.toggle('is-liked', liked);
      el.setAttribute('aria-label',
        (liked ? 'You liked this post. ' : '') + n + (n === 1 ? ' like' : ' likes'));
    }
  }

  function wire() {
    paintCards();

    var bar = document.querySelector('[data-like-bar]');
    var btn = bar && bar.querySelector('[data-like]');
    var id = slug();
    if (!bar || !btn || !id) return;

    var liked = !!read()[id];
    paint(btn, liked);
    bar.hidden = false;

    btn.addEventListener('click', function () {
      liked = !liked;
      var map = read();
      if (liked) map[id] = new Date().toISOString(); else delete map[id];
      write(map);
      paint(btn, liked);
      if (liked) beat(btn);
      log(liked ? 'post_liked' : 'post_unliked');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
