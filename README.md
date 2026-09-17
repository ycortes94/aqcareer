# aqcareer.com

Static site for AQ Career Consulting (Alina Quintana), migrated off Wix.
No build dependencies beyond Python 3 — no Node, no npm, no framework.

## Editing

| I want to… | Do this |
|---|---|
| Change home page text | Edit `templates/home.html`, then rebuild |
| Change a blog post | Edit `content/posts/<slug>.html`, then rebuild |
| Add a blog post | See below |
| Change colors, type, spacing | Edit `assets/css/site.css` — no rebuild needed |
| Change the header or footer | Edit `templates/base.html`, then rebuild |
| Change the site title/description | Edit `site.json`, then rebuild |

Rebuild with:

```bash
python3 tools/build.py
```

Then commit and push. GitHub Pages redeploys automatically, usually within a minute.

### Adding a blog post

1. Create `content/posts/my-new-post.html` containing just the body — plain
   `<p>`, `<h2>`, `<ul>`, `<blockquote>`, `<figure><img>`. No `<html>` or `<head>`.
2. Put any images in `assets/img/blog/` and reference them as
   `/assets/img/blog/name.jpg` (the build rewrites the path).
3. Add an entry at the top of `content/posts.json`:

```json
{
  "slug": "my-new-post",
  "title": "My New Post",
  "date": "2026-10-01",
  "author": "Alina Quintana",
  "cover": "/assets/img/blog/my-new-post-cover.jpg",
  "words": 600
}
```

4. Run the build. The post, the blog index, `feed.xml`, and `sitemap.xml` all update.

## Layout

```
index.html              generated — home page
blog/index.html         generated — post list
post/<slug>/index.html  generated — one per post
404.html feed.xml sitemap.xml robots.txt   generated

templates/base.html     shared shell: head, header, footer
templates/home.html     home page content
content/posts.json      post metadata, newest first
content/posts/*.html    post bodies (source of truth)
assets/css/site.css     all styles
assets/img/             images (originals pulled from Wix)
assets/img/blog/        post images
tools/build.py          the build
tools/extract_wix.py    one-time Wix migration; kept for reference
design/                 original design mockups, not part of the site
```

Generated files are committed on purpose — GitHub Pages serves this repo
directly, so the built HTML has to be in it.

## Known gaps

- **Forms are not wired up.** Both the newsletter signup and the contact form
  post to `#` (they do nothing). Set `newsletter_action` and `contact_action`
  in `site.json` once a form handler is chosen.
- **Testimonial #3 is missing.** The live Wix carousel had three; only two
  could be recovered. The second has no attributed name and is labelled
  "CLIENT STORY" — both need filling in from the Wix editor.
- **Body font is a substitute.** The original uses Avenir LT, which Wix
  licenses and cannot be self-hosted. Mulish is used instead; the script
  (Mr De Haviland) and Lato are the originals.
- **Subscriber list still lives in Wix.** Export Wix Contacts to CSV before
  cancelling the Wix subscription — that data is not recoverable afterward.

## Domain

Not yet pointed here. The domain is registered at GoDaddy with DNS currently
hosted at Wix (`ns10/ns11.wixdns.net`). When switching:

- Mail is Microsoft 365 — **carry the MX record over first**
  (`aqcareer-com.mail.protection.outlook.com`, priority 0) or email breaks.
- Keep `/blog` and `/post/<slug>` paths as they are; they are already indexed.
