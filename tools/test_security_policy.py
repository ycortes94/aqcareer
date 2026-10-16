"""Verify generated pages permit their scripts and exclude inline handlers."""
import base64
import hashlib
from html.parser import HTMLParser
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent

class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=False)
        self.metas, self.scripts, self.handlers, self.forms, self.links = [], [], [], [], []
        self.script = None
        self.feed(text)
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.handlers.extend(k for k in attrs if k.startswith('on'))
        if tag == 'link': self.links.append(attrs)
        if tag == 'meta': self.metas.append(attrs)
        if tag == 'script': self.script = [attrs, '']
        if tag == 'form': self.forms.append(attrs)
    def handle_data(self, data):
        if self.script is not None: self.script[1] += data
    def handle_endtag(self, tag):
        if tag == 'script' and self.script is not None:
            self.scripts.append(self.script)
            self.script = None

class SecurityPolicy(unittest.TestCase):
    def test_generated_pages(self):
        paths = [ROOT / 'index.html', ROOT / '404.html', ROOT / 'privacy/index.html']
        paths += list((ROOT / 'blog').rglob('index.html')) + list((ROOT / 'post').rglob('index.html'))
        self.assertEqual(len(paths), 16)
        for path in paths:
            with self.subTest(page=str(path.relative_to(ROOT))):
                page = Page(path.read_text())
                policies = [m['content'] for m in page.metas if m.get('http-equiv') == 'Content-Security-Policy']
                self.assertEqual(len(policies), 1)
                policy = policies[0]
                self.assertIn("script-src-attr 'none'", policy)
                self.assertIn("object-src 'none'", policy)
                self.assertIn('https://challenges.cloudflare.com', policy)
                self.assertNotIn("'unsafe-inline'", policy.split('script-src ')[1].split(';')[0])
                self.assertFalse(page.handlers)
                deferred = {attrs['src'] for attrs, _ in page.scripts if 'src' in attrs and 'defer' in attrs}
                preloads = [link['href'] for link in page.links if link.get('rel') == 'preload' and link.get('as') == 'script']
                self.assertEqual(set(preloads), deferred, 'preload existing scripts only')
                style_positions = [i for i, link in enumerate(page.links) if link.get('rel') == 'stylesheet' and link.get('media') != 'print' and not link.get('href', '').startswith('https://fonts.')]
                hint_positions = [i for i, link in enumerate(page.links) if link.get('rel') == 'preload']
                if style_positions and hint_positions:
                    self.assertLess(max(style_positions), min(hint_positions), 'critical CSS must precede preload hints')
                self.assertEqual(len(preloads), len(set(preloads)), 'no duplicate preload hints')
                for link in page.links:
                    if link.get('rel') == 'preload' and link.get('as') == 'script':
                        self.assertEqual(link.get('fetchpriority'), 'low')
                    if 'data-async-font' in link:
                        self.assertEqual(link.get('media'), 'print')
                self.assertTrue(any(m.get('name') == 'referrer' for m in page.metas))
                for attrs, body in page.scripts:
                    if attrs.get('src') or attrs.get('type') == 'application/ld+json': continue
                    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
                    self.assertIn("'sha256-" + digest + "'", policy)
                for form in page.forms:
                    self.assertIn('amp-block', form.get('class', '').split())
                    self.assertTrue(form['action'].startswith('https://script.google.com/'))

if __name__ == '__main__': unittest.main()
