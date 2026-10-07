/* Reels in the homepage Instagram grid. Wix plays them inside the tile:
   muted, looping, with no controls, and only while the pointer is over the
   tile. A phone has no hover, so there a reel plays while it is on screen
   and stops when it scrolls away. Still photos are untouched.

   The homepage ships the grid three times, once per design, and hides the
   other two. A hidden tile has no box, so the hover and visibility checks
   below never start its copy of the video. */
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var tiles = [].slice.call(document.querySelectorAll('.ig-tile'));
  var hover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function video(tile) {
    return tile.querySelector('video');
  }

  function play(tile) {
    var v = video(tile);
    if (!v || !tile.getClientRects().length) return;
    var pending = v.play();
    if (pending && pending.then) {
      pending.then(function () { tile.classList.add('is-playing'); }, function () {});
    }
  }

  function stop(tile) {
    var v = video(tile);
    if (!v) return;
    v.pause();
    tile.classList.remove('is-playing');
  }

  if (hover) {
    tiles.forEach(function (tile) {
      if (!video(tile)) return;
      tile.addEventListener('pointerenter', function () { play(tile); });
      tile.addEventListener('pointerleave', function () { stop(tile); });
    });
    return;
  }

  if (!('IntersectionObserver' in window)) return;
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) play(entry.target);
      else stop(entry.target);
    });
  }, { threshold: 0.6 });
  tiles.forEach(function (tile) {
    if (video(tile)) seen.observe(tile);
  });
})();
