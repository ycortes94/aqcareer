#!/usr/bin/env python3
"""Build the static site.

    python3 tools/build.py

Reads  templates/  + content/  and writes index.html, blog/, post/<slug>/,
404.html, feed.xml, sitemap.xml. Safe to run any time; it only overwrites
generated files.
"""
import datetime as dt
import hashlib
import html
import json
import os
import re
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = os.path.join(ROOT, "templates")
C = os.path.join(ROOT, "content")

with open(os.path.join(ROOT, "site.json"), encoding="utf-8") as f:
    CFG = json.load(f)

SITE = CFG["url"].rstrip("/")
YEAR = dt.date.today().year
BLOG_PAGE_SIZE = 6


def asset_v(rel):
    """Short content hash, appended to asset URLs so a change reaches
    visitors instead of sitting in their browser cache."""
    try:
        with open(os.path.join(ROOT, rel), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:8]
    except OSError:
        return "0"


CSS_V = asset_v("assets/css/site.css")
FT_CSS_V = asset_v("assets/css/fresh-take.css")
RZ_CSS_V = asset_v("assets/css/raices.css")
JS_V = asset_v("assets/js/forms.js")
AN_V = asset_v("assets/js/analytics.js")
LABS_V = asset_v("assets/js/labs.js")
LIKES_V = asset_v("assets/js/likes.js")
WAITLIST_V = asset_v("assets/js/waitlist.js")
PAGING_V = asset_v("assets/js/paging.js")

# Fraunces is the variant's heading face and is only fetched by pages that
# ship the fresh-take layout.
FT_HEAD = (
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,'
    'wght@0,9..144,300..700;1,9..144,300..600&display=swap" rel="stylesheet">\n'
    '<link rel="stylesheet" href="{base}assets/css/fresh-take.css?v={v}">'
)
RZ_HEAD = '<link rel="stylesheet" href="{base}assets/css/raices.css?v={v}">'


def analytics_snippet(base):
    """Config blob + loader. Emits nothing when no keys are configured, so
    the site ships no third-party scripts until analytics is switched on."""
    cfg = CFG.get("analytics") or {}
    if not (cfg.get("amplitude_api_key") or cfg.get("statsig_client_key")):
        return ""
    blob = json.dumps(cfg, ensure_ascii=False).replace("</", "<\\/")
    return (f'<script>window.__AQ_ANALYTICS__={blob};</script>\n'
            f'<script src="{base}assets/js/analytics.js?v={AN_V}"></script>')


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(rel, text):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return rel


def fill(tpl, **kw):
    for k, v in kw.items():
        tpl = tpl.replace("{{%s}}" % k, str(v))
    return re.sub(r"\{\{[a-z_]+\}\}", "", tpl)   # blank any unused token


def fresh_chrome(base, cur_blog="", section_prefix="ft-"):
    """The fresh-take header and footer, as a (header, footer) pair.

    One source for both layouts that use them: the variant homepage, where
    they sit inside #layout-fresh, and the post page, where each is wrapped
    in its own .ft block around the shared article."""
    def part(name):
        return fill(read(os.path.join(T, name)), base=base, year=YEAR,
                    cur_blog=cur_blog, section_prefix=section_prefix)
    return part("fresh-header.html"), part("fresh-footer.html")


def editorial_chrome(base, cur_blog=""):
    """Both editorial chromes for a page that shares one copy of its content.

    The blog index and the post pages carry their content once and wrap it in
    one set of chrome per design, so fresh-take and raices each need a header
    and a footer of their own here — the section anchors differ, and so does
    the styling hook. CSS reveals whichever pair matches the assigned arm; see
    the .ft-chrome / .rz-chrome rules in site.css.

    Returns the two blocks that go above and below the content."""
    ft_head, ft_foot = fresh_chrome(base, cur_blog=cur_blog)
    rz_head, rz_foot = fresh_chrome(base, cur_blog=cur_blog,
                                    section_prefix="rz-")
    return (f'<div class="ft ft-chrome">\n{ft_head}\n</div>\n'
            f'<div class="ft rz rz-chrome">\n{rz_head}\n</div>',
            f'<div class="ft ft-chrome">\n{ft_foot}\n</div>\n'
            f'<div class="ft rz rz-chrome">\n{rz_foot}\n</div>')


