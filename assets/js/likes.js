/* Likes and sharing for every blog design. Published totals come from
 * content/likes.json via the weekly Amplitude export. Local state provides
 * immediate feedback; analytics still requires measurement consent.
 */
(function () {
  'use strict';

  var KEY = 'aq_likes_v1';
  var memory = null;

  var LABEL = { off: 'Like this post', on: 'Liked' };

  function slug() {
    return document.documentElement.getAttribute('data-post') || '';
  }

  /* localStorage throws outright in some settings (Safari private mode,
     blocked site data). A like still works for the pageview in that case —
     it just won't be there on the next one. */
  function read() {
    if (memory !== null) return memory;
    try {
      var raw = window.localStorage.getItem(KEY);
      var val = raw ? JSON.parse(raw) : null;
      return (val && typeof val === 'object' && !Array.isArray(val)) ? val : {};
    } catch (err) {
      return {};
    }
  }

  function write(map) {
    memory = map;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(map));
    } catch (err) {}
  }

  function log(name) {
    // Exclude development presses made with a Labs layout pinned.
    var labs = window.__aqLabs;
    var pinned = !!(labs && labs.design);

    var meta = {
      post: slug(),
      homepage_design: (pinned && labs.design) ||
        document.documentElement.getAttribute('data-home-design') || 'control'
    };
    if (pinned) meta.labs_pinned = true;
    try {
      // Amplitude only — likes are not Pulse metrics for the homepage test.
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

  // The local like is added to the last published total for immediate feedback.
  // It may overlap with the next export for this browser only.
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
      var word = el.querySelector('[data-like-word]');
      if (word) word.textContent = n === 1 ? 'like' : 'likes';
      el.setAttribute('aria-label',
        (liked ? 'You liked this post. ' : '') + n + (n === 1 ? ' like' : ' likes'));
    }
  }

  function wireSharing() {
    var popup = document.querySelector('.post-share-popup');
    var copy = document.querySelector('[data-copy-link]');
    var status = document.querySelector('[data-share-status]');
    var canonical = document.querySelector('link[rel="canonical"]');
    var url = canonical ? canonical.href : window.location.href.split(/[?#]/)[0];
    if (popup) {
      popup.addEventListener('beforetoggle', function (event) {
        if (event.newState === 'open') status.textContent = '';
      });
    }
    if (copy) {
      copy.hidden = false;
      copy.addEventListener('click', async function () {
        try {
          await navigator.clipboard.writeText(url);
          status.textContent = 'Link copied!';
        } catch (err) {
          status.textContent = 'Copy this link: ' + url;
        }
      });
    }
  }

  function wire() {
    paintCards();
    wireSharing();
    /* The blog index swaps a page of cards in without a reload — see
       assets/js/paging.js. The new ones carry the published total with this
       visitor's own like missing, so repaint when it says so. */
    document.addEventListener('aq:cards-swapped', paintCards);

    var bar = document.querySelector('[data-like-bar]');
    var btn = bar && bar.querySelector('[data-like]');
    var id = slug();
    if (!bar || !btn || !id) return;

    var liked = !!read()[id];
    paint(btn, liked);
    btn.hidden = false;

    btn.addEventListener('click', function () {
      liked = !liked;
      var map = read();
      if (liked) map[id] = new Date().toISOString(); else delete map[id];
      write(map);
      paint(btn, liked);
      paintCards();
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
