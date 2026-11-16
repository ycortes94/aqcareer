#!/usr/bin/env python3
"""Import approved Google Docs; archive them only after a successful deployment.

Published snapshots live on a data-only Git branch. No draft content, Google
credentials, temporary image URLs or document instructions are stored there.
"""
import argparse
import datetime as dt
import hashlib
import html
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STORE = Path("content/drive-posts")
IMAGES = Path("assets/img/blog/drive")
ID = re.compile(r"[A-Za-z0-9_-]{10,200}\Z")
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
PLACEHOLDER = re.compile(r"\[(?:Your |Write |Paste |First section|Practical tips|Optional second|Closing thought|Add another|End with|YYYY-MM-DD)[^\]]*\]", re.I)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def plain(paragraph):
    return "".join(e.get("textRun", {}).get("content", "")
                   for e in paragraph.get("elements", [])).strip()


def slugify(title):
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")[:100].rstrip("-")


def parse_document(document, previous=None):
    tabs = document.get("tabs", [])
    if len(tabs) != 1 or tabs[0].get("childTabs"):
        raise ValueError("Use exactly one document tab.")
    tab = tabs[0]["documentTab"]
    elements = tab.get("body", {}).get("content", [])
    markers = {label: [i for i, e in enumerate(elements)
                       if plain(e.get("paragraph", {})) == label]
               for label in ("POST START", "POST END")}
    if any(len(v) != 1 for v in markers.values()):
        raise ValueError("Keep exactly one POST START and one POST END paragraph.")
    start, end = markers["POST START"][0], markers["POST END"][0]
    if start >= end:
        raise ValueError("POST END must follow POST START.")
    fields = {}
    for element in elements[:start]:
        match = re.fullmatch(r"(Title|Author|Date|Slug):\s*(.*)", plain(element.get("paragraph", {})))
        if match:
            key, value = match.groups()
            if key.lower() in fields:
                raise ValueError(f"Duplicate {key} field.")
            fields[key.lower()] = value
    for key in ("title", "author", "date"):
        if not fields.get(key) or "[" in fields[key] or "]" in fields[key]:
            raise ValueError(f"Fill in the {key.title()} field.")
    if len(fields["title"]) > 250 or len(fields["author"]) > 150:
        raise ValueError("Title or author is too long.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fields["date"]):
        raise ValueError("Date must use YYYY-MM-DD.")
    dt.date.fromisoformat(fields["date"])
    slug = fields.get("slug") or (previous or {}).get("slug") or slugify(fields["title"])
    if not SLUG.fullmatch(slug) or len(slug) > 100:
        raise ValueError("Slug must contain lowercase words separated by hyphens (max 100 characters).")
    if previous and previous["slug"] != slug:
        raise ValueError("An existing article's slug cannot change; leave Slug blank to keep its URL.")
    body = elements[start + 1:end]
    if len(json.dumps(body)) > 2_000_000:
        raise ValueError("The article is too large; split it into separate posts.")
    if not any(plain(e.get("paragraph", {})) for e in body):
        raise ValueError("Write the article between POST START and POST END.")
    if PLACEHOLDER.search("\n".join(plain(e.get("paragraph", {})) for e in body)):
        raise ValueError("Replace or remove the sample placeholders before publishing.")
    # Suggestions must be resolved explicitly; do not silently accept them.
    if re.search(r'"suggested(?:InsertionIds|DeletionIds|TextStyleChanges|ParagraphStyleChanges)"', json.dumps(body)):
        raise ValueError("Accept or reject suggested edits before publishing.")
    return {k: fields[k] for k in ("title", "author", "date")} | {"slug": slug}, body, tab


def safe_link(value):
    parsed = urlparse(value)
    if parsed.scheme not in ("https", "http", "mailto"):
        raise ValueError("Use http, https or mailto links in the article.")
    if parsed.scheme != "mailto" and (not parsed.hostname or parsed.username or parsed.password):
        raise ValueError("Invalid link in the article.")
    return html.escape(value, quote=True)


def render_body(elements, tab, image_loader):
    """Generate only our HTML allowlist; never publish Google export markup."""
    out, lists, cover = [], [], ""
    last_list_id = None

    def close_lists(depth=0):
        while len(lists) > depth:
            out.append("</li></" + lists.pop() + ">")

    for element in elements:
        if "paragraph" not in element:
            raise ValueError("Tables and other embedded blocks are not supported; use paragraphs and inline images.")
        p = element["paragraph"]
        if p.get("positionedObjectIds"):
            raise ValueError("Set images to 'In line with text' before publishing.")
        runs = []
        for e in p.get("elements", []):
            if "textRun" in e:
                run = e["textRun"]
                value = html.escape(run.get("content", "").rstrip("\n"))
                style = run.get("textStyle", {})
                for key, tag in (("bold", "strong"), ("italic", "em"), ("strikethrough", "s")):
                    if style.get(key) and value:
                        value = f"<{tag}>{value}</{tag}>"
                if style.get("link"):
                    url = style["link"].get("url")
                    if not url:
                        raise ValueError("Replace document-internal links with website links.")
                    value = f'<a href="{safe_link(url)}">{value}</a>'
                runs.append(value.replace("\n", "<br>"))
            elif "inlineObjectElement" in e:
                key = e["inlineObjectElement"]["inlineObjectId"]
                obj = tab.get("inlineObjects", {}).get(key, {}).get("inlineObjectProperties", {}).get("embeddedObject", {})
                uri = obj.get("imageProperties", {}).get("contentUri")
                if not uri:
                    raise ValueError("Only inline images are supported (no drawings or charts).")
                path = image_loader(uri)
                cover = cover or path
                alt = obj.get("description") or obj.get("title") or ""
                runs.append(f'<img src="{html.escape(path, quote=True)}" alt="{html.escape(alt, quote=True)}" loading="lazy">')
            else:
                raise ValueError("Remove unsupported elements such as smart chips, equations or footnotes.")
        value = "".join(runs)
        bullet = p.get("bullet")
        if bullet:
            list_id = bullet["listId"]
            depth = bullet.get("nestingLevel", 0) + 1
            levels = tab.get("lists", {}).get(list_id, {}).get("listProperties", {}).get("nestingLevels", [])
            if depth > 9 or depth > len(levels):
                raise ValueError("Unsupported list nesting.")
            tag = "ol" if levels[depth - 1].get("glyphType", "GLYPH_TYPE_UNSPECIFIED") != "GLYPH_TYPE_UNSPECIFIED" else "ul"
            if last_list_id != list_id:
                close_lists()
            if depth > len(lists) + 1:
                raise ValueError("Lists must start at the first indent level and increase one level at a time.")
            close_lists(depth)
            if len(lists) == depth and lists[-1] != tag:
                close_lists(depth - 1)
            if len(lists) < depth:
                out.append(f"<{tag}><li>{value}")
                lists.append(tag)
            else:
                out.append(f"</li><li>{value}")
            last_list_id = list_id
        else:
            close_lists()
            last_list_id = None
            if not value.strip():
                continue
            style = p.get("paragraphStyle", {}).get("namedStyleType", "NORMAL_TEXT")
            match = re.fullmatch(r"HEADING_([1-6])", style)
            tag = f"h{max(2, int(match[1]))}" if match else "p"
            out.append(f"<{tag}>{value}</{tag}>")
    close_lists()
    return "\n".join(out) + "\n", cover


class GoogleDrive:
    def __init__(self):
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
        info = json.loads(os.environ["GOOGLE_BLOG_SERVICE_ACCOUNT_JSON"])
        if info.get("type") != "service_account" or info.get("token_uri") != "https://oauth2.googleapis.com/token":
            raise ValueError("Use a Google service-account JSON credential.")
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents.readonly"])
        self.session = AuthorizedSession(creds)

    def request(self, method, service, path, **kwargs):
        # API and document content are never used as destinations for credentials.
        base = {"drive": "https://www.googleapis.com/drive/v3/", "docs": "https://docs.googleapis.com/v1/"}[service]
        response = self.session.request(method, base + path, timeout=45, allow_redirects=False, **kwargs)
        if not response.ok:
            raise ValueError(f"Google {service} request failed (HTTP {response.status_code}). Check API access and folder sharing.")
        return response.json()

    def metadata(self, file_id):
        return self.request("GET", "drive", f"files/{file_id}", params={
            "fields": "id,mimeType,parents,modifiedTime,trashed", "supportsAllDrives": "true"})

    def ready(self, folder_id):
        files, token = [], None
        while True:
            params = {"q": f"'{folder_id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.document'",
                      "fields": "nextPageToken,files(id,modifiedTime)", "pageSize": 100, "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
            if token:
                params["pageToken"] = token
            result = self.request("GET", "drive", "files", params=params)
            files.extend(result.get("files", []))
            token = result.get("nextPageToken")
            if not token:
                return files

    def document(self, file_id):
        return self.request("GET", "docs", f"documents/{file_id}", params={"includeTabsContent": "true", "suggestionsViewMode": "SUGGESTIONS_INLINE"})

    def archive(self, file_id, ready_id, published_id):
        return self.request("PATCH", "drive", f"files/{file_id}", params={
            "addParents": published_id, "removeParents": ready_id, "supportsAllDrives": "true", "fields": "id,parents"}, json={})

    def validate_folders(self, config):
        for key in ("root_folder_id", "ready_folder_id", "published_folder_id"):
            metadata = self.metadata(config[key])
            if metadata.get("trashed") or metadata.get("mimeType") != "application/vnd.google-apps.folder":
                raise ValueError("A configured publishing folder is missing or not a folder.")
            if key != "root_folder_id" and config["root_folder_id"] not in metadata.get("parents", []):
                raise ValueError("The publishing folders must be inside AQ Career Blog Posts.")


def download_image(uri):
    import requests
    from PIL import Image, ImageOps
    # Image content URIs are short-lived Google URLs. Never attach an API token,
    # follow a redirect to another host or store these signed URLs in the repo.
    for _ in range(4):
        parsed = urlparse(uri)
        host = parsed.hostname or ""
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or not host.endswith(".googleusercontent.com"):
            raise ValueError("Image is not served by Google; insert it directly in the document.")
        with requests.get(uri, timeout=30, stream=True, allow_redirects=False) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                uri = response.headers.get("Location", "")
                continue
            if response.status_code != 200:
                raise ValueError("Could not download an article image.")
            data = bytearray()
            for chunk in response.iter_content(65536):
                data.extend(chunk)
                if len(data) > 10_000_000:
                    raise ValueError("Each article image must be smaller than 10 MB.")
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > 20_000_000:
                raise ValueError("Article images must be no larger than 20 megapixels.")
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((1800, 1800))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=88, optimize=True)
            return output.getvalue()
    raise ValueError("Too many redirects while downloading an image.")


def load_snapshots(root=ROOT):
    result = {}
    for path in sorted((root / STORE).glob("*.json")):
        if not ID.fullmatch(path.stem):
            raise ValueError("Invalid stored document ID.")
        value = read_json(path)
        if not SLUG.fullmatch(value["slug"]):
            raise ValueError("Invalid stored post slug.")
        result[path.stem] = value
    return result


def published_posts(root=ROOT):
    return list(load_snapshots(root).values())


def sync(api, config, root=ROOT, today=None, image_fetch=download_image):
    today = today or dt.datetime.now(ZoneInfo("America/Los_Angeles")).date()
    old = load_snapshots(root)
    legacy = read_json(root / "content/posts.json")
    slugs = {p["slug"]: None for p in legacy}
    for doc_id, post in old.items():
        if post["slug"] in slugs:
            raise ValueError("Duplicate post URL in saved content.")
        slugs[post["slug"]] = doc_id
    updates, images, pending = {}, {}, []
    for item in api.ready(config["ready_folder_id"]):
        doc_id = item["id"]
        if not ID.fullmatch(doc_id) or doc_id == config["template_document_id"]:
            raise ValueError("Keep the original template in Edits; publish a completed copy.")
        prior = old.get(doc_id)
        if prior and prior["source_modified"] == item["modifiedTime"]:
            pending.append(item)
            continue
        post, elements, tab = parse_document(api.document(doc_id), prior)
        if dt.date.fromisoformat(post["date"]) > today:
            print("A future-dated post remains in Ready to Publish.")
            continue
        if post["slug"] in slugs and slugs[post["slug"]] != doc_id:
            raise ValueError("This post's URL is already in use. Enter a different Slug for the new article.")
        slugs[post["slug"]] = doc_id

        def image_loader(uri):
            data = image_fetch(uri)
            path = IMAGES / doc_id / (hashlib.sha256(data).hexdigest()[:24] + ".jpg")
            images[path] = data
            return "/" + path.as_posix()

        post["body"], post["cover"] = render_body(elements, tab, image_loader)
        check = api.metadata(doc_id)
        if check.get("trashed") or config["ready_folder_id"] not in check.get("parents", []) or check["modifiedTime"] != item["modifiedTime"]:
            raise ValueError("A queued article changed during import; it will be retried on the next run.")
        post["source_modified"] = item["modifiedTime"]
        updates[doc_id] = post
        pending.append(item)
    # Validate the entire queue before writing any snapshots.
    for path, data in images.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(data)
    for doc_id, post in updates.items():
        write_json(root / STORE / f"{doc_id}.json", post)
    write_json(root / "_blog-pending.json", pending)
    return len(updates), len(pending)


def acknowledge(api, config, root=ROOT):
    for item in read_json(root / "_blog-pending.json"):
        metadata = api.metadata(item["id"])
        if config["published_folder_id"] in metadata.get("parents", []):
            continue
        if metadata.get("trashed") or config["ready_folder_id"] not in metadata.get("parents", []) or metadata["modifiedTime"] != item["modifiedTime"]:
            print("An article changed after import; leaving it in its current folder for review.")
            continue
        result = api.archive(item["id"], config["ready_folder_id"], config["published_folder_id"])
        if config["published_folder_id"] not in result.get("parents", []):
            raise ValueError("Could not confirm moving a published article to Published.")


def git(*args, **kwargs):
    return subprocess.check_output(["git", *args], cwd=ROOT, **kwargs).decode().strip()


def restore(config):
    branch = config["content_branch"]
    refs = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    (ROOT / "_blog-base.txt").write_text(refs.split()[0] if refs else "", encoding="utf-8")
    (ROOT / STORE).mkdir(parents=True, exist_ok=True)
    (ROOT / IMAGES).mkdir(parents=True, exist_ok=True)
    if not refs:
        return
    git("fetch", "--no-tags", "origin", f"refs/heads/{branch}")
    # Read only allowlisted data files; never execute code from the content branch.
    for name in git("ls-tree", "-r", "--name-only", "FETCH_HEAD").splitlines():
        path = Path(name)
        is_post = path.parent == STORE and path.suffix == ".json" and ID.fullmatch(path.stem)
        is_image = len(path.parts) == 6 and Path(*path.parts[:4]) == IMAGES and ID.fullmatch(path.parts[4]) and re.fullmatch(r"[a-f0-9]{24}\.jpg", path.name)
        if not (is_post or is_image or path == Path("content/likes.json")):
            raise ValueError("Unexpected file in the blog content branch.")
        data = subprocess.check_output(["git", "show", f"FETCH_HEAD:{name}"], cwd=ROOT)
        (ROOT / path).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / path).write_bytes(data)


