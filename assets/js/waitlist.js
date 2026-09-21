/* The 2027 career counseling interest list, as a dialog.
 *
 * The panel is a <dialog> in the markup rather than a section this script
 * hides: closed, a <dialog> is display:none in the browser's own stylesheet,
 * so nothing flashes on the page before this file arrives and there is no
 * hidden-by-default class to get stuck on if it never does. base.html's
 * <noscript> lays it back out as a static block for a visitor with no
 * JavaScript, who then gets the form itself rather than a dead link.
 *
 * Each trigger is an ordinary <a href="#waitlist"> carrying
 * data-waitlist="open", so the link still points at the panel's id whatever
 * happens here. Both homepage layouts ship their own dialog — the control's
 * #waitlist and the variant's #ft-waitlist — because each is styled by its
 * own layout; the trigger's href says which one it opens.
 */
(function () {
  'use strict';

  /* Mirrors logEvent() in analytics.js and log() in forms.js: Amplitude
     always, and a pinned Labs layout is stamped rather than dropped. This
     one is Amplitude-only — opening the panel is not a conversion on the
     experiment's scorecard, so Statsig never hears about it. */
  function log(name, meta) {
    var labs = window.__aqLabs;
    var pinned = !!(labs && labs.design);

    var props = meta || {};
    props.homepage_design = (pinned && labs.design) ||
      document.documentElement.getAttribute('data-home-design') || 'control';
    props.page = document.documentElement.getAttribute('data-page') || 'other';
    if (pinned) props.labs_pinned = true;
    try {
      if (window.amplitude && typeof window.amplitude.track === 'function') {
        window.amplitude.track(name, props);
      }
    } catch (err) {}
  }

  function dialogFor(el) {
    var href = el.getAttribute('href') || '';
    if (href.charAt(0) !== '#' || href.length < 2) return null;
    var found = document.getElementById(href.slice(1));
    return (found && found.tagName === 'DIALOG') ? found : null;
  }

  // The first thing worth typing in, rather than the close button.
  function focusFirstField(dialog) {
    var field = dialog.querySelector(
      'input:not([type="hidden"]):not([tabindex="-1"]), textarea, select');
    if (field && typeof field.focus === 'function') field.focus();
  }

  var returnTo = null;

  /* Named rather than read off document.activeElement: Safari does not
     focus a link when you click it, so the element to come back to has to
     be the one that asked for the dialog. */
  function open(dialog, source, trigger) {
    if (!dialog || dialog.open) return;
    returnTo = trigger || document.activeElement;
    /* showModal() is what gives the backdrop, the Escape key and the focus
       trap. Without it — an old browser — the open attribute still reveals
       the panel in the page, unmodal but usable, which is the same thing
       the <noscript> fallback settles for. */
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    focusFirstField(dialog);
    try {
      document.dispatchEvent(new CustomEvent('aq:waitlist-opened', { detail: { dialog: dialog } }));
    } catch (err) {}
    log('waitlist_opened', { source: source || 'link' });
  }

  function close(dialog) {
    if (!dialog || !dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    /* close() restores focus itself in current browsers; this covers the
       attribute path above and anything that loses track of it. */
    if (returnTo && typeof returnTo.focus === 'function') returnTo.focus();
    returnTo = null;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;

    var trigger = t.closest('[data-waitlist="open"]');
    if (trigger) {
      var dialog = dialogFor(trigger);
      if (dialog) {
        ev.preventDefault();
        open(dialog, 'link', trigger);
      }
      return;
    }

    var closer = t.closest('[data-waitlist="close"]');
    if (closer) {
      ev.preventDefault();
      close(closer.closest('dialog'));
      return;
    }

    /* Clicking outside the panel. The panel fills the dialog's box, so a
       click that lands on the dialog itself landed on the backdrop. */
    if (t.tagName === 'DIALOG' && t.classList.contains('waitlist-dialog')) {
      close(t);
    }
  });

  /* Arriving on /#waitlist — a link in an email, or a shared URL. Either
     layout's id is honoured, and what opens is whichever layout is on show:
     the other one sits in a display:none block, where a dialog has nothing
     to paint and showModal() would do nothing visible. */
  var HASH = { waitlist: true, 'ft-waitlist': true };

  function shownDialog() {
    var all = document.querySelectorAll('dialog.waitlist-dialog');
    for (var i = 0; i < all.length; i++) {
      var layout = all[i].closest('#layout-control,#layout-fresh');
      if (!layout || layout.getClientRects().length) return all[i];
    }
    return null;
  }

  function openFromHash() {
    if (!HASH[(window.location.hash || '').slice(1)]) return;
    open(shownDialog(), 'hash');
  }

  /* Not before the experiment has picked a layout: until then the variant is
     still display:none and the control would answer for it. */
  function whenSettled(fn) {
    var h = document.documentElement;
    if (!h.classList.contains('exp-pending') || !window.MutationObserver) {
      fn();
      return;
    }
    var obs = new MutationObserver(function () {
      if (h.classList.contains('exp-pending')) return;
      obs.disconnect();
      fn();
    });
    obs.observe(h, { attributes: true, attributeFilter: ['class'] });
  }

  window.addEventListener('hashchange', openFromHash);
  whenSettled(openFromHash);
})();
