# aqcareer.com

Static site for AQ Career Consulting, migrated off Wix.
No build dependencies beyond Python 3 — no Node, no npm, no framework.

Hosted on GitHub Pages at
[ycortes94.github.io/aqcareer](https://ycortes94.github.io/aqcareer/).
Pushing to `main` redeploys it, usually within a minute. The custom domain
is not pointed here yet — see [Domain](#domain).

The homepage ships three designs. Statsig assigns consenting visitors to
`control`, `fresh_take`, or `raices` via the `homepage_three_designs`
experiment. Visitors who decline measurement always see control. Preview
any arm with Labs — see [docs/ANALYTICS.md](docs/ANALYTICS.md#statsig-labs-switching-layouts-by-hand).

## Editing

| I want to… | Do this |
|---|---|
| Change home page text | Edit `templates/home.html` (control), `templates/home-fresh-take.html`, and/or `templates/home-raices.html`, then rebuild |
| Change testimonials | Edit `content/testimonials.json`, then rebuild |
| Change a blog post | Edit `content/posts/<slug>.html`, then rebuild |
| Add a blog post | See below |
| Change colors, type, spacing | Edit `assets/css/site.css`, then rebuild so the cache-busting `?v=` updates |
| Change the fresh-take variant | Edit `assets/css/fresh-take.css` or its templates, then rebuild — see [docs/ANALYTICS.md](docs/ANALYTICS.md) |
| Change the Raíces variant | Edit `assets/css/raices.css` or `templates/home-raices.html`, then rebuild |
| Preview a layout without waiting to be bucketed | `?labs=1` or `?design=control` / `fresh_take` / `raices` — see [docs/ANALYTICS.md](docs/ANALYTICS.md#statsig-labs-switching-layouts-by-hand) |
| Refresh the like counts on the blog | Nothing — a weekly GitHub Action does it, once its two Amplitude secrets are set. See [docs/ANALYTICS.md](docs/ANALYTICS.md#the-numbers-on-the-blog-index) |
| Change the control header or footer | Edit `templates/base.html`, then rebuild |
| Change the editorial header or footer | Edit `templates/fresh-header.html` / `templates/fresh-footer.html` (shared by fresh-take and Raíces), then rebuild. Site-wide controls must exist in **both** chromes |
| Change the site title/description | Edit `site.json`, then rebuild |
| Change where forms send | See [docs/FORMS.md](docs/FORMS.md). The endpoint and Turnstile site key live in `site.json` |
| Turn analytics on or off | See [docs/ANALYTICS.md](docs/ANALYTICS.md) |
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

**5.** Rebuild. The post page, the paginated blog index, `feed.xml` and
`sitemap.xml` all update together. The index shows six posts per page;
further pages live at `/blog/page/2/` and so on. Clicking a page number
swaps the cards in place (`assets/js/paging.js`) rather than reloading.

## Layout

```
index.html              generated — home page (all three designs in one file)
blog/index.html         generated — post list, page 1
blog/page/<n>/index.html  generated — later pages of the archive
privacy/index.html      generated — privacy page
post/<slug>/index.html  generated — one per post
404.html feed.xml sitemap.xml robots.txt   generated

templates/base.html     shared shell: head, control header/footer
templates/home.html     control homepage content
templates/home-fresh-take.html   fresh-take homepage
templates/home-raices.html       Raíces homepage
templates/fresh-header.html      editorial header (fresh-take and Raíces)
templates/fresh-footer.html      editorial footer (fresh-take and Raíces)
templates/privacy.html  privacy page content
content/posts.json      post metadata, newest first
content/likes.json      like counts shown on the blog index (generated)
content/testimonials.json   quotes on the homepages
content/posts/*.html    post bodies (source of truth)
content/posts/_TEMPLATE.html   starting point for a new post
site.json               URL, form endpoint, Turnstile site key, analytics keys
assets/css/site.css     shared styles
assets/css/fresh-take.css        fresh-take variant
assets/css/raices.css            Raíces variant
assets/js/forms.js      form submission + Turnstile
assets/js/waitlist.js   2027 counseling interest dialog
assets/js/paging.js     in-place blog pagination
assets/js/likes.js      like button on non-control post pages
assets/js/labs.js       Statsig Labs panel (injected only when Labs is on)
assets/js/analytics.js  Amplitude + Statsig loader, consent banner
assets/img/             images
assets/img/blog/        post images
assets/img/logo-originals/   untrimmed partner logos, kept for re-cropping
tools/build.py          the build
tools/refresh_likes.py  pulls like counts from Amplitude into content/likes.json
.github/workflows/refresh-likes.yml   runs that weekly and commits the result
tools/form-endpoint.gs  the form handler (paste into Google Apps Script)
tools/recolor_headshot.py   one-off: recolour the hero portrait backdrop
tools/extract_wix.py    one-time Wix migration; kept for reference
docs/FORMS.md           how the forms are connected, and how to change them
docs/ANALYTICS.md       analytics, consent, experiment, likes, Labs
design/                 original design mockups, not part of the site
```

Generated files are committed on purpose — GitHub Pages serves this repo
directly, so the built HTML has to be in it.

## Known gaps

- **Subscriber list is still in Wix.** Export Wix Contacts to CSV before
  cancelling the Wix subscription — that data can't be recovered afterward.
- Two of the three testimonials carry no name on the original Wix site
  either — they show industry and level only. Faithful, not an omission.
- One post title ends with a stray `"` carried over from Wix, in
  `content/posts.json`. Left as-is to stay faithful; safe to delete.
- **Analytics is live** (Amplitude + Statsig, Session Replay on) behind a
  **consent banner**. A privacy page exists at `/privacy/`; a Tracking
  choice control in the footer lets visitors change their answer. See
  [docs/ANALYTICS.md](docs/ANALYTICS.md).
- The privacy page has **not been reviewed by a lawyer** — it describes what
  the code actually does, in plain language. `privacy.contact_email` in
  `site.json` is still empty.
- Forms **are connected** (Google Apps Script + Cloudflare Turnstile). If
  `form_endpoint` is ever cleared, they fall back to a LinkedIn message
  instead of failing quietly. See [docs/FORMS.md](docs/FORMS.md).
- Session Replay's project mask level is **`medium`** as of 2026-09-18.
  Forms are also marked `amp-block` in the markup so a remote config change
  cannot unmask them. Re-check the Amplitude UI if that setting is moved.

## Domain

The domain is not pointed here yet — it still resolves to Wix, so the live
site is unaffected by anything in this repo. The GitHub Pages preview is
[ycortes94.github.io/aqcareer](https://ycortes94.github.io/aqcareer/).

When cutting over, in this order:

1. Set the custom domain in the repo's **Settings → Pages** (this writes a
   `CNAME` file) and wait for the certificate to issue.
2. Move DNS hosting off Wix to the registrar's own DNS.
3. **Copy the existing mail records across before switching**, or email to
   the domain stops. Check what's there now with `dig MX aqcareer.com` and
   reproduce it exactly at the new DNS host.
4. Keep the `/blog` and `/post/<slug>` paths unchanged — they're already
   indexed by search engines and linked from social profiles.
   `/blog/page/<n>/` is new; it does not replace those URLs.
