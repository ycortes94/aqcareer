#!/usr/bin/env python3
"""Refresh the six Instagram tiles committed with the static site.

Requires a long-lived Instagram User access token for a professional account:

    INSTAGRAM_ACCESS_TOKEN=... python3 tools/refresh_instagram.py

The API's media URLs expire, so this script downloads every poster and reel
into assets/img/instagram/ before writing content/instagram.json. All work is
staged first; an API or download failure leaves the published grid untouched.
"""
import argparse
import io
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    raise SystemExit(
        "Pillow is required: python3 -m pip install Pillow"
    )


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img" / "instagram"
MANIFEST = ROOT / "content" / "instagram.json"
GRAPH = "https://graph.instagram.com"
VERSION = os.environ.get("INSTAGRAM_API_VERSION", "v26.0")
COUNT = 6
MAX_DOWNLOAD = 40 * 1024 * 1024
UA = "AQ Career Instagram Sync/1.0"


def api(path, token, params=None, host=GRAPH):
    query = urllib.parse.urlencode(params or {})
    url = f"{host}/{path.lstrip('/')}"
    if query:
        url += "?" + query
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "User-Agent": UA}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            data = json.load(res)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        raise RuntimeError(f"Instagram API returned HTTP {err.code}: {detail}")
    if "error" in data:
        raise RuntimeError(f"Instagram API error: {data['error']}")
    return data


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            length = int(res.headers.get("Content-Length") or 0)
            if length > MAX_DOWNLOAD:
                raise RuntimeError(f"media is too large ({length} bytes)")
            data = res.read(MAX_DOWNLOAD + 1)
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"media download returned HTTP {err.code}: {url}")
    if len(data) > MAX_DOWNLOAD:
        raise RuntimeError(f"media is too large (over {MAX_DOWNLOAD} bytes)")
    return data


def post_code(permalink, media_id):
    parts = urllib.parse.urlparse(permalink).path.rstrip("/").split("/")
    candidate = parts[-1] if parts else ""
    candidate = re.sub(r"[^A-Za-z0-9_-]", "", candidate)
    return candidate or str(media_id)


def alt_text(caption, timestamp):
    first = next(
        (line.strip() for line in (caption or "").splitlines() if line.strip()),
        "",
    )
    if not first:
        return f"Instagram post from {(timestamp or '')[:10]}"
    return first[:177].rstrip() + ("..." if len(first) > 177 else "")


def carousel_cover(item):
    children = (item.get("children") or {}).get("data") or []
    if not children:
        return None
    child = children[0]
    if child.get("media_type") == "VIDEO":
        return child.get("thumbnail_url")
    return child.get("media_url") or child.get("thumbnail_url")


def sources(item):
    """Return (poster URL, optional video URL) for an API media object."""
    kind = item.get("media_type")
    if kind == "VIDEO":
        return item.get("thumbnail_url"), item.get("media_url")
    if kind == "CAROUSEL_ALBUM":
        return carousel_cover(item), None
    return item.get("media_url") or item.get("thumbnail_url"), None


def save_square_jpeg(data, path):
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.width < 1 or image.height < 1:
                raise ValueError("image has no pixels")
            image = ImageOps.exif_transpose(image).convert("RGB")
            image = ImageOps.fit(
                image, (640, 640), method=Image.Resampling.LANCZOS
            )
            image.save(path, "JPEG", quality=84, optimize=True, progressive=True)
    except Exception as err:
        raise RuntimeError(f"download was not a usable image: {err}")


def save_video(data, path):
    # MP4 files carry an ftyp box near the start. This catches HTML error
    # pages and expired CDN responses before they reach the site.
    if len(data) < 32 or b"ftyp" not in data[:32]:
        raise RuntimeError("download was not a usable MP4")
    path.write_bytes(data)