def page(*, content, title, desc, canonical, base, ogtype="website",
         ogimage=None, cur_home="", cur_blog="", extra_js="",
         html_attrs="", extra_css="", layout_open="", layout_close="",
         variant_layout="", chrome_top="", extra_head=""):
    return fill(
        read(os.path.join(T, "base.html")),
        content=content, title=html.escape(title, quote=True),
        desc=html.escape(desc, quote=True), canonical=canonical, base=base,
        ogtype=ogtype, ogimage=ogimage or f"{SITE}/assets/img/headshot.jpg",
        cur_home=cur_home, cur_blog=cur_blog, year=YEAR, extra_js=extra_js,
        # Where the inline gate fetches the Labs panel from, if it decides to.
        # Every page gets the path; only a page that ships both designs — the
        # homepage, the blog index and the post pages — can ever act on it.
        labs_src=f"{base}assets/js/labs.js?v={LABS_V}",
        form_endpoint=html.escape(CFG.get("form_endpoint", ""), quote=True),
        turnstile_sitekey=html.escape(CFG.get("turnstile_site_key", ""), quote=True),
        css_v=CSS_V, analytics=analytics_snippet(base),
        html_attrs=html_attrs, extra_css=extra_css,
        extra_head=extra_head,
        layout_open=layout_open, layout_close=layout_close,
        variant_layout=variant_layout, chrome_top=chrome_top,
    )


def strip_tags(h):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h)).strip()


def excerpt(body_html, n=165):
    t = html.unescape(strip_tags(body_html))
    if len(t) <= n:
        return t
    return t[:n].rsplit(" ", 1)[0] + "…"


def nice_date(iso):
    try:
        return dt.date.fromisoformat(iso).strftime("%B %-d, %Y")
    except (ValueError, TypeError):
        return iso or ""


def read_minutes(words):
    return max(1, round(words / 225))


def image_size(rel):
    """(width, height) of a PNG, JPEG, WebP or GIF, read from its header.

    Pillow would be one line, and one dependency: this script also runs in
    the weekly likes workflow on a bare runner, where a pip install is a new
    way for the build to fail. Two integers are not worth that. Anything it
    can't read returns None, and the caller falls back to markup that works
    without the numbers — correct, just without the no-enlarging cap."""
    try:
        with open(os.path.join(ROOT, rel), "rb") as f:
            head = f.read(30)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                w, h = struct.unpack(">II", head[16:24])
                return int(w), int(h)
            if head[:6] in (b"GIF87a", b"GIF89a"):
                w, h = struct.unpack("<HH", head[6:10])
                return int(w), int(h)
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                # Three encodings, three places to look. The dimensions are
                # stored one less than they are, in all three.
                tag = head[12:16]
                if tag == b"VP8X":
                    w = int.from_bytes(head[24:27], "little") + 1
                    h = int.from_bytes(head[27:30], "little") + 1
                    return w, h
                if tag == b"VP8 ":
                    w, h = struct.unpack("<HH", head[26:30])
                    return (w & 0x3FFF), (h & 0x3FFF)
                if tag == b"VP8L":
                    bits = int.from_bytes(head[21:25], "little")
                    return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
                return None
            if head[:2] != b"\xff\xd8":
                return None
            # JPEG: walk the segment chain to the start-of-frame, which is
            # the only place the dimensions are written. Every iteration
            # starts on a marker's 0xFF prefix, of which there may be
            # several — the padding between segments is more 0xFF.
            f.seek(2)
            while True:
                byte = f.read(1)
                while byte == b"\xff":
                    byte = f.read(1)
                if not byte:
                    return None
                code = byte[0]
                (length,) = struct.unpack(">H", f.read(2))
                if 0xC0 <= code <= 0xCF and code not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", f.read(5)[1:5])
                    return int(w), int(h)
                if length < 2:
                    return None         # malformed; don't seek backwards
                f.seek(length - 2, 1)
    except (OSError, struct.error, IndexError):
        return None


# How tall a cover is allowed to get. The images are portraits, squares and
# wide photos all at once, so capping the height rather than the width is
# what keeps them a comparable size on the page.
COVER_MAX_H = 520


def cover_block(cover):
    """The post's hero image, in a frame no wider than the image itself.

    The covers are a mixed bag — 1600px photographs, a 250px book jacket, a
    squat logo. Stretched across the column the small ones came out blurry
    and cropped to a letterbox, a face sliced in half. So the frame carries
    the largest size the image can actually fill (--cover-w) and the
    stylesheet never asks for more than that; the height cap is folded into
    the same number, so a portrait doesn't become a tower. Intrinsic
    width/height go on the <img> too, which is what stops the text below
    jumping while the file loads."""
    if not cover:
        return ""
    size = image_size(cover.lstrip("/"))
    frame, dims = "", ""
    if size:
        w, h = size
        frame = f' style="--cover-w:{min(w, round(COVER_MAX_H * w / h))}px"'
        dims = f' width="{w}" height="{h}"'
    return ('  <div class="post-cover wrap">'
            f'<div class="cover"{frame}>'
            f'<img src="../..{cover}" alt=""{dims}></div></div>\n')


IMG_TAG = re.compile(r'<img\b[^>]*?src="(/assets/[^"]+)"[^>]*?>', re.I)


