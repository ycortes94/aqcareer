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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = os.path.join(ROOT, "templates")
C = os.path.join(ROOT, "content")

with open(os.path.join(ROOT, "site.json"), encoding="utf-8") as f:
    CFG = json.load(f)

SITE = CFG["url"].rstrip("/")
YEAR = dt.date.today().year


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
JS_V = asset_v("assets/js/forms.js")
AN_V = asset_v("assets/js/analytics.js")
LABS_V = asset_v("assets/js/labs.js")
LIKES_V = asset_v("assets/js/likes.js")

# Fraunces is the variant's heading face and is only fetched by pages that
# ship the fresh-take layout.
FT_HEAD = (
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,'
    'wght@0,9..144,300..700;1,9..144,300..600&display=swap" rel="stylesheet">\n'
    '<link rel="stylesheet" href="{base}assets/css/fresh-take.css?v={v}">'
)


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


def fresh_chrome(base, cur_blog=""):
    """The fresh-take header and footer, as a (header, footer) pair.

    One source for both layouts that use them: the variant homepage, where
    they sit inside #layout-fresh, and the post page, where each is wrapped
    in its own .ft block around the shared article."""
    def part(name):
        return fill(read(os.path.join(T, name)), base=base, year=YEAR,
                    cur_blog=cur_blog)
    return part("fresh-header.html"), part("fresh-footer.html")


def page(*, content, title, desc, canonical, base, ogtype="website",
         ogimage=None, cur_home="", cur_blog="", extra_js="",
         html_attrs="", extra_css="", layout_open="", layout_close="",
         variant_layout="", chrome_top=""):
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
        css_v=CSS_V, analytics=analytics_snippet(base),
        html_attrs=html_attrs, extra_css=extra_css,
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


# Anything that has to be on every page has to be in BOTH chromes: the
# control one in base.html and the fresh-take one in the partials. Adding a
# site-wide feature to one of them is a silent bug — whichever group a
# visitor lands in, they lose it.
SITE_WIDE = {
    "the tracking opt-out control": 'data-aq-consent="open"',
    "the script wordmark": '<span class="name">alina quintana</span>',
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
                form_privacy_class="amp-block" if mask_forms else "")
    ft_header, ft_footer = fresh_chrome(base="")
    variant = fill(read(os.path.join(T, "home-fresh-take.html")), base="",
                   year=YEAR,
                   fresh_header=ft_header, fresh_footer=ft_footer,
                   testimonials=testimonial_slides("card"),
                   form_endpoint=html.escape(CFG.get("form_endpoint", ""),
                                             quote=True),
                   form_privacy_class="amp-block" if mask_forms else "")
    made.append(write("index.html", page(
        content=home,
        title="Home | AQ Career Consulting",
        desc=CFG["description"], canonical=SITE + "/", base="",
        cur_home=' aria-current="page"',
        html_attrs=' class="home-exp exp-pending" data-page="home"',
        extra_css=FT_HEAD.format(base="", v=FT_CSS_V),
        layout_open='<div id="layout-control">',
        layout_close='</div>',
        variant_layout=variant,
        # No tag for labs.js on purpose: the inline gate in base.html injects
        # it, and only for a browser that has Labs switched on.
        extra_js=CAROUSEL_JS +
        f'\n<script src="assets/js/forms.js?v={JS_V}"></script>')))

    # ---------- blog index ----------
    counts = like_counts({p["slug"] for p in posts})
    cards = []
    for p in posts:
        thumb = (f'<div class="thumb"><img src="../{p["cover"].lstrip("/")}" '
                 f'alt="" loading="lazy"></div>') if p["cover"] else ""
        cards.append(
            f'      <a class="pcard" href="../post/{p["slug"]}/">\n'
            f'{("        " + thumb) if thumb else ""}\n'
            f'        <h2>{html.escape(p["title"])}</h2>\n'
            f'        <p class="excerpt">{html.escape(p["excerpt"])}</p>\n'
            f'        <div class="pmeta"><span>{p["nice"]} &middot; {p["mins"]} min read</span>'
            f'{like_count(p["slug"], counts)}</div>\n'
            f'      </a>')
    blog = ('  <section class="blog-head wrap">\n'
            '    <h1 class="script-h">POV Blog</h1>\n'
            f'    <p>{html.escape(CFG["blog_tagline"])}</p>\n'
            '  </section>\n\n'
            '  <div class="posts wrap">\n' + "\n".join(cards) + "\n  </div>\n")
    # Both designs, the same way the post pages do it: one set of cards
    # between two sets of chrome, restyled by CSS rather than duplicated.
    bh, bf = fresh_chrome(base="../", cur_blog=' aria-current="page"')
    made.append(write("blog/index.html", page(
        content=blog, title="POV Blog | AQ Career Consulting",
        desc=CFG["blog_tagline"], canonical=f"{SITE}/blog/", base="../",
        cur_blog=' aria-current="page"',
        html_attrs=' class="home-exp exp-pending" data-page="blog"',
        extra_css=FT_HEAD.format(base="../", v=FT_CSS_V),
        chrome_top=f'<div class="ft ft-chrome">\n{bh}\n</div>',
        variant_layout=f'<div class="ft ft-chrome">\n{bf}\n</div>',
        extra_js=f'<script src="../assets/js/likes.js?v={LIKES_V}"></script>')))

    # ---------- posts ----------
    # Every post sits at the same depth, so one fill of the fresh-take chrome
    # serves all of them.
    ph, pf = fresh_chrome(base="../../", cur_blog=' aria-current="page"')
    post_chrome_top = f'<div class="ft ft-chrome">\n{ph}\n</div>'
    post_chrome_bottom = f'<div class="ft ft-chrome">\n{pf}\n</div>'
    for n, p in enumerate(posts):
        body = p["body"].replace('src="/assets/', 'src="../../assets/')
        cover = (f'  <div class="post-cover wrap">'
                 f'<img src="../..{p["cover"]}" alt=""></div>\n'
                 if p["cover"] else "")
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
        # The post page carries both designs, like the homepage — but with one
        # copy of the article between two sets of chrome rather than two whole
        # layouts, so a post's text isn't in the page twice. data-post names
        # the post for the like button and for post_viewed.
        made.append(write(f'post/{p["slug"]}/index.html', page(
            content=content, title=f'{p["title"]} | AQ Career Consulting',
            desc=p["excerpt"], canonical=f'{SITE}/post/{p["slug"]}/',
            base="../../", ogtype="article",
            ogimage=(SITE + p["cover"]) if p["cover"] else None,
            cur_blog=' aria-current="page"',
            html_attrs=(' class="home-exp exp-pending"'
                        f' data-page="post" data-post="{html.escape(p["slug"], quote=True)}"'),
            extra_css=FT_HEAD.format(base="../../", v=FT_CSS_V),
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

    urls = [(SITE + "/", "1.0"), (SITE + "/blog/", "0.8"),
            (SITE + "/privacy/", "0.3")] + \
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
