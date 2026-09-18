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


def page(*, content, title, desc, canonical, base, ogtype="website",
         ogimage=None, cur_home="", cur_blog="", extra_js="",
         html_attrs="", extra_css="", layout_open="", layout_close="",
         variant_layout=""):
    return fill(
        read(os.path.join(T, "base.html")),
        content=content, title=html.escape(title, quote=True),
        desc=html.escape(desc, quote=True), canonical=canonical, base=base,
        ogtype=ogtype, ogimage=ogimage or f"{SITE}/assets/img/headshot.jpg",
        cur_home=cur_home, cur_blog=cur_blog, year=YEAR, extra_js=extra_js,
        form_endpoint=html.escape(CFG.get("form_endpoint", ""), quote=True),
        css_v=CSS_V, analytics=analytics_snippet(base),
        html_attrs=html_attrs, extra_css=extra_css,
        layout_open=layout_open, layout_close=layout_close,
        variant_layout=variant_layout,
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


CAROUSEL_JS = """<script>
(function(){
  var root=document.querySelector('.testi'); if(!root) return;
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
})();
</script>"""


# Anything that has to be on every page has to be in BOTH, because the
# homepage experiment ships two complete layouts, each with its own header
# and footer. Adding a site-wide feature to one of them is a silent bug:
# whichever group a visitor lands in, they lose it.
SITE_WIDE = {
    "the tracking opt-out control": 'data-aq-consent="open"',
    "the script wordmark": '<span class="name">alina quintana</span>',
}


def check_chrome():
    """Fail the build rather than ship a layout missing a site-wide feature.

    base.html covers the control homepage and every other page;
    home-fresh-take.html is the variant's own chrome."""
    for tpl in ("base.html", "home-fresh-take.html"):
        src = read(os.path.join(T, tpl))
        for label, needle in SITE_WIDE.items():
            if needle not in src:
                raise SystemExit(
                    f"build aborted: templates/{tpl} is missing {label}.\n"
                    f"  expected to find: {needle}\n"
                    f"  Both homepage layouts need it — see docs/ANALYTICS.md.")


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
                form_endpoint=html.escape(CFG.get("form_endpoint", ""),
                                          quote=True),
                form_privacy_class="amp-block" if mask_forms else "")
    variant = fill(read(os.path.join(T, "home-fresh-take.html")), base="",
                   year=YEAR,
                   form_endpoint=html.escape(CFG.get("form_endpoint", ""),
                                             quote=True),
                   form_privacy_class="amp-block" if mask_forms else "")
    made.append(write("index.html", page(
        content=home,
        title="Home | AQ Career Consulting",
        desc=CFG["description"], canonical=SITE + "/", base="",
        cur_home=' aria-current="page"',
        html_attrs=' class="home-exp exp-pending"',
        extra_css=(
            '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..600&display=swap" rel="stylesheet">\n'
            f'<link rel="stylesheet" href="assets/css/fresh-take.css?v={FT_CSS_V}">'
        ),
        layout_open='<div id="layout-control">',
        layout_close='</div>',
        variant_layout=variant,
        extra_js=CAROUSEL_JS +
        f'\n<script src="assets/js/forms.js?v={JS_V}"></script>')))

    # ---------- blog index ----------
    cards = []
    for p in posts:
        thumb = (f'<div class="thumb"><img src="../{p["cover"].lstrip("/")}" '
                 f'alt="" loading="lazy"></div>') if p["cover"] else ""
        cards.append(
            f'      <a class="pcard" href="../post/{p["slug"]}/">\n'
            f'{("        " + thumb) if thumb else ""}\n'
            f'        <h2>{html.escape(p["title"])}</h2>\n'
            f'        <p class="excerpt">{html.escape(p["excerpt"])}</p>\n'
            f'        <div class="pmeta">{p["nice"]} &middot; {p["mins"]} min read</div>\n'
            f'      </a>')
    blog = ('  <section class="blog-head wrap">\n'
            '    <h1 class="script-h">POV Blog</h1>\n'
            f'    <p>{html.escape(CFG["blog_tagline"])}</p>\n'
            '  </section>\n\n'
            '  <div class="posts wrap">\n' + "\n".join(cards) + "\n  </div>\n")
    made.append(write("blog/index.html", page(
        content=blog, title="POV Blog | AQ Career Consulting",
        desc=CFG["blog_tagline"], canonical=f"{SITE}/blog/", base="../",
        cur_blog=' aria-current="page"')))

    # ---------- posts ----------
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
            f'  <nav class="post-nav post">{"".join(links)}</nav>\n'
            f'  <script type="application/ld+json">{ld}</script>\n')
        made.append(write(f'post/{p["slug"]}/index.html', page(
            content=content, title=f'{p["title"]} | AQ Career Consulting',
            desc=p["excerpt"], canonical=f'{SITE}/post/{p["slug"]}/',
            base="../../", ogtype="article",
            ogimage=(SITE + p["cover"]) if p["cover"] else None,
            cur_blog=' aria-current="page"')))

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