def size_body_images(body):
    """Stamp every image in a post body with its real pixel dimensions.

    Same two reasons as the cover: the browser reserves the right box before
    the file arrives, and the stylesheet can leave a small image at its own
    size instead of blowing it up to the width of the column. Posts come out
    of Wix with no dimensions on them at all, and hand-written ones are
    unlikely to carry any either."""
    def stamp(m):
        tag = m.group(0)
        if re.search(r"\swidth=", tag, re.I):
            return tag
        size = image_size(m.group(1).lstrip("/"))
        if not size:
            return tag
        return (tag.rstrip(">").rstrip("/").rstrip() +
                f' width="{size[0]}" height="{size[1]}">')
    return IMG_TAG.sub(stamp, body)


HEART_SVG = ('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4l-1.3-1.2C6 '
             '14.9 3 12.2 3 8.9 3 6.2 5.1 4 7.8 4c1.5 0 3 .7 3.9 1.9l.3.4.3-.4C13.2 4.7 '
             '14.7 4 16.2 4 18.9 4 21 6.2 21 8.9c0 3.3-3 6-7.7 10.3L12 20.4z" '
             'stroke-linejoin="round"/></svg>')

# The like bar, at the foot of the fresh-take post page. .ft-only keeps it out
# of the control design, which the experiment leaves exactly as it was; hidden
# keeps it out of the page until likes.js can make it work. Which post was
# liked comes from data-post on <html>, so the button carries no slug of its
# own. See assets/js/likes.js for what a like actually is here.
LIKE_BAR = f"""  <div class="ft-only ft-like" data-like-bar hidden>
    <button class="ft-like-btn" type="button" data-like aria-pressed="false">
      {HEART_SVG}
      <span class="ft-like-label">Like this post</span>
    </button>
    <p class="ft-like-note">Kept in this browser. No account, nothing shared.</p>
  </div>
"""


def turnstile_widget():
    """Mount point for Cloudflare Turnstile. Empty when no site key is set,
    so a local build without Turnstile still produces a working form."""
    key = html.escape(CFG.get("turnstile_site_key", "") or "", quote=True)
    if not key:
        return ""
    return f'<div class="js-turnstile" data-sitekey="{key}"></div>'


def subscribe_block(privacy_class):
    """The memo signup under the post list on the blog index.

    The same list and the same endpoint as the homepage hero's form, because
    there is only one list: a reader who got to the bottom of the posts is the
    one worth asking, and sending them back to the homepage to do it loses
    them. Not .ft-only like the like bar — this is the same offer in both
    designs, so it ships as one block that fresh-take.css restyles, the way
    the cards above it already are.

    Wears the homepage's own signup-band markup and copy rather than a shape
    of its own, so the two read as one offer made twice. Its ids are its own,
    though: two elements cannot share an id, and docs/ANALYTICS.md already
    warns that a submit test aimed at the wrong newsletter form drives a
    hidden one and appears to log nothing."""
    endpoint = html.escape(CFG.get("form_endpoint", ""), quote=True)
    return f"""
  <section class="signup-band memo-signup">
    <div class="wrap signup-grid">
      <div>
        <h2>Receive the Career Disruptor Memo</h2>
        <p>Occasional notes like these, sent straight to your inbox. Ask to be removed at any time.</p>
      </div>
      <form action="{endpoint}" method="post" id="blog-memo-form" data-form="memo" class="{privacy_class}">
        <input type="hidden" name="form" value="memo">
        <label class="field-label" for="blog-memo-email">Email address</label>
        <div class="subrow">
          <input class="line-input" id="blog-memo-email" name="email" type="email" required autocomplete="email" maxlength="254">
          <button class="btn-ghost" type="submit">Subscribe</button>
        </div>
        <label class="consent"><input type="checkbox" name="consent" value="yes" required> Yes, send me the Career Disruptor Memo.</label>
        {turnstile_widget()}
        <div class="hp" aria-hidden="true"><label for="blog-memo-website">Website</label><input id="blog-memo-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
      </form>
    </div>
  </section>
"""


def like_counts(slugs):
    """Published like totals, from content/likes.json.

    Hand-maintained: there is no server to keep a live tally, so the numbers
    are exported from Amplitude and committed — see docs/ANALYTICS.md. A
    missing file means every post shows zero, which is also what a brand new
    site would show, so it isn't an error."""
    path = os.path.join(C, "likes.json")
    try:
        data = json.loads(read(path))
    except OSError:
        return {}
    except json.JSONDecodeError as err:
        raise SystemExit(f"build aborted: content/likes.json is not valid "
                         f"JSON — {err}")
    if not isinstance(data, dict):
        raise SystemExit("build aborted: content/likes.json should be an "
                         'object of "<slug>": <count>.')
    for slug, n in data.items():
        if not isinstance(n, int) or isinstance(n, bool) or n < 0:
            raise SystemExit(f'build aborted: like count for "{slug}" is '
                             f"{n!r}; it has to be a whole number, 0 or more.")
        if slug not in slugs:
            # Not fatal — a post may have been renamed or removed — but a
            # typo here is otherwise invisible, showing zero forever.
            print(f'  warning: content/likes.json has "{slug}", which is not '
                  f"a post")
    return data


