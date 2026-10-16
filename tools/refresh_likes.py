#!/usr/bin/env python3
"""Refresh content/likes.json from Amplitude.

    AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... python3 tools/refresh_likes.py

Normally nobody runs this by hand — .github/workflows/refresh-likes.yml runs
it weekly and on pushes, rebuilds the site and deploys the result. See docs/ANALYTICS.md.

What it counts is defined by the saved chart in tools/likes-chart.json.
The script reads its overall values, never sums monthly unique-user buckets,
and clamps negative net values to zero. Edit the chart in Amplitude to change
the measurement; its saved date range and filters apply to every refresh.

Credentials come from the environment and nowhere else. The secret key grants
read access to the entire Amplitude project, and this repo is public: it
belongs in GitHub Actions secrets, never in a file here.

Options:
    --dry-run       show what would change, write nothing
    --from PATH     read a saved API response instead of calling Amplitude,
                    for checking the parsing without credentials
"""
import base64
import csv
from decimal import Decimal, InvalidOperation
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = os.path.join(ROOT, "content", "posts.json")
LIKES = os.path.join(ROOT, "content", "likes.json")

REGIONS = {"us": "https://amplitude.com", "eu": "https://analytics.eu.amplitude.com"}

CHART_CONFIG = os.path.join(ROOT, "tools", "likes-chart.json")


def chart_url(base):
    with open(CHART_CONFIG, encoding="utf-8") as f:
        chart_id = json.load(f)["chart_id"]
    if not isinstance(chart_id, str) or not chart_id.isalnum():
        fail("tools/likes-chart.json must contain an alphanumeric chart_id")
    return f"{base}/api/3/chart/{chart_id}/csv"


def fail(msg):
    raise SystemExit(f"refresh_likes: {msg}")


def slugs():
    with open(POSTS, encoding="utf-8") as f:
        return [p["slug"] for p in json.load(f)]


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
        # Amplitude says which parameter it objected to in the body, and a
        # bare status code sends whoever reads this guessing.
        try:
            body = err.read().decode("utf-8", "replace").strip()
        except OSError:
            body = ""
        fail(f"Amplitude returned {err.code} {err.reason}"
             + (f" — {hint}" if hint else "")
             + (f"\n  {body[:500]}" if body else ""))
    except urllib.error.URLError as err:
        fail(f"could not reach Amplitude — {err.reason}")


def label_slug(label):
    """The group label for an event-property group-by.

    Amplitude returns either the value on its own or a list of the grouped
    values; take the last, which is the property this asked to group by."""
    if isinstance(label, list):
        label = label[-1] if label else ""
    return str(label).strip()


def csv_chart_data(source):
    """Normalize Amplitude's JSON-wrapped CSV bar-chart export.

    Each event contributes a post column; only the column belonging to a
    formula's event is populated. The final column is the overall range.
    Reject time-series exports rather than accidentally summing uniques.
    """
    rows = [[cell.strip().lstrip("\ufeff") for cell in row]
            for row in csv.reader(io.StringIO(source))]
    header_index = next((i for i, row in enumerate(rows)
                         if row and row[0] == "Formula" and "post" in row[1:]), None)
    if header_index is None:
        fail("saved chart CSV has no Formula/post breakdown header")
    header = rows[header_index]
    post_columns = [i for i, name in enumerate(header) if name == "post"]
    value_columns = [i for i in range(1, len(header)) if i not in post_columns]
    if len(value_columns) != 1 or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}", header[value_columns[0]]):
        fail("saved chart CSV must contain one overall date-range column; use a bar chart")
    metadata, collapsed = [], []
    for row in rows[header_index + 1:]:
        if not row or not any(row):
            continue
        if len(row) != len(header):
            fail("saved chart CSV has a malformed data row")
        formula = re.fullmatch(r"Formula [A-Z]:\s*(.+)", row[0])
        if formula is None:
            fail("saved chart CSV has an unrecognized formula row")
        posts = {row[i] for i in post_columns if row[i]}
        if len(posts) != 1:
            fail("saved chart CSV must identify exactly one post per series")
        try:
            value = Decimal(row[value_columns[0]])
            if not value.is_finite() or value != value.to_integral_value():
                raise ValueError
        except (InvalidOperation, ValueError):
            fail("saved chart CSV has an invalid overall count")
        metadata.append({"segmentIndex": 0, "eventGroupBys": [posts.pop()],
                         "formula": formula.group(1)})
        collapsed.append([{"value": int(value)}])
    return {"seriesMeta": metadata, "seriesCollapsed": collapsed}