def save(config):
    branch = config["content_branch"]
    refs = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    parent = refs.split()[0] if refs else None
    if (ROOT / "_blog-base.txt").read_text().strip() != (parent or ""):
        raise ValueError("Published content changed during this run. Retry to include the latest articles.")
    if parent:
        git("fetch", "--no-tags", "origin", f"refs/heads/{branch}")
    with tempfile.TemporaryDirectory() as temp:
        env = os.environ | {"GIT_INDEX_FILE": str(Path(temp) / "index"),
                            "GIT_AUTHOR_NAME": "github-actions[bot]", "GIT_AUTHOR_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
                            "GIT_COMMITTER_NAME": "github-actions[bot]", "GIT_COMMITTER_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com"}
        git("read-tree", "--empty", env=env)
        for directory in (STORE, IMAGES):
            if any((ROOT / directory).rglob("*.*")):
                git("add", "-f", "--", str(directory), env=env)
        if (ROOT / "content/likes.json").is_file():
            git("add", "-f", "--", "content/likes.json", env=env)
        tree = git("write-tree", env=env)
        if parent and git("rev-parse", f"{parent}^{{tree}}") == tree:
            return
        if not parent and not load_snapshots(ROOT):
            return
        args = ["commit-tree", tree, "-m", "Save approved blog articles"]
        if parent:
            args += ["-p", parent]
        commit = git(*args, env=env)
        # An ordinary fast-forward push fails on concurrent updates.
        git("push", "origin", f"{commit}:refs/heads/{branch}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("restore", "sync", "save", "acknowledge"))
    args = parser.parse_args()
    config = read_json(ROOT / "tools/blog-drive.json")
    if args.command == "restore":
        restore(config)
    elif args.command == "save":
        save(config)
    else:
        api = GoogleDrive()
        api.validate_folders(config)
        if args.command == "sync":
            changed, pending = sync(api, config)
            print(f"Imported {changed} article(s); {pending} awaiting deployment.")
            if os.environ.get("GITHUB_OUTPUT"):
                with open(os.environ["GITHUB_OUTPUT"], "a") as out:
                    out.write(f"pending={str(bool(pending)).lower()}\n")
        else:
            acknowledge(api, config)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Auth/HTTP exception strings may contain signed URLs or credentials.
        if isinstance(exc, ValueError):
            print(f"Blog publishing stopped: {exc}")
        else:
            print(f"Blog publishing stopped ({type(exc).__name__}). Check credentials, connectivity and the publishing guide.")
        raise SystemExit(1) from None