def like_count(slug, counts):
    """The like tally on a blog index card.

    The number is rendered by the build, so it is there with no JavaScript
    at all; likes.js only adds this visitor's own like on top of it."""
    n = counts.get(slug, 0)
    return (f'<span class="ft-only ft-card-likes" data-like-count="{slug}" '
            f'data-likes="{n}">{HEART_SVG}<span class="n">{n}</span></span>')


def testimonial_slides(style):
    """Render the testimonials as carousel slides.

    One source, two looks. The arms present testimonials differently — the
    control on a dark full-bleed band, the variant as its own light cards — but
    the words have to match, and keeping two copies of them is what let the
    variant sit on two abridged quotes while the control had three in full.
    """
    items = json.load(open(os.path.join(C, "testimonials.json"),
                           encoding="utf-8"))
    out = []
    for n, t in enumerate(items):
        on = " on" if n == 0 else ""
        body = "\n".join(f"          <p>{html.escape(p)}</p>"
                         for p in t["paragraphs"])
        who = html.escape(t["name"]) if t["name"] else ""
        industry, level = html.escape(t["industry"]), html.escape(t["level"])
        if style == "band":
            head = (f'        <div class="who">{who}</div>\n' if who else "")
            out.append(
                f'      <div class="slide{on}">\n{head}'
                f'        <div class="meta">{industry}</div>\n'
                f'        <div class="meta">{level}</div>\n'
                f'        <hr>\n'
                f'        <blockquote>\n{body}\n        </blockquote>\n'
                f'      </div>')
        else:   # "card" — the variant's own treatment, one card per slide
            attr = (f'<b>{who}</b>' if who else "") + \
                   f'{industry} &middot; {level}'
            out.append(
                f'      <div class="slide{on}">\n'
                f'        <div class="tcard">\n'
                f'          <span class="qm">&ldquo;</span>\n'
                f'          <blockquote>\n{body}\n          </blockquote>\n'
                f'          <div class="attr">{attr}</div>\n'
                f'        </div>\n'
                f'      </div>')
    return "\n".join(out)

CAROUSEL_JS = """<script>
/* Every carousel on the page, not just the first: the homepage carries both
   experiment layouts in one document, so each arm has its own and each needs
   its own state. Keyed off data-carousel rather than a class, because the two
   arms deliberately look nothing alike. */
(function(){
  [].forEach.call(document.querySelectorAll('[data-carousel]'), function(root){
    var slides=[].slice.call(root.querySelectorAll('.slide'));
    var dots=root.querySelector('.dots');
    if(slides.length<2){ if(dots) dots.remove();
      [].forEach.call(root.querySelectorAll('.arrow'),function(a){a.remove()}); return; }
    var i=0, buttons=[];
    slides.forEach(function(_,k){
      var b=document.createElement('button');
      b.setAttribute('role','tab');
      b.setAttribute('aria-label','Testimonial '+(k+1));
      b.addEventListener('click',function(){show(k)});
      dots.appendChild(b); buttons.push(b);
    });
    function show(k){
      i=(k+slides.length)%slides.length;
      slides.forEach(function(s,n){ s.classList.toggle('on', n===i) });
      buttons.forEach(function(b,n){ b.setAttribute('aria-selected', n===i?'true':'false') });
    }
    [].forEach.call(root.querySelectorAll('.arrow'),function(a){
      a.addEventListener('click',function(){ show(i+parseInt(a.dataset.step,10)) });
    });
    show(0);
  });
})();
</script>"""