def counts_from(payload):
    """Read whole-range counts from the saved chart, never monthly sums.

    Component formulas retain posts with no matching unlike group. Prefer
    seriesMeta (the chart query format); legacy exports also carry formula
    names in seriesLabels. A single net-only export remains readable.
    """
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, str):
        data = csv_chart_data(data)
    if not isinstance(data, dict):
        # Log structure only: never include response values or credentials.
        shape = ({str(key): type(value).__name__ for key, value in payload.items()}
                 if isinstance(payload, dict) else type(payload).__name__)
        fail(f"saved chart returned no data object (response fields: {shape}); existing counts preserved")
    collapsed = data.get("seriesCollapsed")
    metadata = data.get("seriesMeta")
    labels = data.get("seriesLabels")
    if not isinstance(collapsed, list):
        fail("saved chart must return seriesCollapsed overall counts")
    use_meta = isinstance(metadata, list) and len(metadata) == len(collapsed)
    if not use_meta and (not isinstance(labels, list) or len(labels) != len(collapsed)):
        fail("saved chart must return matching labels or metadata for overall counts")
    buckets = {"net": {}, "liked": {}, "unliked": {}}
    for i, points in enumerate(collapsed):
        if use_meta:
            meta = metadata[i]
            if not isinstance(meta, dict) or meta.get("segmentIndex", 0) != 0:
                fail("saved chart must use one All Users segment")
            groups = meta.get("eventGroupBys") or [meta.get("eventGroupBy", "")]
            if len(groups) != 1:
                fail("saved chart must group each event by post only")
            slug = label_slug(groups)
            formula = meta.get("formula", "").replace(" ", "").upper()
        else:
            slug = label_slug(labels[i])
            label = str(labels[i]).replace(" ", "").upper()
            formula = next((f for f in ("UNIQUES(A)-UNIQUES(B)", "UNIQUES(A)", "UNIQUES(B)")
                            if f in label), "UNIQUES(A)-UNIQUES(B)")
        kind = {"UNIQUES(A)-UNIQUES(B)": "net", "UNIQUES(A)": "liked",
                "UNIQUES(B)": "unliked"}.get(formula)
        if kind is None:
            fail(f"unexpected saved chart formula {formula!r}")
        if not slug or slug == "(none)":
            continue
        if slug in buckets[kind]:
            fail(f"saved chart has duplicate {kind} series for {slug!r}")
        try:
            if len(points) != 1:
                fail("saved chart must return one overall value per series")
            value = points[0]["value"]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not float(value).is_integer():
                fail(f"saved chart returned a non-integer count for {slug!r}")
            buckets[kind][slug] = int(value)
        except (IndexError, KeyError, TypeError, ValueError, OverflowError):
            fail(f"saved chart returned an invalid overall count for {slug!r}")
    if buckets["liked"] or buckets["unliked"]:
        result = {slug: buckets["liked"].get(slug, 0) - buckets["unliked"].get(slug, 0)
                  for slug in buckets["liked"].keys() | buckets["unliked"].keys()}
        for slug, value in buckets["net"].items():
            if result.get(slug) != value:
                fail(f"saved chart net and component counts disagree for {slug!r}")
        return result
    return buckets["net"]


def net_likes(liked, unliked, known):
    """Likes minus unlikes, for the posts that actually exist.

    Never negative: unlikes can outnumber likes for a post whose likes
    predate a change to what's counted, and a negative like count on a page
    would be nonsense."""
    if (liked or unliked) and not (set(liked) | set(unliked)) & set(known):
        fail("saved chart has no recognized post slugs; existing counts preserved")
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
    if "--start" in argv or os.environ.get("AMPLITUDE_START", "").strip():
        fail("set the date range in the saved Amplitude chart; --start / AMPLITUDE_START are no longer used")
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

        url = chart_url(base)
        print(f"reading saved Amplitude chart: {url}")
        fresh = net_likes(counts_from(fetch(url, api_key, secret_key)), {}, known)

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


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