def fetch_media(token):
    me = api(f"{VERSION}/me", token, {"fields": "user_id,username"})
    user_id = me.get("user_id") or me.get("id")
    if not user_id:
        raise RuntimeError("Instagram did not return a user_id")
    fields = (
        "id,caption,media_type,media_product_type,media_url,thumbnail_url,"
        "permalink,timestamp,children{media_type,media_url,thumbnail_url}"
    )
    result = api(
        f"{VERSION}/{user_id}/media",
        token,
        {"fields": fields, "limit": "12"},
    )
    return me.get("username"), result.get("data") or []


def refresh_token(token):
    # Meta accepts the bearer header for normal API reads, but this endpoint
    # requires access_token as a query argument.
    query = urllib.parse.urlencode(
        {"grant_type": "ig_refresh_token", "access_token": token}
    )
    req = urllib.request.Request(
        f"{GRAPH}/refresh_access_token?{query}", headers={"User-Agent": UA}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            result = json.load(res)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        raise RuntimeError(f"token refresh returned HTTP {err.code}: {detail}")
    refreshed = result.get("access_token")
    if not refreshed:
        raise RuntimeError(f"token refresh failed: {result}")
    if refreshed != token:
        print(
            "::warning::Meta returned a different refreshed token. Update the "
            "INSTAGRAM_ACCESS_TOKEN repository secret before the old token "
            "expires.",
            file=sys.stderr,
        )
    return refreshed


def stage(items, directory):
    manifest = []
    for item in items:
        if len(manifest) == COUNT:
            break
        permalink = item.get("permalink")
        poster_url, video_url = sources(item)
        if not permalink or not poster_url:
            print(f"  skipping {item.get('id')}: no permalink or poster")
            continue

        code = post_code(permalink, item.get("id"))
        poster_name = f"{code}.jpg"
        print(f"  {len(manifest) + 1}. {code}: poster")
        save_square_jpeg(download(poster_url), directory / poster_name)

        video_path = False
        if item.get("media_type") == "VIDEO" and video_url:
            video_name = f"{code}.mp4"
            print(f"     {code}: reel")
            try:
                save_video(download(video_url), directory / video_name)
                video_path = f"/assets/img/instagram/{video_name}"
            except RuntimeError as err:
                # Meta can omit or block a reel download because of licensed
                # audio. Keep a working poster/link rather than dropping it.
                print(f"     warning: {err}; publishing its poster only")

        manifest.append(
            {
                "link": permalink,
                "image": f"/assets/img/instagram/{poster_name}",
                "alt": alt_text(item.get("caption"), item.get("timestamp")),
                "video": video_path,
            }
        )

    if len(manifest) < COUNT:
        raise RuntimeError(
            f"only {len(manifest)} usable posts were returned; keeping the "
            f"existing {COUNT}-post grid"
        )
    return manifest


def publish(staged, manifest):
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.iterdir():
        if old.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".mp4"}:
            old.unlink()
    for media in staged.iterdir():
        shutil.move(str(media), OUT / media.name)
    temporary = MANIFEST.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(MANIFEST)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--refresh-token",
        action="store_true",
        help="refresh the long-lived token before reading media",
    )
    args = parser.parse_args()
    token = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "").strip()
    if not token:
        raise SystemExit("INSTAGRAM_ACCESS_TOKEN is not set")
    try:
        if args.refresh_token:
            try:
                token = refresh_token(token)
            except RuntimeError as err:
                # A token generated less than 24 hours ago cannot be
                # refreshed yet, but it can already read media. Continue so
                # the first manual workflow run can still populate the grid.
                print(f"::warning::Could not refresh the token: {err}")
        username, items = fetch_media(token)
        print(f"Instagram @{username or 'account'} returned {len(items)} posts")
        with tempfile.TemporaryDirectory(prefix="aq-instagram-") as tmp:
            staged = Path(tmp)
            manifest = stage(items, staged)
            publish(staged, manifest)
    except (RuntimeError, OSError, ValueError) as err:
        raise SystemExit(f"Instagram refresh failed: {err}")
    print(f"published {len(manifest)} posts -> {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