SECTION_SPY_JS = """<script>
/* Section tracking for each editorial homepage arm. data-section-prefix on
   the layout keeps one copy of this logic working for both ft-* and rz-*
   anchors while the control keeps its own plain nav. */
(function(){
  var LINE=0.4;
  [].forEach.call(document.querySelectorAll('[data-section-prefix]'),function(layout){
    var nav=layout.querySelector('.hdr nav');
    var prefix=layout.getAttribute('data-section-prefix');
    if(!nav||!prefix) return;
    var marks=[].slice.call(nav.querySelectorAll('a[href*="#'+prefix+'"]')).map(function(a){
      return {link:a,section:document.getElementById(a.getAttribute('href').split('#')[1])};
    }).filter(function(m){return m.section});
    if(!marks.length) return;

    var queued=false,tail;
    function paint(){
      queued=false;
      if(!nav.getClientRects().length) return;
      var line=window.innerHeight*LINE,cur=null,best=-Infinity;
      marks.forEach(function(m){
        var top=m.section.getBoundingClientRect().top;
        if(top<=line&&top>best){best=top;cur=m}
      });
      marks.forEach(function(m){
        if(m===cur) m.link.setAttribute('aria-current','location');
        else if(m.link.getAttribute('aria-current')==='location') m.link.removeAttribute('aria-current');
      });
    }
    function schedule(){
      if(!queued){queued=true;requestAnimationFrame(paint)}
      clearTimeout(tail);tail=setTimeout(paint,120);
    }
    if(window.IntersectionObserver){
      var io=new IntersectionObserver(schedule,{
        rootMargin:(-LINE*100)+'% 0px '+(-(1-LINE)*100)+'% 0px'
      });
      marks.forEach(function(m){io.observe(m.section)});
    }
    addEventListener('scroll',schedule,{passive:true});
    addEventListener('resize',schedule);
    addEventListener('load',schedule);
    if(window.MutationObserver){
      new MutationObserver(schedule).observe(document.documentElement,
        {attributes:true,attributeFilter:['class','data-home-design']});
    }
    schedule();
  });
})();
</script>"""


# Anything that has to be on every page has to be in BOTH chromes: the
# control one in base.html and the fresh-take one in the partials. Adding a
# site-wide feature to one of them is a silent bug — whichever group a
# visitor lands in, they lose it.
SITE_WIDE = {
    "the tracking opt-out control": 'data-aq-consent="open"',
    "the script wordmark": '<span class="name">alina quintana</span>',
    # Services is the one nav item both chromes have, so it is the one to
    # check. A chrome without data-nav goes silent in nav_link_clicked while
    # the other keeps reporting — the breakdown then reads as a design
    # preference rather than a missing attribute.
    "nav click tracking (data-nav)": 'data-nav="services"',
}


def check_chrome():
    """Fail the build rather than ship a layout missing a site-wide feature.

    base.html covers the control layout and every page that has no variant;
    the fresh-take partials cover the variant homepage, blog index and post
    page, which all include them. Checked assembled, not as template source, so an
    include that silently stops being included is caught too."""
    header, footer = fresh_chrome(base="")
    sources = {
        "templates/base.html": read(os.path.join(T, "base.html")),
        "the fresh-take chrome": header + footer,
    }
    for name, src in sources.items():
        for label, needle in SITE_WIDE.items():
            if needle not in src:
                raise SystemExit(
                    f"build aborted: {name} is missing {label}.\n"
                    f"  expected to find: {needle}\n"
                    f"  Every layout needs it — see docs/ANALYTICS.md.")


