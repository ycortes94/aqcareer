/* Keep header highlights in step with homepage sections in every design.
   Blog/post pages retain their server-rendered POV Blog page highlight. */
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-page') !== 'home') return;

  var navs = [].slice.call(document.querySelectorAll('header nav'));
  var queued = false, pending = null, settleTimer;

  function links(nav) {
    return [].slice.call(nav.querySelectorAll('a[data-nav]'));
  }

  function highlight(nav, name) {
    links(nav).forEach(function (link) {
      if (link.getAttribute('data-nav') === name) {
        link.setAttribute('aria-current', name === 'home' ? 'page' : 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  function paint() {
    queued = false;
    navs.forEach(function (nav) {
      if (!nav.getClientRects().length) return;
      if (pending) { highlight(nav, pending); return; }
      var current = 'home', best = -Infinity, last = null;
      var line = window.innerHeight * 0.4;
      links(nav).forEach(function (link) {
        var hash = new URL(link.href, location.href).hash.slice(1);
        var section = hash && document.getElementById(hash);
        if (!section || !section.getClientRects().length) return;
        last = link.getAttribute('data-nav');
        var top = section.getBoundingClientRect().top;
        if (top <= line && top > best) {
          best = top;
          current = link.getAttribute('data-nav');
        }
      });
      // Short final sections may never reach the reading line.
      if (last && window.scrollY > 0 &&
          window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        current = last;
      }
      highlight(nav, current);
    });
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  }

  function select(name) {
    pending = name;
    clearTimeout(settleTimer);
    paint();
    // Keep the clicked item selected throughout native smooth scrolling.
    settleTimer = setTimeout(function () { pending = null; schedule(); }, 1500);
  }

  function fromHash() {
    var name = location.hash.replace(/^#(?:ft-|rz-)?/, '');
    if (name === 'services' || name === 'connect' || name === 'about') select(name);
    else schedule();
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[data-nav]');
    if (!link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        link.target === '_blank' || link.hasAttribute('download')) return;
    var url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    var name = link.getAttribute('data-nav');
    if (name !== 'home' && name !== 'about' && name !== 'services' && name !== 'connect') return;
    select(name);
    if (name === 'home' && !url.hash) {
      event.preventDefault();
      history.pushState(null, '', url.href);
      window.scrollTo({top: 0, behavior: 'smooth'});
    }
    var menu = document.getElementById('mainnav');
    var burger = document.querySelector('.burger');
    if (menu) menu.classList.remove('open');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  });

  window.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', schedule);
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('popstate', fromHash);
  window.addEventListener('load', schedule);
  // A visitor can interrupt a smooth scroll and start reading elsewhere.
  function cancelPending() { pending = null; clearTimeout(settleTimer); schedule(); }
  window.addEventListener('wheel', cancelPending, {passive: true});
  window.addEventListener('touchstart', cancelPending, {passive: true});
  window.addEventListener('keydown', function (event) {
    if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key)) cancelPending();
  });
  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(document.documentElement,
      {attributes: true, attributeFilter: ['class', 'data-home-design']});
  }
  fromHash();
})();
