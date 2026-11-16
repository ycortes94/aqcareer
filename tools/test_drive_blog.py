"""Regression tests for publication boundaries, safe rendering and retries."""
import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
import shutil
import subprocess
from unittest.mock import patch

import drive_blog
from drive_blog import (STORE, acknowledge, parse_document, published_posts,
                        render_body, sync, write_json)


DOC_ID = "test_document_12345"
CONFIG = {"ready_folder_id": "ready", "published_folder_id": "published", "template_document_id": "template"}


def paragraph(text, **kwargs):
    return {"paragraph": {"elements": [{"textRun": {"content": text + "\n"}}], **kwargs}}


def document(body=None, title="An article", date="2026-11-16", slug=""):
    return {"tabs": [{"documentTab": {"body": {"content": [
        {"sectionBreak": {}}, paragraph("Private drafting instructions"),
        paragraph("Title: " + title), paragraph("Author: Alina Quintana"),
        paragraph("Date: " + date), paragraph("Slug: " + slug), paragraph("POST START"),
        *(body or [paragraph("The actual article.")]), paragraph("POST END"),
        paragraph("Private footer instructions")
    ]}}}]}


class FakeDrive:
    def __init__(self, doc=None):
        self.doc = doc or document()
        self.items = [{"id": DOC_ID, "modifiedTime": "version-1"}]
        self.meta = {"id": DOC_ID, "modifiedTime": "version-1", "parents": ["ready"], "trashed": False}
        self.moves = []

    def ready(self, folder):
        return copy.deepcopy(self.items)

    def document(self, file_id):
        return copy.deepcopy(self.doc)

    def metadata(self, file_id):
        return copy.deepcopy(self.meta)

    def archive(self, file_id, source, destination):
        self.moves.append((file_id, source, destination))
        self.meta["parents"] = [destination]
        return self.meta


class BlogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        write_json(self.root / "content/posts.json", [])

    def test_only_article_body_is_rendered(self):
        post, body, tab = parse_document(document())
        rendered, cover = render_body(body, tab, lambda _: "")
        self.assertEqual(rendered, "<p>The actual article.</p>\n")
        self.assertEqual(post["slug"], "an-article")
        self.assertEqual(cover, "")
        self.assertNotIn("Private", rendered)

    def test_placeholders_and_missing_or_duplicate_markers_fail(self):
        for doc in [document(title="[Your blog post title]"),
                    document(body=[paragraph("[Your first tip or takeaway.]")]),
                    document(body=[paragraph("POST START")])]:
            with self.assertRaises(ValueError):
                parse_document(doc)
        doc = document()
        doc["tabs"][0]["documentTab"]["body"]["content"].pop(-2)
        with self.assertRaises(ValueError):
            parse_document(doc)

    def test_multiple_tabs_and_suggestions_fail(self):
        doc = document()
        doc["tabs"].append(copy.deepcopy(doc["tabs"][0]))
        with self.assertRaises(ValueError):
            parse_document(doc)
        p = paragraph("Suggested text")
        p["paragraph"]["elements"][0]["suggestedInsertionIds"] = ["suggestion"]
        with self.assertRaises(ValueError):
            parse_document(document(body=[p]))

    def test_stable_urls_and_validation(self):
        previous = {"slug": "original-url"}
        post, _, _ = parse_document(document(title="Changed title"), previous)
        self.assertEqual(post["slug"], "original-url")
        for doc in [document(slug="different"), document(slug="../../bad"), document(date="2026-02-30")]:
            with self.assertRaises(ValueError):
                parse_document(doc, previous)

    def test_escapes_html_and_rejects_unsafe_links(self):
        p = paragraph('<script>alert("x")</script>')
        p["paragraph"]["elements"][0]["textRun"]["textStyle"] = {"bold": True, "link": {"url": "https://example.com/?a=1&b=2"}}
        _, body, tab = parse_document(document(body=[p]))
        rendered, _ = render_body(body, tab, lambda _: "")
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn("a=1&amp;b=2", rendered)
        p["paragraph"]["elements"][0]["textRun"]["textStyle"]["link"]["url"] = "javascript:alert(1)"
        _, body, tab = parse_document(document(body=[p]))
        with self.assertRaises(ValueError):
            render_body(body, tab, lambda _: "")

    def test_lists_headings_and_images(self):
        body = [paragraph("Heading", paragraphStyle={"namedStyleType": "HEADING_1"}),
                paragraph("One", bullet={"listId": "list", "nestingLevel": 0}),
                paragraph("Nested", bullet={"listId": "list", "nestingLevel": 1}),
                paragraph("Two", bullet={"listId": "list", "nestingLevel": 0}),
                {"paragraph": {"elements": [{"inlineObjectElement": {"inlineObjectId": "image"}}]}}]
        doc = document(body=body)
        tab = doc["tabs"][0]["documentTab"]
        tab["lists"] = {"list": {"listProperties": {"nestingLevels": [{"glyphType": "DECIMAL"}, {"glyphSymbol": "●"}]}}}
        tab["inlineObjects"] = {"image": {"inlineObjectProperties": {"embeddedObject": {
            "description": 'An "image"', "imageProperties": {"contentUri": "temporary-url"}}}}}
        _, elements, tab = parse_document(doc)
        rendered, cover = render_body(elements, tab, lambda _: "/assets/img/blog/drive/photo.jpg")
        self.assertIn("<h2>Heading</h2>", rendered)
        self.assertIn("<ol><li>One\n<ul><li>Nested\n</li></ul>\n</li><li>Two\n</li></ol>", rendered)
        self.assertIn('alt="An &quot;image&quot;"', rendered)
        self.assertEqual(cover, "/assets/img/blog/drive/photo.jpg")
        self.assertNotIn("temporary-url", rendered)

    def test_unsupported_blocks_are_not_silently_lost(self):
        for element in [{"table": {}}, {"paragraph": {"elements": [{"footnoteReference": {}}]}}]:
            with self.assertRaises(ValueError):
                render_body([element], {}, lambda _: "")

    def test_import_retry_and_deployment_acknowledgement(self):
        api = FakeDrive()
        self.assertEqual(sync(api, CONFIG, self.root, dt.date(2026, 11, 16)), (1, 1))
        self.assertEqual(api.moves, [])
        self.assertEqual(len(published_posts(self.root)), 1)
        snapshot = (self.root / STORE / f"{DOC_ID}.json").read_text()
        self.assertNotIn("Private", snapshot)
        self.assertEqual(sync(api, CONFIG, self.root, dt.date(2026, 11, 16)), (0, 1))
        acknowledge(api, CONFIG, self.root)
        acknowledge(api, CONFIG, self.root)
        self.assertEqual(len(api.moves), 1)

    def test_like_refresh_recognizes_drive_articles(self):
        import refresh_likes
        sync(FakeDrive(), CONFIG, self.root, dt.date(2026, 11, 16))
        with patch.object(refresh_likes, "ROOT", str(self.root)), patch.object(refresh_likes, "POSTS", str(self.root / "content/posts.json")):
            self.assertEqual(refresh_likes.slugs(), ["an-article"])

    def test_changed_or_withdrawn_document_is_not_archived(self):
        for change in [{"modifiedTime": "version-2"}, {"parents": ["edits"]}, {"trashed": True}]:
            api = FakeDrive()
            sync(api, CONFIG, self.root, dt.date(2026, 11, 16))
            api.meta.update(change)
            acknowledge(api, CONFIG, self.root)
            self.assertEqual(api.moves, [])

    def test_future_date_is_held(self):
        api = FakeDrive(document(date="2026-11-17"))
        self.assertEqual(sync(api, CONFIG, self.root, dt.date(2026, 11, 16)), (0, 0))
        self.assertEqual(published_posts(self.root), [])

    def test_existing_url_collision_and_concurrent_edits_fail_without_writes(self):
        write_json(self.root / "content/posts.json", [{"slug": "an-article"}])
        with self.assertRaises(ValueError):
            sync(FakeDrive(), CONFIG, self.root, dt.date(2026, 11, 16))
        write_json(self.root / "content/posts.json", [])
        api = FakeDrive()
        api.meta["modifiedTime"] = "version-2"
        with self.assertRaises(ValueError):
            sync(api, CONFIG, self.root, dt.date(2026, 11, 16))
        self.assertEqual(published_posts(self.root), [])

    def test_imported_article_is_built_into_page_index_feed_and_sitemap(self):
        import build
        shutil.copytree(drive_blog.ROOT / "content", self.root / "content", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("drive-posts"))
        write_json(self.root / "content/posts.json", [])
        sync(FakeDrive(document(title='A <new> article')), CONFIG, self.root, dt.date(2026, 11, 16))
        with patch.object(build, "ROOT", str(self.root)), patch.object(build, "C", str(self.root / "content")):
            build.build()
        article = (self.root / "post/a-new-article/index.html").read_text()
        self.assertIn("The actual article.", article)
        self.assertIn("A &lt;new&gt; article", article)
        self.assertIn("A \\u003cnew> article", article)
        self.assertNotIn("Private drafting instructions", article)
        for path in ("blog/index.html", "feed.xml", "sitemap.xml"):
            self.assertIn("a-new-article", (self.root / path).read_text())

    def test_content_branch_roundtrip_and_concurrent_write_detection(self):
        remote = self.root / "remote.git"
        checkout = self.root / "checkout"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
        checkout.mkdir()
        subprocess.run(["git", "init", str(checkout)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(checkout), "remote", "add", "origin", str(remote)], check=True)
        config = {"content_branch": "codex/blog-content"}
        with patch.object(drive_blog, "ROOT", checkout):
            drive_blog.restore(config)
            write_json(checkout / STORE / f"{DOC_ID}.json", {"slug": "article", "body": "<p>Saved content</p>"})
            write_json(checkout / "content/likes.json", {"article": 3})
            drive_blog.save(config)
            (checkout / STORE / f"{DOC_ID}.json").unlink()
            (checkout / "content/likes.json").unlink()
            drive_blog.restore(config)
            self.assertEqual(published_posts(checkout)[0]["body"], "<p>Saved content</p>")
            self.assertEqual(json.loads((checkout / "content/likes.json").read_text()), {"article": 3})
            first = subprocess.check_output(["git", "--git-dir", str(remote), "rev-parse", "refs/heads/codex/blog-content"]).strip()
            drive_blog.save(config)
            second = subprocess.check_output(["git", "--git-dir", str(remote), "rev-parse", "refs/heads/codex/blog-content"]).strip()
            self.assertEqual(first, second)
            (checkout / "_blog-base.txt").write_text("stale-base")
            with self.assertRaises(ValueError):
                drive_blog.save(config)


if __name__ == "__main__":
    unittest.main()