def build():
    check_chrome()
    posts = json.load(open(os.path.join(C, "posts.json"), encoding="utf-8"))
    for p in posts:
        p["body"] = read(os.path.join(C, "posts", p["slug"] + ".html"))
        p["excerpt"] = excerpt(p["body"])
        # Derived, not hand-maintained: a stale "words" in posts.json would
        # only ever show a wrong reading time.
        p["words"] = len(strip_tags(p["body"]).split())
        p["nice"] = nice_date(p["date"])
        p["mins"] = read_minutes(p["words"])
    posts.sort(key=lambda p: p["date"], reverse=True)

    made = []

    # ---------- home ----------
    # Session Replay: mark the forms in the markup itself. Amplitude's
    # remote privacy config overrides SDK selectors, so a config-only
    # approach can be silently switched off server-side; a class can't be.
    an = CFG.get("analytics") or {}
    mask_forms = (an.get("session_replay") or {}).get("mask_forms", True)
    home = fill(read(os.path.join(T, "home.html")), base="",
                testimonials=testimonial_slides("band"),
                form_endpoint=html.escape(CFG.get("form_endpoint", ""),
                                          quote=True),
                form_privacy_class="amp-block" if mask_forms else "",
                turnstile=turnstile_widget())
    ft_header, ft_footer = fresh_chrome(base="")
    variant = fill(read(os.path.join(T, "home-fresh-take.html")), base="",
                   year=YEAR,
                   fresh_header=ft_header, fresh_footer=ft_footer,
                   testimonials=testimonial_slides("card"),
                   form_endpoint=html.escape(CFG.get("form_endpoint", ""),
                                             quote=True),
                   form_privacy_class="amp-block" if mask_forms else "",
                   turnstile=turnstile_widget())
    rz_header, rz_footer = fresh_chrome(base="", section_prefix="rz-")
    raices = fill(read(os.path.join(T, "home-raices.html")), base="",
                 year=YEAR,
                 raices_header=rz_header, raices_footer=rz_footer,
                 testimonials=testimonial_slides("card"),
                 form_endpoint=html.escape(CFG.get("form_endpoint", ""),
                                           quote=True),
                 form_privacy_class="amp-block" if mask_forms else "",
                 turnstile=turnstile_widget())
    made.append(write("index.html", page(
        content=home,
        title="Career Programs & Counseling | AQ Career Consulting",
        desc=CFG["description"], canonical=SITE + "/", base="",
        cur_home=' aria-current="page"',
        html_attrs=' class="home-exp exp-pending" data-page="home"',
        extra_css=FT_HEAD.format(base="", v=FT_CSS_V) + "\n" +
        RZ_HEAD.format(base="", v=RZ_CSS_V),
        layout_open='<div id="layout-control">',
        layout_close='</div>',
        variant_layout=variant + "\n" + raices,
        # No tag for labs.js on purpose: the inline gate in base.html injects
        # it, and only for a browser that has Labs switched on.
        extra_js=CAROUSEL_JS + SECTION_SPY_JS +
        f'\n<script src="assets/js/forms.js?v={JS_V}"></script>'
        f'\n<script src="assets/js/waitlist.js?v={WAITLIST_V}"></script>')))

    # ---------- blog index ----------
    # Six posts per page keeps the index useful as the archive grows. The
    # newest post on each page leads at full width; the rest follow as a
    # compact list.
    # The cover art across these posts is a mix of photos, book jackets and
    # logos, so thumbnails are contained rather than cropped — see the .thumb
    # rules in site.css.
    counts = like_counts({p["slug"] for p in posts})

    def post_card(p, kind, base, latest=False):
        """One index card. kind is "lead" for the newest post, "row" for the
        rest; both keep .pcard and data-post so post_card_clicked still fires
        with the position it was in — see assets/js/analytics.js."""
        thumb = (f'<div class="thumb"><img src="{base}{p["cover"].lstrip("/")}" '
                 f'alt="" loading="lazy"></div>') if p["cover"] else ""
        flag = '<p class="flag">Latest</p>\n          ' if latest else ""
        return (
            f'      <a class="pcard {kind}" href="{base}post/{p["slug"]}/" '
            f'data-post="{html.escape(p["slug"], quote=True)}">\n'
            f'        {thumb}\n'
            f'        <div class="pbody">\n'
            f'          {flag}<h2>{html.escape(p["title"])}</h2>\n'
            f'          <p class="excerpt">{html.escape(p["excerpt"])}</p>\n'
            f'          <div class="pmeta">'
            f'<span>{p["nice"]} &middot; {p["mins"]} min read</span>'
            f'{like_count(p["slug"], counts)}</div>\n'
            f'        </div>\n'
            f'      </a>')

    def blog_href(page_number, base):
        suffix = f"page/{page_number}/" if page_number > 1 else ""
        return f"{base}blog/{suffix}"

    def pagination(current, total, base):
        """Compact, accessible pagination that stays short for large archives.

        Every link carries data-blog-page. assets/js/paging.js swaps the
        page in rather than following it, and logs blog_page_changed itself;
        the attribute is also what keeps analytics.js's catch-all off these
        links, so one click still produces one event."""
        if total <= 1:
            return ""
        if total <= 7:
            shown = list(range(1, total + 1))
        elif current <= 4:
            shown = [1, 2, 3, 4, 5, total]
        elif current >= total - 3:
            shown = [1, total - 4, total - 3, total - 2, total - 1, total]
        else:
            shown = [1, current - 1, current, current + 1, total]

        items = []
        previous = None
        for number in shown:
            if previous is not None and number - previous > 1:
                items.append('<span class="blog-page-gap" aria-hidden="true">&hellip;</span>')
            if number == current:
                items.append(
                    f'<span class="blog-page-number" aria-current="page">{number}</span>')
            else:
                items.append(
                    f'<a class="blog-page-number" href="{blog_href(number, base)}" '
                    f'data-blog-page="{number}" '
                    f'aria-label="Page {number}">{number}</a>')
            previous = number

        older = (
            f'<a class="blog-page-direction" href="{blog_href(current + 1, base)}" '
            f'data-blog-page="{current + 1}">'
            'Older posts &rarr;</a>' if current < total else
            '<span class="blog-page-direction is-disabled">Older posts &rarr;</span>')
        newer = (
            f'<a class="blog-page-direction" href="{blog_href(current - 1, base)}" '
            f'data-blog-page="{current - 1}">'
            '&larr; Newer posts</a>' if current > 1 else
            '<span class="blog-page-direction is-disabled">&larr; Newer posts</span>')
        return (
            '    <nav class="blog-pagination" aria-label="Blog pages">\n'
            f'      {newer}\n'
            f'      <div class="blog-page-numbers">{"".join(items)}</div>\n'
            f'      {older}\n'
            '    </nav>\n')

    page_count = max(1, (len(posts) + BLOG_PAGE_SIZE - 1) // BLOG_PAGE_SIZE)
    blog_pages = []
    for page_number in range(1, page_count + 1):
        page_posts = posts[
            (page_number - 1) * BLOG_PAGE_SIZE:page_number * BLOG_PAGE_SIZE]
        base = "../" if page_number == 1 else "../../../"
        output = ("blog/index.html" if page_number == 1 else
                  f"blog/page/{page_number}/index.html")
        canonical = (f"{SITE}/blog/" if page_number == 1 else
                     f"{SITE}/blog/page/{page_number}/")

        feed = ""
        if page_posts:
            rows = "\n".join(
                post_card(p, "row", base) for p in page_posts[1:])
            feed = ('  <div class="blog-feed wrap">\n'
                    + post_card(page_posts[0], "lead", base,
                                latest=page_number == 1) + "\n"
                    + (f'    <div class="post-rows">\n{rows}\n    </div>\n'
                       if rows else "")
                    + pagination(page_number, page_count, base)
                    + '  </div>\n')

        page_label = (
            f' <span class="blog-page-label">Page {page_number} of '
            f'{page_count}</span>' if page_number > 1 else "")
        blog = ('  <section class="blog-head wrap">\n'
                '    <h1 class="script-h">POV Blog</h1>\n'
                f'    <p>{html.escape(CFG["blog_tagline"])}{page_label}</p>\n'
                '  </section>\n\n'
                + feed
                + subscribe_block("amp-block" if mask_forms else ""))

        # All three designs, the same way the post pages do it: one set of
        # cards inside one set of chrome per arm, restyled rather than copied.
        blog_top, blog_bottom = editorial_chrome(
            base, ' aria-current="page"')
        title = ("POV Blog | AQ Career Consulting" if page_number == 1 else
                 f"POV Blog — Page {page_number} | AQ Career Consulting")
        head_links = []
        if page_number > 1:
            head_links.append(
                f'<link rel="prev" href="{blog_pages[-1]}">')
        if page_number < page_count:
            head_links.append(
                f'<link rel="next" href="{SITE}/blog/page/{page_number + 1}/">')
        made.append(write(output, page(
            content=blog, title=title, desc=CFG["blog_tagline"],
            canonical=canonical, base=base, extra_head="\n".join(head_links),
            cur_blog=' aria-current="page"',
            html_attrs=' class="home-exp exp-pending" data-page="blog"',
            extra_css=FT_HEAD.format(base=base, v=FT_CSS_V) + "\n" +
            RZ_HEAD.format(base=base, v=RZ_CSS_V),
            chrome_top=blog_top,
            variant_layout=blog_bottom,
            # forms.js as well as likes.js: the memo signup at the foot of
            # each page needs it, or it posts by leaving the page. paging.js
            # only where there is a second page to reach, so a one-page
            # archive ships nothing it cannot use.
            extra_js=(
                f'<script src="{base}assets/js/forms.js?v={JS_V}"></script>\n'
                f'<script src="{base}assets/js/likes.js?v={LIKES_V}"></script>'
                + (f'\n<script src="{base}assets/js/paging.js?v={PAGING_V}">'
                   '</script>' if page_count > 1 else "")))))
        blog_pages.append(canonical)

    # ---------- posts ----------
    # Every post sits at the same depth, so one fill of the editorial chrome
    # serves all of them.
    post_chrome_top, post_chrome_bottom = \
        editorial_chrome("../../", ' aria-current="page"')
    for n, p in enumerate(posts):
        body = size_body_images(p["body"]) \
            .replace('src="/assets/', 'src="../../assets/')
        cover = cover_block(p["cover"])
        nxt = posts[n - 1] if n > 0 else None
        prv = posts[n + 1] if n + 1 < len(posts) else None
        links = ['<a href="../../blog/">&larr; All posts</a>']
        if prv:
            links.append(f'<a href="../{prv["slug"]}/">Older: '
                         f'{html.escape(prv["title"][:44])}&hellip;</a>')
        if nxt:
            links.append(f'<a href="../{nxt["slug"]}/">Newer: '
                         f'{html.escape(nxt["title"][:44])}&hellip;</a>')
        ld = json.dumps({
            "@context": "https://schema.org", "@type": "BlogPosting",
            "headline": p["title"], "datePublished": p["date"],
            "author": {"@type": "Person", "name": p["author"]},
            "image": (SITE + p["cover"]) if p["cover"] else None,
            "mainEntityOfPage": f'{SITE}/post/{p["slug"]}/',
        }, ensure_ascii=False)
        content = (
            '  <article>\n'
            '  <div class="post-head post">\n'
            f'    <div class="pmeta">{p["nice"]} &middot; {p["mins"]} min read</div>\n'
            f'    <h1>{html.escape(p["title"])}</h1>\n'
            f'    <div class="byline">by {html.escape(p["author"])}</div>\n'
            '  </div>\n' + cover +
            f'  <div class="post-body post">\n{body}  </div>\n'
            '  </article>\n'
            + LIKE_BAR +
            f'  <nav class="post-nav post">{"".join(links)}</nav>\n'
            f'  <script type="application/ld+json">{ld}</script>\n')
        # The post page carries every design, like the homepage — but with one
        # copy of the article inside a set of chrome per arm rather than whole
        # layouts, so a post's text isn't in the page three times. data-post
        # names the post for the like button and for post_viewed.
        made.append(write(f'post/{p["slug"]}/index.html', page(
            content=content, title=f'{p["title"]} | AQ Career Consulting',
            desc=p["excerpt"], canonical=f'{SITE}/post/{p["slug"]}/',
            base="../../", ogtype="article",
            ogimage=(SITE + p["cover"]) if p["cover"] else None,
            cur_blog=' aria-current="page"',
            html_attrs=(' class="home-exp exp-pending"'
                        f' data-page="post" data-post="{html.escape(p["slug"], quote=True)}"'),
            extra_css=FT_HEAD.format(base="../../", v=FT_CSS_V) + "\n" +
            RZ_HEAD.format(base="../../", v=RZ_CSS_V),
            chrome_top=post_chrome_top, variant_layout=post_chrome_bottom,
            extra_js=f'<script src="../../assets/js/likes.js?v={LIKES_V}"></script>')))

    # ---------- privacy ----------
    pv = CFG.get("privacy") or {}
    email = (pv.get("contact_email") or "").strip()
    if email:
        contact_sentence = (f'Email me at <a href="mailto:{html.escape(email)}">'
                            f'{html.escape(email)}</a>.')
    else:
        contact_sentence = ('Use the contact form at the bottom of the '
                            '<a href="../#connect">home page</a> and say what '
                            'you need.')
    try:
        nice_updated = dt.date.fromisoformat(pv["updated"]).strftime("%B %-d, %Y")
    except (KeyError, ValueError):
        nice_updated = pv.get("updated", "")
    privacy = fill(read(os.path.join(T, "privacy.html")),
                   privacy_updated=nice_updated,
                   privacy_contact_sentence=contact_sentence)
    made.append(write("privacy/index.html", page(
        content=privacy, title="Privacy | AQ Career Consulting",
        desc="What this website collects, why, and how to opt out.",
        canonical=f"{SITE}/privacy/", base="../")))

    # ---------- 404 ----------
    made.append(write("404.html", page(
        content=('  <section class="nf wrap">\n'
                 '    <h1 class="script-h">page not found</h1>\n'
                 '    <p>That link has moved or never existed.</p>\n'
                 '    <a class="btn-solid" href="/">Back to the home page</a>\n'
                 '  </section>\n'),
        title="Page not found | AQ Career Consulting",
        desc="Page not found.", canonical=SITE + "/404.html", base="/")))

    # ---------- feed + sitemap ----------
    def rfc822(iso):
        try:
            return dt.datetime.fromisoformat(iso).strftime(
                "%a, %d %b %Y 00:00:00 +0000")
        except ValueError:
            return ""

    items = "".join(
        f'<item><title><![CDATA[{p["title"]}]]></title>'
        f'<link>{SITE}/post/{p["slug"]}/</link>'
        f'<guid isPermaLink="true">{SITE}/post/{p["slug"]}/</guid>'
        f'<pubDate>{rfc822(p["date"])}</pubDate>'
        f'<dc:creator><![CDATA[{p["author"]}]]></dc:creator>'
        f'<description><![CDATA[{p["excerpt"]}]]></description></item>'
        for p in posts)
    made.append(write("feed.xml",
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f'<channel><title>AQ Career Consulting — POV Blog</title>'
        f'<link>{SITE}/blog/</link>'
        f'<description>{html.escape(CFG["blog_tagline"])}</description>'
        f'<language>en-us</language>{items}</channel></rss>\n'))

    urls = [(SITE + "/", "1.0")] + \
           [(url, "0.8" if n == 0 else "0.6")
            for n, url in enumerate(blog_pages)] + \
           [(SITE + "/privacy/", "0.3")] + \
           [(f'{SITE}/post/{p["slug"]}/', "0.6") for p in posts]
    made.append(write("sitemap.xml",
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + "".join(f"<url><loc>{u}</loc><priority>{pr}</priority></url>"
                  for u, pr in urls) + "</urlset>\n"))

    made.append(write("robots.txt",
        f"User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n"))

    print(f"built {len(made)} files  ({len(posts)} posts)")
    for m in made:
        print("  ", m)


if __name__ == "__main__":
    build()
