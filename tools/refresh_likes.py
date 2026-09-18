#!/usr/bin/env python3
"""Refresh content/likes.json from Amplitude.

    AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... python3 tools/refresh_likes.py

Normally nobody runs this by hand — .github/workflows/refresh-likes.yml runs
it weekly, rebuilds the site and commits the result. See docs/ANALYTICS.md.

What it counts: unique users who fired `post_liked` for each post, minus the
unique users who fired `post_unliked`, over the whole period. Uniques rather
than event totals, so one person pressing the button twice is one like. The
figure can only ever be a floor — a visitor who declined measurement still
gets their like, it just never reaches Amplitude to be counted.

Credentials come from the environment and nowhere else. The secret key grants
read access to the entire Amplitude project, and this repo is public: it
belongs in GitHub Actions secrets, never in a file here.

Options:
    --dry-run       show what would change, write nothing
    --start YYYYMMDD    override the first day counted
    --from PATH     read a saved API response instead of calling Amplitude,
                    for checking the parsing without credentials
"""
import base64
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = os.path.join(ROOT, "content", "posts.json")
LIKES = os.path.join(ROOT, "content", "likes.json")

REGIONS = {"us": "https://amplitude.com", "eu": "https://analytics.eu.amplitude.com"}

LIKED = "post_liked"
UNLIKED = "post_unliked"
PROPERTY = "post"      # the event property carrying the slug


def fail(msg):
    raise SystemExit(f"refresh_likes: {msg}")


def slugs():
    with open(POSTS, encoding="utf-8") as f:
        return [p["slug"] for p in json.load(f)]


def query_url(event, start, end, base):
    """A segmentation query for one event, grouped by the post property."""
    spec = {"event_type": event,
            "group_by": [{"type": "event", "value": PROPERTY}]}
    params = {
        "e": json.dumps(spec, separators=(",", ":")),
        "start": start,
        "end": end,
        "m": "uniques",
        # Monthly buckets: the daily interval is capped at 365 days of data,
        # and the number this reads — seriesCollapsed — covers the whole range
        # either way.
        "i": 30,
        "limit": 1000,
    }
    return f"{base}/api/2/events/segmentation?" + urllib.parse.urlencode(params)


def fetch(url, api_key, secret_key):
    token = base64.b64encode(f"{api_key}:{secret_key}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        hint = {
            401: "the API key or secret key was rejected",
            403: "those keys don't have access to this project",
            429: "Amplitude is rate limiting — try again later",
        }.get(err.code, "")
        fail(f"Amplitude returned {err.code} {err.reason}"
             + (f" — {hint}" if hint else ""))
    except urllib.error.URLError as err:
        fail(f"could not reach Amplitude — {err.reason}")


def label_slug(label):
    """The group label for an event-property group-by.

    Amplitude returns either the value on its own or a list of the grouped
    values; take the last, which is the property this asked to group by."""
    if isinstance(label, list):
        label = label[-1] if label else ""
    return str(label).strip()


def counts_from(payload):
    """{slug: uniques} out of one segmentation response.

    seriesCollapsed holds one figure per group for the whole range, which is
    the number wanted here — summing the per-interval series would count a
    visitor once per month they happened to be active."""
    data = (payload or {}).get("data") or {}
    labels = data.get("seriesLabels") or []
    collapsed = data.get("seriesCollapsed") or []
    out = {}
    for i, label in enumerate(labels):
        slug = label_slug(label)
        # Events logged before the property existed, or from a page that
        # didn't set it, come back grouped under "(none)".
        if not slug or slug == "(none)":
            continue
        try:
            out[slug] = int(collapsed[i][0]["value"])
        except (IndexError, KeyError, TypeError, ValueError):
            continue
    return out


def net_likes(liked, unliked, known):
    """Likes minus unlikes, for the posts that actually exist.

    Never negative: unlikes can outnumber likes for a post whose likes
    predate a change to what's counted, and a negative like count on a page
    would be nonsense."""
    out = {}
    for slug in known:
        n = liked.get(slug, 0) - unliked.get(slug, 0)
        out[slug] = max(0, n)
    for slug in set(liked) | set(unliked):
        if slug not in known:
            print(f"  note: Amplitude has likes for \"{slug}\", which is not a "
                  f"post here — ignored")
    return out


def read_current():
    try:
        with open(LIKES, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def main(argv):
    dry_run = "--dry-run" in argv
    known = slugs()

    if "--from" in argv:
        path = argv[argv.index("--from") + 1]
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        fresh = net_likes(counts_from(payload), {}, known)
    else:
        api_key = os.environ.get("AMPLITUDE_API_KEY", "").strip()
        secret_key = os.environ.get("AMPLITUDE_SECRET_KEY", "").strip()
        if not api_key or not secret_key:
            fail("set AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY in the "
                 "environment (see docs/ANALYTICS.md)")

        region = os.environ.get("AMPLITUDE_REGION", "us").strip().lower()
        if region not in REGIONS:
            fail(f"AMPLITUDE_REGION should be us or eu, not {region!r}")
        base = REGIONS[region]

        end = dt.date.today()
        start = os.environ.get("AMPLITUDE_START", "").strip()
        if "--start" in argv:
            start = argv[argv.index("--start") + 1]
        if not start:
            # The whole life of the blog. Nothing was logged before the first
            # post existed, so a wide range costs nothing but is never short.
            start = min(p for p in _dates()).strftime("%Y%m%d")
        try:
            dt.datetime.strptime(start, "%Y%m%d")
        except ValueError:
            fail(f"start date should be YYYYMMDD, not {start!r}")

        print(f"reading {LIKED} / {UNLIKED} from {start} to "
              f"{end.strftime('%Y%m%d')}")
        liked = counts_from(fetch(query_url(LIKED, start, end.strftime("%Y%m%d"),
                                            base), api_key, secret_key))
        unliked = counts_from(fetch(query_url(UNLIKED, start,
                                              end.strftime("%Y%m%d"), base),
                                    api_key, secret_key))
        fresh = net_likes(liked, unliked, known)

    current = read_current()
    changed = {s: (current.get(s), n) for s, n in fresh.items()
               if current.get(s) != n}
    if not changed:
        print(f"no change — {sum(fresh.values())} likes across "
              f"{len(fresh)} posts")
        return 0

    for slug, (was, now) in sorted(changed.items()):
        print(f"  {slug}: {was if was is not None else '—'} → {now}")

    if dry_run:
        print("--dry-run: content/likes.json not written")
        return 0

    with open(LIKES, "w", encoding="utf-8") as f:
        json.dump(fresh, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {LIKES} — now run tools/build.py")
    return 0


def _dates():
    with open(POSTS, encoding="utf-8") as f:
        for p in json.load(f):
            try:
                yield dt.date.fromisoformat(p["date"])
            except (ValueError, KeyError):
                continue


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
