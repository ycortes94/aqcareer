# Security checks and release operations

## Run checks

Requirements: Python 3.12 or newer, Node 22 or newer and curl. The build and
local regression tests need no third-party Python modules:

```sh
sh tools/check.sh
```

This rebuilds all published HTML, verifies every inline script against its
CSP, checks form security/delivery, navigation and post interactions, and tests
the edge-header handler. Google/Cloudflare services are mocked: no customer
submission or email is sent. The credential-pattern preflight checks tracked
files only and is not a comprehensive secret scanner or history scan.

For the image-refresh environment:

```sh
python3 tools/bootstrap_uv.py
.tools/uv lock --check
.tools/uv sync --frozen
.tools/uv run --frozen python tools/test_instagram_processing.py
```

The bootstrap verifies the pinned uv wheel's SHA-256 before extracting its
executable. `uv.lock` locks Pillow and its artifact hashes; resolution excludes
releases younger than seven days. Pillow 13.0.0 and uv 0.13.4 are pinned to address the advisories checked
on October 21, 2026. The lock configuration records a per-package age exception
for the Pillow security update. Do not downgrade solely to remain
one version behind. Update the uv bootstrap manifest deliberately from PyPI.

Online release checks fail closed on CDN/advisory lookup failures:

```sh
node tools/test_script_integrity.cjs
python3 tools/check_dependencies.py
```

OSV checks exact Python, bootstrap-tool and browser SDK versions. It is an
advisory lookup, not an exhaustive dependency audit. Dependabot watches Actions
and uv dependencies; SDKs in JavaScript need deliberate reviewed updates.
Update each SDK URL and its SHA-384 together; never replace a hash merely to
make a failing check pass. Repeat the replay/privacy tests in ANALYTICS.md.

Optional browser checks use an externally installed Playwright package and
Chrome, with `PLAYWRIGHT_MODULE` set to that package's path and
`BROWSER_CHANNEL=chrome` (or leave the channel unset for Playwright Chromium):

```sh
node tools/test_browser_security.cjs
```

They verify all three designs, no analytics before consent, actual approved
SDK bytes, CSP rejection of injected script and SRI rejection of modified
bytes. All external runtime traffic is intercepted; the bundles are fetched
publicly for integrity checking. This does not test real Cloudflare challenges
or live analytics delivery. Verify those in staging before release.

## Browser policies and hosting

The build inserts a hash-based CSP and referrer-policy meta tag into every
published HTML page. Inline event handlers are prohibited; the font loaders
use non-blocking stylesheet links activated by a hash-authorized load listener. CSS still permits inline styles for existing
layouts/SDK behavior. Network destinations are limited to the site's actual
providers, including Statsig's SDK fallback hosts.

### Current choice: GitHub Pages with GoDaddy DNS

Keep GitHub Pages hosting and GoDaddy authoritative DNS. No Netlify deployment
or additional hosting subscription is required for this branch. The existing
page-level CSP restricts scripts, connections, forms and embedded content;
`upgrade-insecure-requests` upgrades insecure resource URLs. The referrer meta
policy limits information sent to other sites. These controls already ship
with every generated page; they are not newly added by this audit follow-up.

They are partial protections, not replacements for all response headers:

- HTTPS enforcement and CSP resource upgrades do not replace HSTS's protection
  of future top-level visits.
- `frame-src` controls what this site embeds, not who can embed this site.
  `frame-ancestors` and X-Frame-Options cannot be enforced through meta tags.
- `nosniff` and a document-wide Permissions-Policy require response headers.

Do not add unsupported meta tags or JavaScript frame-busting and report those
as equivalent protection. The remaining headers are deferred hardening for
this informational site, not a completed audit item. Reassess if the site adds
accounts, payments or other sensitive interactions.

References: [MDN frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)
and [MDN Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy).

### Optional future proxy (not part of this release)

GitHub Pages does **not** read arbitrary `_headers` files. Adding the remaining
headers requires a host or proxy capable of setting response headers.
`edge/security-worker.mjs` is ready to route in front of Pages and is tested
locally, but is not activated by merging this branch:

