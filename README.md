# aqcareer.com

Static site for AQ Career Consulting, migrated off Wix.
No build dependencies beyond Python 3 — no Node, no npm, no framework.

Hosted on GitHub Pages. Pushing to `main` redeploys it, usually within a minute.

## Editing

| I want to… | Do this |
|---|---|
| Change home page text | Edit `templates/home.html`, then rebuild |
| Change a blog post | Edit `content/posts/<slug>.html`, then rebuild |
| Add a blog post | See below |
| Change colors, type, spacing | Edit `assets/css/site.css` — no rebuild needed |
| Change the fresh-take variant | Edit `assets/css/fresh-take.css`, or its templates, then rebuild — see [docs/ANALYTICS.md](docs/ANALYTICS.md) |
| Refresh the like counts on the blog | Nothing — a weekly GitHub Action does it, once its two Amplitude secrets are set. See [docs/ANALYTICS.md](docs/ANALYTICS.md#the-numbers-on-the-blog-index) |
| Change the header or footer | Edit `templates/base.html`, then rebuild |
| Change the site title/description | Edit `site.json`, then rebuild |
| Connect the forms | See [docs/FORMS.md](docs/FORMS.md) |
| Turn on analytics | See [docs/ANALYTICS.md](docs/ANALYTICS.md) |
| Edit the privacy page | Edit `templates/privacy.html`, bump `privacy.updated` in `site.json`, rebuild |

Rebuild with:

```bash
python3 tools/build.py
```

Then commit and push.

### Adding a blog post

**1.** Copy the template and rename it to the URL you want:

```bash
cp content/posts/_TEMPLATE.html content/posts/my-new-post.html
```

The filename becomes the URL — `my-new-post.html` publishes at
`/post/my-new-post/`. Use lowercase words separated by hyphens, and don't
rename a post after publishing or existing links to it break.

**2.** Write the post in that file. It holds only the body of the post —
no `<html>` or `<title>`; the build wraps it in the page. The template
demonstrates every element the styling supports: paragraphs, headings,
bulleted and numbered lists, bold and italics, links, images with captions,
and pull quotes. It's written to match how the existing posts are marked up.

**3.** Put any images in `assets/img/blog/` and reference them starting with
`/assets/` — the build rewrites the path per page. Resize anything wider
than about 1600px first; phone photos are often 4000px and several MB.

**4.** Add an entry at the **top** of `content/posts.json` (newest first):

```json
{
  "slug": "my-new-post",
  "title": "My New Post",
  "date": "2026-10-01",
  "author": "Alina Quintana",
  "cover": "/assets/img/blog/my-new-post-cover.jpg"
}
```

`slug` must match the filename. `date` is `YYYY-MM-DD` and controls ordering.
`cover` is the thumbnail on the blog index — set it to `null` for no image.
Reading time is calculated from the post itself, so there's nothing to keep
in sync.

**5.** Rebuild. The post page, the blog index, `feed.xml` and `sitemap.xml`
all update together.

## Layout

```
index.html              generated — home page
blog/index.html         generated — post list
privacy/index.html      generated — privacy page
post/<slug>/index.html  generated — one per post
404.html feed.xml sitemap.xml robots.txt   generated

templates/base.html     shared shell: head, header, footer
templates/home.html     home page content
templates/home-fresh-take.html   the fresh-take homepage (experiment variant)
templates/fresh-header.html      fresh-take header, shared by the variant
templates/fresh-footer.html      fresh-take footer, shared by the variant
templates/privacy.html  privacy page content
content/posts.json      post metadata, newest first
content/likes.json      like counts shown on the blog index (generated)
content/posts/*.html    post bodies (source of truth)
content/posts/_TEMPLATE.html   starting point for a new post
assets/css/site.css     all styles
assets/css/fresh-take.css        styles for the fresh-take variant
assets/js/forms.js      form submission
assets/js/likes.js      the like button on fresh-take post pages
assets/js/analytics.js  Amplitude + Statsig loader
assets/img/             images
assets/img/blog/        post images
assets/img/logo-originals/   untrimmed partner logos, kept for re-cropping
tools/build.py          the build
tools/refresh_likes.py  pulls like counts from Amplitude into content/likes.json
.github/workflows/refresh-likes.yml   runs that weekly and commits the result
tools/form-endpoint.gs  the form handler (paste into Google Apps Script)
tools/extract_wix.py    one-time Wix migration; kept for reference
docs/FORMS.md           how to connect the forms
docs/ANALYTICS.md       how to turn on analytics
design/                 original design mockups, not part of the site
```

Generated files are committed on purpose — GitHub Pages serves this repo
directly, so the built HTML has to be in it.

## Known gaps

- **Forms need connecting** before launch, or inquiries are lost silently.
  Ten minutes of setup: [docs/FORMS.md](docs/FORMS.md). Until then they show
  a message pointing visitors to LinkedIn instead of failing quietly.
- **Body font is a substitute.** The original uses Avenir LT, which Wix
  licenses and cannot be self-hosted. Mulish is used instead; the script
  (Mr De Haviland) and Lato are the originals.
- **Subscriber list is still in Wix.** Export Wix Contacts to CSV before
  cancelling the Wix subscription — that data can't be recovered afterward.
- Two of the three testimonials carry no name on the original Wix site
  either — they show industry and level only. Faithful, not an omission.
- One post title ends with a stray `"` carried over from Wix, in
  `content/posts.json`. Left as-is to stay faithful; safe to delete.
- **Analytics is live** (Amplitude + Statsig, Session Replay on). A privacy
  page exists at `/privacy/`; there is still **no consent banner**, which
  matters mainly for EU/UK visitors. See [docs/ANALYTICS.md](docs/ANALYTICS.md).
- The privacy page has **not been reviewed by a lawyer** — it describes what
  the code actually does, in plain language.
- Set this project's Session Replay mask level to `medium` or `conservative`
  in the Amplitude UI; the UI overrides the SDK and currently reads `light`.

## Domain

The domain is not pointed here yet — it still resolves to Wix, so the live
site is unaffected by anything in this repo.

When cutting over, in this order:

1. Set the custom domain in the repo's **Settings → Pages** (this writes a
   `CNAME` file) and wait for the certificate to issue.
2. Move DNS hosting off Wix to the registrar's own DNS.
3. **Copy the existing mail records across before switching**, or email to
   the domain stops. Check what's there now with `dig MX aqcareer.com` and
   reproduce it exactly at the new DNS host.
4. Keep the `/blog` and `/post/<slug>` paths unchanged — they're already
   indexed by search engines and linked from social profiles.
