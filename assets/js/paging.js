/* Blog index paging, without the trip back to the top of the page.
 *
 * /blog/ and /blog/page/N/ are separately built pages and they stay that
 * way: with no JavaScript the links navigate, and the archive works exactly
 * as it did. What this adds is the swap in place. Following one of those
 * links reloaded the whole document, which put the reader back at the
 * masthead every time — the pagination bar sits at the foot of a long list,
 * so paging through the archive meant scrolling back down after every
 * click.
 *
 * So the next page is fetched and only two things change: .blog-feed (the
 * cards and the bar) and the "Page 2 of 3" line beside the tagline. The
 * list is then brought up to the top of the screen, so the new posts start
 * where the eye already is rather than at the masthead.
 */
(function () {
  'use strict';

  var FEED = '.blog-feed';
  var NAV = '.blog-pagination';
  var LABEL = '.blog-head p';

  if (!document.querySelector(FEED + ' ' + NAV)) return;
  if (!window.fetch || !window.DOMParser || !window.history.pushState) return;

  // The URL on screen, fragment removed. popstate also fires for in-page
  // hash moves — the skip link — and those must not re-render anything.
  var here = bare(window.location.href);
  var busy = false;

  function bare(url) {
    return url.split('#')[0];
  }

  function pageOf(url) {
    var m = url.match(/\/blog\/page\/(\d+)\//);
    return m ? parseInt(m[1], 10) : 1;
  }

  /* Every link is written relative to the page it was built for: "../post/…"
     on /blog/, "../../../post/…" on /blog/page/2/. pushState moves the
     document's URL, and the browser then resolves the ones already in the
     page against the new one — so the header and footer would start
     pointing at directories that do not exist. Rewriting them from the URL
     they were built against pins them where they were, and doing the same
     to each fetched page means its cards arrive already correct.

     Same-origin links come out root-relative rather than absolute: it is
     the shorter thing to read in the DOM, and element_clicked's link_url
     reports the href as written, so "/privacy/" is a better value to land
     in Amplitude than the whole URL. Fragments are left alone — "#main" has
     to stay a fragment or the skip link starts navigating. */
  function repoint(root, from) {
    var nodes = root.querySelectorAll('a[href], img[src]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var attr = el.tagName === 'IMG' ? 'src' : 'href';
      var raw = el.getAttribute(attr);
      if (!raw || raw.charAt(0) === '#' || /^[a-z][a-z0-9+.-]*:/i.test(raw) ||
          raw.slice(0, 2) === '//') continue;
      var url = new URL(raw, from);
      el.setAttribute(attr, url.origin === window.location.origin ?
                            url.pathname + url.search + url.hash : url.href);
    }
  }

  /* Mirrors log() in assets/js/forms.js, which mirrors logEvent() in
     analytics.js: Amplitude only, since this is not a Pulse conversion, and
     a pinned Labs layout is stamped so it can be filtered back out.

     Logged at all because the navigation it replaces used to log one.
     Loading /blog/page/2/ for real fired blog_viewed; swapping it in fires
     nothing, so without this the far pages of the archive would quietly
     stop appearing in Amplitude the day this shipped. The pagination links
     carry data-blog-page, which keeps analytics.js's catch-all off them —
     one click, one event, as everywhere else. */
  function log(to) {
    var labs = window.__aqLabs;
    var pinned = !!(labs && labs.design);
    var props = {
      blog_page: to,
      homepage_design: (pinned && labs.design) ||
        document.documentElement.getAttribute('data-home-design') || 'control'
    };
    if (pinned) props.labs_pinned = true;
    try {
      if (window.amplitude && typeof window.amplitude.track === 'function') {
        window.amplitude.track('blog_page_changed', props);
      }
    } catch (err) {}
  }

  function swap(doc, url) {
    var current = document.querySelector(FEED);
    var next = doc.querySelector(FEED);
    if (!current || !next) return false;

    repoint(next, url);
    current.replaceWith(document.importNode(next, true));

    // "Page 2 of 3" sits with the heading rather than inside the feed.
    var label = document.querySelector(LABEL);
    var nextLabel = doc.querySelector(LABEL);
    if (label && nextLabel) label.replaceWith(document.importNode(nextLabel, true));

    var feed = document.querySelector(FEED);
    /* The link that was clicked has just been thrown away, and focus went
       to <body> with it — the next Tab would start again from the skip
       link. Hand it to the list instead, so the keyboard carries on from
       the first new post. The scroll is the line below, not this. */
    feed.setAttribute('tabindex', '-1');
    feed.focus({ preventScroll: true });
    /* Up to the first of the new posts. No behaviour argument on purpose:
       site.css sets scroll-behavior on <html> and turns it off again under
       prefers-reduced-motion, and .blog-feed carries the same
       scroll-margin-top as every other anchor target, to clear the sticky
       header. */
    feed.scrollIntoView({ block: 'start' });

    document.title = doc.title;
    var canonical = document.querySelector('link[rel="canonical"]');
    var nextCanonical = doc.querySelector('link[rel="canonical"]');
    if (canonical && nextCanonical) {
      canonical.setAttribute('href', nextCanonical.getAttribute('href'));
    }

    // The new cards show the published tally with this visitor's own likes
    // missing until likes.js repaints them.
    document.dispatchEvent(new CustomEvent('aq:cards-swapped'));
    return true;
  }

  function render(url, push) {
    if (busy) return;
    busy = true;

    var feed = document.querySelector(FEED);
    if (feed) feed.setAttribute('aria-busy', 'true');
    // Pinned before the first pushState, while the current URL is still the
    // one the page's own links were written against.
    repoint(document, window.location.href);

    fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      var doc = new DOMParser().parseFromString(text, 'text/html');
      if (!swap(doc, url)) throw new Error('no feed in ' + url);
      if (push) window.history.pushState(null, '', url);
      here = bare(url);
      busy = false;
      log(pageOf(here));
    }).catch(function () {
      // Offline, a 404, markup that changed shape — whatever it was, the
      // link goes and does what it would have done on its own.
      window.location.href = url;
    });
  }

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var link = ev.target.closest && ev.target.closest(NAV + ' a[href]');
    if (!link) return;
    ev.preventDefault();
    render(link.href, true);
  });

  window.addEventListener('popstate', function () {
    var url = bare(window.location.href);
    if (url === here) return;
    render(url, false);
  });
})();
