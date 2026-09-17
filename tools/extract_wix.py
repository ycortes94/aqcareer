#!/usr/bin/env python3
"""One-time migration: pull blog posts out of the live Wix site into local
source files (content/posts/*.html + a JSON manifest) plus downloaded images.

Run once. After that, content/ is the source of truth and this can be deleted.
"""
import html, json, os, re, subprocess, sys, urllib.parse
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_POSTS = os.path.join(ROOT, "content", "posts")
OUT_IMG = os.path.join(ROOT, "assets", "img", "blog")
SITEMAP = "https://www.aqcareer.com/blog-posts-sitemap.xml"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36"}

# Tags we keep from the Wix markup. Everything else is unwrapped.
KEEP = {"p", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "strong", "b",
        "em", "i", "a", "img", "br", "figure", "figcaption"}
KEEP_ATTRS = {"a": {"href"}, "img": {"src", "alt"}}


def fetch(url, binary=False):
    # curl rather than urllib: this Python has no usable CA bundle.
    p = subprocess.run(
        ["curl", "-sSL", "--max-time", "90", "-A", UA["User-Agent"], url],
        capture_output=True, check=True)
    return p.stdout if binary else p.stdout.decode("utf-8", "replace")


class Extract(HTMLParser):
    """Capture the subtree of the first element carrying data-hook=<hook>."""

    def __init__(self, hook):
        super().__init__(convert_charrefs=True)
        self.hook = hook
        self.depth = None      # nesting depth inside the target
        self.done = False
        self.out = []
        self.void = {"img", "br"}

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.depth is None:
            if not self.done and a.get("data-hook") == self.hook:
                self.depth = 0
            return
        if tag not in self.void:
            self.depth += 1
        if tag in KEEP:
            allowed = KEEP_ATTRS.get(tag, set())
            kept = []
            for k, v in attrs:
                if k in allowed and v:
                    if tag == "img" and k == "src" and v.startswith("data:"):
                        return  # skip placeholder/lazy pixels
                    kept.append(f' {k}="{v}"')
            self.out.append(f"<{tag}{''.join(kept)}>")

    def handle_endtag(self, tag):
        if self.depth is None:
            return
        if tag in KEEP and tag not in self.void:
            self.out.append(f"</{tag}>")
        if tag not in self.void:
            self.depth -= 1
            if self.depth < 0:
                self.depth = None
                self.done = True

    def handle_data(self, data):
        if self.depth is not None:
            self.out.append(data)

    def html(self):
        return "".join(self.out)


def tidy(h):
    h = re.sub(r"<p>\s*</p>", "", h)
    h = re.sub(r"\s*\n\s*", " ", h)
    h = re.sub(r"[ \t]{2,}", " ", h)
    h = re.sub(r"(</(?:p|h2|h3|h4|ul|ol|li|blockquote|figure)>)", r"\1\n", h)
    return h.strip()


def wix_original(url):
    """Strip Wix's transform path so we download the original upload."""
    m = re.match(r"(https://static\.wixstatic\.com/media/[^/]+?)(?:/v1/.*)?$", url)
    return m.group(1) if m else url


def slugify(u):
    return u.rstrip("/").rsplit("/", 1)[-1]


def main():
    os.makedirs(OUT_POSTS, exist_ok=True)
    os.makedirs(OUT_IMG, exist_ok=True)

    urls = re.findall(r"<loc>([^<]+)</loc>", fetch(SITEMAP))
    print(f"{len(urls)} posts in sitemap\n")

    manifest, seen_img = [], {}

    for i, url in enumerate(urls, 1):
        slug = slugify(url)
        page = fetch(url)

        ld = {}
        m = re.search(r'<script type="application/ld\+json">(.*?)</script>', page, re.S)
        if m:
            try:
                ld = json.loads(m.group(1))
            except Exception:
                pass

        title = ld.get("headline") or ""
        if not title:
            t = Extract("post-title"); t.feed(page)
            title = re.sub(r"<[^>]+>", "", t.html()).strip()
        # Wix stores some headlines HTML-encoded inside the JSON-LD; decode
        # them here so the build escapes exactly once.
        title = html.unescape(title).strip()

        body_x = Extract("post-description"); body_x.feed(page)
        body = tidy(body_x.html())

        # Rewrite remote images to local copies
        for src in set(re.findall(r'<img[^>]+src="([^"]+)"', body)):
            if "wixstatic" not in src:
                continue
            orig = wix_original(src)
            if orig not in seen_img:
                name = urllib.parse.unquote(orig.rsplit("/", 1)[-1])
                name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
                if "." not in name:
                    name += ".jpg"
                name = f"{slug[:40]}-{len(seen_img)}-{name}"[:110]
                try:
                    with open(os.path.join(OUT_IMG, name), "wb") as f:
                        f.write(fetch(orig, binary=True))
                    seen_img[orig] = name
                except Exception as e:
                    print(f"   ! image failed {orig}: {e}")
                    seen_img[orig] = None
            local = seen_img[orig]
            if local:
                body = body.replace(src, f"/assets/img/blog/{local}")

        cover = ld.get("image")
        if isinstance(cover, dict):
            cover = cover.get("url")
        if isinstance(cover, list):
            cover = cover[0] if cover else None
        cover_local = None
        if cover and "wixstatic" in cover:
            orig = wix_original(cover)
            if orig not in seen_img:
                name = f"{slug[:40]}-cover.jpg"
                try:
                    with open(os.path.join(OUT_IMG, name), "wb") as f:
                        f.write(fetch(orig, binary=True))
                    seen_img[orig] = name
                except Exception as e:
                    print(f"   ! cover failed: {e}")
                    seen_img[orig] = None
            cover_local = seen_img[orig]

        with open(os.path.join(OUT_POSTS, slug + ".html"), "w", encoding="utf-8") as f:
            f.write(body + "\n")

        rec = {
            "slug": slug,
            "title": title,
            "date": (ld.get("datePublished") or "")[:10],
            "author": (ld.get("author") or {}).get("name", "Alina Quintana"),
            "cover": f"/assets/img/blog/{cover_local}" if cover_local else None,
            "words": len(re.sub(r"<[^>]+>", " ", body).split()),
        }
        manifest.append(rec)
        print(f"{i:2d}. {rec['date']}  {rec['words']:5d}w  {title[:62]}")

    manifest.sort(key=lambda r: r["date"], reverse=True)
    with open(os.path.join(ROOT, "content", "posts.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)

    imgs = [v for v in seen_img.values() if v]
    print(f"\n{len(manifest)} posts, {len(imgs)} images -> content/ + assets/img/blog/")


if __name__ == "__main__":
    sys.exit(main())