1. Confirm domain ownership, origin HTTPS and Cloudflare proxied DNS. Do not
   change working DNS until a staging hostname has passed the same checks.
2. Deploy the Worker with a reviewed Cloudflare toolchain. Add the production
   routes shown in `edge/wrangler.toml` only after staging verification.
3. Verify the origin remains GitHub Pages, HTTPS redirects correctly, and both
   successful and error responses have the security headers. The Worker adds
   a header CSP for framing; each document's meta CSP supplies its own script
   hashes. This avoids a release-order mismatch with cached HTML.
4. Test all layouts, consent acceptance/decline, analytics initialization,
   dialogs, forms, blog paging and downloads. Verify actual browser network
   requests and CSP violation reports before rollout.
5. HSTS is one year without includeSubDomains/preload; enable wider settings
   only after every affected hostname is verified. HSTS is cached by browsers,
   so removing the Worker is not an immediate reversal of that policy.

## Required account settings (not changed by source files)

- GitHub: enable private vulnerability reporting, secret scanning/push
  protection where available, MFA, required reviews and the `validate` job
  from **Validate site security** as a required check. Require review of
  workflow changes. Restrict Pages deployments to main.
- The Instagram writer job has repository-write scope but runs no Python
  dependencies. Its generator has read scope and no persisted Git credential.
  If branch rules reject bot pushes, use a reviewed PR-based publishing flow;
  do not grant a broad bypass token. A failed refresh leaves published content.
- Google: protect the Apps Script owner with MFA, review Sheet sharing and
  access, verify script properties and the deployed version. Follow the
  coordinated frontend/backend deployment in FORMS.md.
- Turnstile: allow only the production hosts. Tokens require action `aq_form`.
  Review failures before rollout; do not disable server validation to recover.

## Personal information, monitoring and recovery

The owner must choose and record actual retention periods in each provider
before updating the public policy. Review form email, every backup Sheet,
mailing-list requests, Amplitude events/replay and Statsig independently.
Document deletion across all destinations, unsubscribe/email-confirmation
handling and access reviews. Do not claim automatic deletion without configuring
it. The existing privacy policy must be kept consistent with those choices.

Assign the site owner to review Apps Script delivery failures, quota/rate-limit
failures and failed GitHub Actions runs; enable provider alerts to a monitored
private destination. Never include submission bodies or secrets in alerts.
For an incident, preserve private execution metadata, restrict the affected
integration, rotate exposed secrets and redeploy the last known working
version. Validate delivery and privacy controls before reopening forms. Record
the Git commit, Apps Script deployment version and any edge version for every
release. No automated production alert channel has been configured here.

## Performance regression checks

`sh tools/check.sh` checks compressed payload budgets for all generated pages
and first-party JavaScript/CSS, plus cached and delayed font-loading behavior.
The budgets record the original baseline revision in
`tools/performance-budget.json`. Review budget updates deliberately when adding
content or browser code. They do not measure real hosting latency.

For a controlled browser comparison, extract the original site to a temporary
directory and set `PERF_BASELINE_ROOT` to that directory. Use the same optional
Playwright/Chrome configuration described above, then run:

```sh
node tools/test_performance.cjs
```

It alternates five cold loads per revision for each homepage design using a
mobile viewport, 4x CPU slowdown, 80 ms latency and 1.6 Mbps download.
Set `PERF_ROUNDS` to change the repeat count. Google
Fonts CSS is delayed by one second to detect render-blocking regressions.
It checks median first/largest contentful paint, document readiness, dialog
response to the next frames, and script-request count. External services are intercepted. These
are controlled laboratory comparisons, not real-user Core Web Vitals.
The undeployed edge proxy and real Apps Script round-trip latency still need
measurement in staging.

Font CSS stays non-blocking without inline event handlers. Preload hints expose
the existing deferred script files and the homepage portrait before the inline
head gate delays normal discovery. Critical site CSS is listed first so those
hints cannot take its initial connection slots. Script hints use low fetch
priority to avoid competing with the visible portrait. The browser reuses these
requests; no additional library or external provider is introduced.
