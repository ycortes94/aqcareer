# Instagram grid

The homepage shows the same six Instagram posts in all three designs. Reels
play muted in their tiles, like the Wix gallery.

The site does **not** load media from Instagram's CDN in a visitor's browser.
Those URLs expire and are the usual cause of broken Instagram images. A daily
GitHub Action instead downloads the current files into
`assets/img/instagram/`, validates them, updates `content/instagram.json`, and
rebuilds the site. If any API call or download fails, the existing working grid
is left untouched.

## Connect the account

Instagram's supported API only provides a user's media for a professional
account. `@alinaquintana_career` must be an Instagram **Business** or
**Creator** account.

1. Create or open a Meta app at
   [developers.facebook.com/apps](https://developers.facebook.com/apps/).
2. Add **Instagram** and choose **API setup with Instagram business login**.
3. Connect `@alinaquintana_career` and grant
   `instagram_business_basic`.
4. In the app dashboard, choose **Generate token** for that account. Tokens
   generated there are long-lived (60 days).
5. In this GitHub repository, open **Settings → Secrets and variables →
   Actions → New repository secret**.
6. Name the secret `INSTAGRAM_ACCESS_TOKEN` and paste the token as its value.
   Never put the token in `site.json`, a committed file, an issue, a PR, or
   chat: this repository is public.
7. Open **Actions → Refresh Instagram grid → Run workflow**.

The scheduled workflow runs daily at 07:35 UTC. It calls Meta's token refresh
endpoint before reading the grid, extending a valid long-lived token for
another 60 days. Meta only refreshes a token that is at least 24 hours old. A
newer token therefore produces a warning on its first run, but the media still
updates; later runs refresh it normally. A revoked or already expired token
must be generated again and replaced in the GitHub secret.

The workflow is `.github/workflows/refresh-instagram.yml`; the API client is
`tools/refresh_instagram.py`.

## What gets published

- The latest six feed posts
- A validated, center-cropped 640×640 JPEG poster for every post
- An MP4 for a reel when Instagram supplies `media_url`
- A poster and Instagram link when Meta withholds the reel file because of
  licensed audio or download restrictions

Carousel posts use their first item as the grid cover. Clicking any tile opens
the original post on Instagram.

## Run it locally

Install Pillow, set a token in the shell, refresh, then build:

```bash
python3 -m pip install Pillow
INSTAGRAM_ACCESS_TOKEN="…" python3 tools/refresh_instagram.py
python3 tools/build.py
```

Do not save the token in the repository. `.env` files are ignored if a local
shell setup needs one.
