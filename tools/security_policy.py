"""Build CSP from actual generated script bytes, plus a static Pages fallback.

Each page carries its own policy, so a header-proxy release cannot invalidate
the script hashes on an independently cached HTML page.
"""
import base64
import hashlib
import html
import re
from pathlib import Path


def protect_pages(root, made):
    root = Path(root)
    pages = [root / name for name in made if name.endswith('.html')]
    texts = [p.read_text(encoding='utf-8') for p in pages]
    hashes = set()
    for text in texts:
        for attrs, body in re.findall(r'<script\b([^>]*)>([\s\S]*?)</script>', text):
            if re.search(r'\bsrc\s*=', attrs, re.I):
                continue
            if re.search(r'type=[\"\']application/ld\+json', attrs):
                continue
            hashes.add("'sha256-" + base64.b64encode(
                hashlib.sha256(body.encode()).digest()).decode() + "'")
    policy = '; '.join([
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "script-src 'self' " + ' '.join(sorted(hashes)) +
        ' https://cdn.jsdelivr.net https://cdn.amplitude.com https://challenges.cloudflare.com',
        "script-src-attr 'none'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://*.amplitude.com",
        "media-src 'self'",
        "connect-src 'self' https://*.amplitude.com https://*.statsig.com https://*.statsigapi.net https://statsigapi.net https://prodregistryv2.org https://featureassets.org https://api.statsigcdn.com https://cloudflare-dns.com "
        'https://script.google.com https://script.googleusercontent.com https://challenges.cloudflare.com https://app.kit.com',
        'frame-src https://challenges.cloudflare.com',
        "worker-src 'self' blob:",
        "form-action https://script.google.com https://script.googleusercontent.com",
        'upgrade-insecure-requests',
    ])
    for path, text in zip(pages, texts):
        meta = '<meta http-equiv="Content-Security-Policy" content="' + html.escape(policy, quote=True) + '">\n'
        meta += '<meta name="referrer" content="strict-origin-when-cross-origin">\n'
        # A per-document policy travels with HTML even when the Worker deploy
        # and the static deployment occur at different times.
        path.write_text(text.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + meta, 1), encoding='utf-8')
