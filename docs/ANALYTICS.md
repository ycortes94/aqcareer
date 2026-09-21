# Analytics

Amplitude and Statsig are wired in but **switched off** until keys are set.
With no keys in `site.json`, the build emits no third-party scripts at all.
With keys set, they still load only for a visitor who has accepted the
[consent disclaimer](#consent).

## Turning it on

Put the two client keys in `site.json`:

```json
"analytics": {
  "amplitude_api_key": "<Amplitude API key>",
  "statsig_client_key": "client-…",
  "session_replay": { "enabled": true, "sample_rate": 1, "mask_forms": true },
  "respect_dnt": true,
  "consent": { "required": true, "policy_url": "/privacy/" }
}
```

Then `python3 tools/build.py`, commit, push.

### Where the keys come from

| Key | Where to find it | Safe in a public repo? |
|---|---|---|
| Amplitude API key | Amplitude → Settings → Projects → *the project* → **API Key** | **Yes** — it's the client-side key, designed to be embedded in a web page |
| Statsig client key | Statsig console → Project Settings → **API Keys** → *Client* key, starts `client-` | **Yes** — same reason |

**Never put a Statsig `secret-…` key or an Amplitude secret key in this repo,
or anywhere in the site.** Those are server keys. They grant write and read
access to the whole project, and everything in this repo is public. The only
keys that belong here are the client ones above.

## Which project

This site's data goes to:

| | Project |
|---|---|
| Amplitude | **AQ Career Site** (project `630492`) |
| Statsig | **Yosimy Test Project** |

Check before pasting a key — one from an unrelated or shared project
silently mixes this site's visitor traffic into someone else's analytics.
The Statsig key currently configured is a `client-` key validated against
Statsig's initialize endpoint.

## Session Replay

Enabled by default, recording every session (`sample_rate: 1` = 100%). Lower
it to e.g. `0.2` for a fifth of sessions if volume ever matters.

### What's masked

This site's contact form collects a name, an email address, and a free-text
message to a career counselor. That content must never appear in a replay.

**Read this before trusting the SDK defaults.** Amplitude's Session Replay
privacy settings are configured **per project in the Amplitude UI**, and the
UI takes precedence over anything the SDK asks for. The docs are explicit:
"the Session Replay settings page takes precedence". A `maskSelector` passed
from this repo can therefore be overridden server-side without any change
here.

As checked on 2026-09-18, this project's remote config
(`sr-client-cfg.amplitude.com/config/<key>?config_group=browser`) returned:

```json
"sr_privacy_config": { "maskAttributes": [], "maskSelector": [],
                       "blockSelector": [], "unmaskSelector": [],
                       "defaultMaskLevel": "medium", "urlMaskLevels": [] }
```

Mask levels, per Amplitude's documentation:

| Level | Masks |
|---|---|
| `light` | only a subset of sensitive inputs — passwords, credit card numbers, telephone numbers, email addresses |
| `medium` | all form fields and text inputs |
| `conservative` | all text and all form fields, including HTML text and links |

`medium` covers the message textarea and the name fields. It was `light`
when this was first written, which is why protection here does not rest on
the remote setting alone — there are two layers, and either one would cover
the forms by itself:

1. **`mask_forms: true`** (the default) makes the build add the
   **`amp-block`** class to both `<form>` elements. `amp-block` is read from
   the markup, so it replaces each form with a blank placeholder in the
   recording and a remote config change cannot switch it off. Trade-off: the
   form area shows as an empty box in replays. The analytics events
   (form start / form submit) are unaffected, so conversion is still
   measurable.
2. The project's own `defaultMaskLevel`, now `medium`, which also covers any
   text input added outside the two forms. This is the setting that wins if
   the two ever disagree, so re-check it before relying on it — it lives
   under *Settings → Organizational Settings → Session Replay Settings*.

Setting `mask_forms: false` removes the class and the selectors, leaving the
project's UI mask level as the only protection.

The consent notice in `analytics.js` tells visitors "All sensitive text
fields are masked", so both layers are load-bearing copy now, not just
configuration. Weakening either one means rewriting that sentence.

### Verified against live traffic, 2026-09-18

The remote config returns `sr_logging_config.network.body.request: true` and
`response: true`, which reads alarming: DOM masking does not apply to
network payloads, and `forms.js` submits by `fetch` rather than a native
POST, so the contact form's values cross the wire inside a request the SDK
could instrument.

Tested rather than assumed. Method: wrap `fetch`, `XMLHttpRequest.send` and
`navigator.sendBeacon` *before* consent so the SDKs' own transport is
captured, accept, then (a) fire URL-encoded POSTs carrying a sentinel to a
same-origin and a cross-origin endpoint, and (b) type a second sentinel into
the real contact form's name, email and message fields without submitting.
Force a flush, then gunzip every outbound body and search it.

Result, across 4 replay batches and ~13 KB of payload to `api-sr.amplitude.com`
and `api2.amplitude.com`:

| Checked | Found in payload |
|---|---|
| Sentinel in POST **body**, same-origin and cross-origin | no |
| Sentinel **request URL** | no |
| rrweb plugin/custom event types (where network capture would land) | no — only types 2 and 3, DOM snapshots |
| Text typed into the contact form's name / email / message | no |
| `form_start` / `form_submit` analytics events | yes, as intended |

So this SDK build does not act on those network flags — no bodies, no URLs,
nothing. Masking holds for the form fields as the consent notice claims, and
conversion events still fire.

Re-test if `plugin-session-replay-browser` is upgraded (pinned at 1.35.1) or
if the network logging config changes, since a negative here is a fact about
one SDK version, not a guarantee.

### Statsig and replay

Statsig loads the **core** `statsig-js-client` bundle (not `+web-analytics`).
That build has **no session replay and no autocapture**. Only Amplitude
records sessions; Statsig evaluates experiments and receives a small set of
Pulse conversion events. See [Architecture](#architecture) below.

## Consent

`consent.required` defaults to **true**: on a first visit, neither SDK is
fetched. A disclaimer appears at the bottom of the page and the visitor
chooses.

| | What happens |
|---|---|
| **Accept measurement** | Amplitude and Statsig load immediately, no reload |
| **No thanks** | Nothing is fetched, on this visit or any later one |
| Closed without choosing | Same as declining for that visit; asked again next time |

The answer is stored in `localStorage` under **`aq_consent_v1`** as
`{"state":"granted"\|"denied","at":"<ISO date>"}`. Not a cookie — declining
shouldn't create something that gets sent to a server on every request. It's
per browser and per device. If what the site collects ever changes
materially, **bump the key** (`aq_consent_v2`) and everyone is asked again
instead of being held to a stale answer.

Precedence, highest first:

1. **GPC / DNT** (`respect_dnt`) — no scripts, and no banner either; there's
   nothing to ask. The privacy page says so rather than showing buttons.
2. **No keys configured** — nothing to consent to.
3. **Stored choice.**
4. **Not asked yet** — banner, nothing loaded.

Setting `consent.required: false` restores load-on-arrival, with GPC/DNT as
the only gate. Only reasonable if legal advice says a banner isn't needed.

### Changing the answer later

- A **Tracking choice** button in the footer of every page reopens the
  banner. It's `hidden` in the markup and revealed by `analytics.js`, so it
  never appears when there's nothing to switch off.
- The privacy page has a panel showing the current state with both buttons.
- `window.aqConsent` exposes `state()`, `accept()`, `decline()`, `open()`.

Both are driven by `data-aq-consent="accept|decline|open"` attributes and a
single delegated click handler, so a link can be added anywhere in the
markup without touching the JS.

**The site ships two chromes.** The control one is in
`templates/base.html` (used by the control homepage, the control post page,
and every page with no variant at all); the fresh-take one is in
`templates/fresh-header.html` and `templates/fresh-footer.html`, which the
variant homepage, the fresh-take blog index and the fresh-take post page all
include. A site-wide
feature has to be in **both**, or half of the traffic silently loses it —
which is how the variant first shipped without the opt-out link.

`tools/build.py` refuses to build if either is missing one, via the
`SITE_WIDE` dict in `check_chrome()`. It checks the fresh-take chrome
assembled rather than as template source, so an include that stops being
included is caught too. Add to that dict when something else has to hold
across both:

```
build aborted: the fresh-take chrome is missing the tracking opt-out
control.
```

The banner itself is exempt — `analytics.js` injects it into `<body>` from
outside either layout, so it appears in both without duplication.

**Withdrawing reloads the page.** By then Session Replay is already
recording; `amplitude.setOptOut(true)` and `statsigClient.shutdown()` are
called first, but a reload is the only way to be certain nothing further is
captured.

### Effect on the fresh-take experiment

A visitor who hasn't accepted never loads Statsig, so they can't be bucketed
and always see the **control** homepage. That means the `homepage_fresh_take`
experiment only ever sees consenting traffic — expect it to run slower than
raw visitor numbers suggest, and read its result as applying to that
population.

Accepting part-way through a pageview is handled without a flicker: the page
is already showing control, so `analytics.js` reports `control` as the design
for that view rather than swapping the layout under the reader. The next
pageview buckets normally.

### The blog follows the same assignment, and logs no exposure

The fresh-take design covers the blog index and the post pages as well as the
homepage, so a reader given the fresh homepage doesn't then land on a
control-styled blog. Those pages read the same `homepage_fresh_take`
assignment — but ask for it with `{ disableExposureLog: true }`. Which page
is which comes from `data-page` on `<html>`: `home`, `blog` or `post`.

That is deliberate. The experiment's exposed population is people who saw the
homepage, and it has been running on that basis; adding everyone who arrives
straight onto a post from search, or onto the blog index from a link, would
change what the results mean halfway through. If you'd rather count them,
drop the option in `applyDesignExperiment()` — but restart the experiment,
don't read across the change.

Those pages report themselves with their own events instead.

### Architecture

**Amplitude owns product analytics. Statsig owns the experiment.** Sending
Statsig's product events into Amplitude (via the outgoing integration) on top
of the Amplitude SDK is what inflated charts — the same visit showed up as
`[Amplitude] Page Viewed`, `auto_capture::page_view`, and a dual-written
custom event.

| Concern | Who |
|---|---|
| Pageviews, sessions, forms, nav, likes, Session Replay | **Amplitude SDK** |
| Experiment assignment (`homepage_fresh_take`) | **Statsig SDK** |
| Pulse scorecard conversions | **Statsig `logEvent`** for a short allow-list only |
| Variant breakdown in Amplitude charts | **Statsig → Amplitude integration: exposures only** |

**Pulse events (also sent to Amplitude):** `hero_cta_clicked`,
`cta_clicked`, `connect_form_submitted`, `newsletter_subscribed`.

**Amplitude only:** `home_viewed` / `blog_viewed` / `post_viewed`,
`nav_link_clicked`, `post_liked` / `post_unliked`, plus Amplitude autocapture.

**Identity:** Statsig initializes first; Amplitude then inits with
`deviceId` set to Statsig's `stableID`, so forwarded exposures join the same
user as Replay and product events.

#### Statsig → Amplitude Event Filtering

Set on 2026-09-21 in
[Yosimy Test Project → Integrations → Amplitude](https://console.statsig.com/7mxCrruFNbq8sowJtiFrEu/integrations)
→ **Event Filtering**. The outgoing connection stays **enabled** (API key for
**AQ Career Site**); only exposures cross the wire:

| Setting | Value |
|---|---|
| Experiment exposures | on |
| Config exposures | on — this is what `homepage_fresh_take` emits (`statsig::config_exposure`) |
| Gate / layer / holdout / disabled exposures | off |
| First exposures | off (enterprise feature, not enabled here) |
| Send new events by default | **off** — this was forwarding every custom and `auto_capture::*` event |
| Enabled events | empty |

`Send new events by default` was the duplicate path: with it on, everything
the Statsig SDK logged was re-posted to Amplitude's Batch API alongside the
Amplitude SDK's own copy. With it off and the enabled-events list empty, no
product event forwards — a new Statsig event has to be opted in explicitly.

Config **change** events (console edits) are still forwarded. They're not
visitor traffic, so they don't inflate product charts; turn them off under
the same dialog if you'd rather keep Amplitude to user events only.

### Events this site logs

Beyond Amplitude's autocapture (pageviews, sessions, form start/submit, file
downloads, web vitals), these are logged by hand. Every one carries
`homepage_design`, so anything can be split by arm:

| Event | Where | Also carries | Destination |
|---|---|---|---|
| `home_viewed` | homepage, once assigned | | Amplitude |
| `blog_viewed` | blog index, once assigned | | Amplitude |
| `post_viewed` | post page, once assigned | `post` (the slug) | Amplitude |
| `nav_link_clicked` | any nav link, `[data-nav]` | `nav_item`, `nav_label`, `nav_location` | Amplitude |
| `hero_cta_clicked` | `[data-cta="hero"]` | | Amplitude + Statsig (Pulse) |
| `cta_clicked` | `[data-cta="primary"]` | | Amplitude + Statsig (Pulse) |
| `connect_form_submitted` | contact form, on success | | Amplitude + Statsig (Pulse) |
| `newsletter_subscribed` | memo form, on success | | Amplitude + Statsig (Pulse) |
| `post_liked` / `post_unliked` | the like button | `post` (the slug) | Amplitude |

Through 2026-09-18 every hand-logged event went to both SDKs, and Statsig
autocapture was on. That, plus the Statsig → Amplitude integration, duplicated
volume in Amplitude. As of the architecture above, only Pulse conversions
dual-write.

### Nav clicks

Amplitude's `elementInteractions` autocapture is **off** (see
`startAmplitude()`), and most nav links are same-page anchors, so clicking
**About** or **Services** on the homepage produced no event at all.
`nav_link_clicked` fills that gap. It carries:

| Property | Example | Notes |
|---|---|---|
| `nav_item` | `about` | The `data-nav` value. Stable — the grouping key to chart. |
| `nav_label` | `Services & Products` | The visible text. Reads well, but changes when the wording does. |
| `nav_location` | `header` / `footer` | Derived from the nearest `<header>`/`<footer>`, not a second attribute to keep in sync. |
| `homepage_design` | `fresh_take` | Omitted on pages outside the experiment — privacy, 404 — rather than guessed. |

Only site navigation carries `data-nav`: home, about, services, blog,
connect, privacy. Social and external links are left out.

**`about` only exists in the fresh-take chrome** — the control homepage has no
About section, so an empty `about` count for `homepage_design: control` is the
design, not a bug. `services` is in both, which is why that's the one
`SITE_WIDE` in `tools/build.py` checks for: a chrome that loses `data-nav`
goes silent while the other keeps reporting, and the breakdown then reads as a
design preference rather than a missing attribute.

Two things to know before charting it:

- **The fresh-take Connect link logs twice** — `cta_clicked` and
  `nav_link_clicked`. It is one link wearing both hats: `data-cta` for the
  experiment's CTA analysis, `data-nav` so the nav breakdown accounts for
  every item in the bar. Filter by one event or the other, never sum them.
- **A pinned Labs layout logs nothing**, the same as a pinned pageview. Turn
  Labs off with `?labs=0` to watch nav events fire.

The handler is delegated from `document`, not bound per link, so it covers
both chromes (the homepage ships each nav twice, one hidden by CSS) and pages
that never run the experiment, where `wireCtas()` is never reached. It is
attached from `startTracking()`, so a visitor who declined has no listener on
the page at all.

Links that leave the document — POV Blog, Privacy, any nav link followed from
a post page — get a `flush()` on both SDKs, because an event queued a moment
before unload is an event that may never be sent. Best-effort: the navigation
can still win the race, so expect nav clicks that navigate away to undercount
slightly against ones that stay put.

#### Verified, 2026-09-18

Served the built site locally, accepted the disclaimer, then clicked nav links
in both chromes and wrapped `amplitude.track` / `statsigClient.logEvent` to
watch the calls.

| Checked | Result |
|---|---|
| `nav_link_clicked` fires on header and footer links in both chromes | yes |
| Reaches **Amplitude** (`nav_link_clicked` is Amplitude-only) | yes |
| Properties correct (`nav_item`, `nav_label`, `nav_location`, `homepage_design`) | yes |
| Amplitude accepts it | `code: 200`, "Event tracked successfully" |
| Event carries `[Amplitude] Session Replay ID` — so it lands on the replay timeline | yes |
| Fires on the privacy page, which never runs the experiment | yes, with `homepage_design` absent |
| Suppressed while a Labs layout is pinned | yes |

### Likes

The fresh-take post page has a like button and the fresh-take blog index
shows a tally on each card; the control design has neither. This is a static
site with nowhere to POST a count to, so a like is remembered in the
visitor's own browser under **`aq_likes_v1`** (`{"<slug>":"<ISO date>"}`) and
nothing is shared between visitors.

**So read the card tally for what it is.** It counts what that browser has
liked — 1 or 0 per post, not a total across visitors. A visitor who has liked
nothing sees 0 everywhere. `tally()` in `assets/js/likes.js` is the single
place that number comes from; give it a real source and the cards, the markup
and the styling all stay as they are.

### The numbers on the blog index

The totals on the cards come from **`content/likes.json`** — a file of
`"<slug>": <count>` that the build renders into the page. They ship at zero,
because nothing has been counted yet.

**A GitHub Action keeps them up to date** —
`.github/workflows/refresh-likes.yml`, every Monday morning and on demand
from the Actions tab. It reads the counts from Amplitude, writes
`content/likes.json`, rebuilds the site and commits; Pages redeploys from
that commit. Nothing to do by hand once it's switched on.

### Switching it on

It needs two repository secrets, under **Settings → Secrets and variables →
Actions**:

| Secret | Value |
|---|---|
| `AMPLITUDE_API_KEY` | the AQ Career Site project's API key |
| `AMPLITUDE_SECRET_KEY` | that project's **secret** key |

Both come from Amplitude → Settings → Projects → *AQ Career Site* → API Keys.

**The secret key is not like the client key elsewhere in this document.** It's
a server credential that can read the whole project, and this repo is public.
It goes in a GitHub secret and nowhere else — never in `site.json`, never in
a file here, never in a commit. Until both secrets exist the job skips itself
each week with a notice rather than failing.

Then **Actions → Refresh like counts → Run workflow** to try it immediately.

### What it counts

Unique users who fired `post_liked` for each post, minus the unique users who
fired `post_unliked`, from the first post's date to today — the Dashboard
REST API's event segmentation endpoint, grouped by the `post` event property.

Uniques rather than event totals, so one person pressing the button twice is
one like. And the number is a **floor, not a census**: a visitor who declined
measurement still gets their like locally, it just never reaches Amplitude to
be counted. Expect the published figure to sit below reality by roughly
whatever share of visitors decline.

### By hand, or without the Action

`tools/refresh_likes.py` is the same script the workflow runs:

```bash
AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... python3 tools/refresh_likes.py
```

`--dry-run` prints what would change and writes nothing; `--start YYYYMMDD`
narrows the period. Then `python3 tools/build.py`, commit, push. Editing
`content/likes.json` by hand works too — the next run just overwrites it.

The build refuses anything but whole numbers of 0 or more, and warns about a
slug that doesn't match a post — a typo there would otherwise show zero
forever. A missing file is fine: every post shows zero.

Two things to know about the number a visitor actually sees. It is **as fresh
as the last export and deploy**, and it has **their own like added on top**,
so pressing the button moves it — which means their like can be counted twice
on their own screen once the next export includes it. The alternative was a
button that appears to do nothing.

**A live, always-accurate count** would need somewhere to store a per-post
tally and an endpoint to read and increment it, on one of the approved cloud
providers. That's a service to build, pay for and look after, and it would
collect something the site currently doesn't.

**Likes per post are also just a chart** — `post_liked` in Amplitude or
Statsig. That event is consent-gated like every other; the stored like itself
is not, since it never leaves the browser.

## Statsig Labs (switching layouts by hand)

Both designs ship in the same document — the homepage as two whole layouts,
the blog index and a post page as two sets of chrome around one shared body —
and Statsig decides which one you see. So checking the variant normally means hoping you were bucketed
into it, and accepting measurement first. Labs pins one instead.

It appears as a small **Statsig Labs** panel at the bottom-left of the
homepage, the blog index and any post page, with a Control / Fresh take
switch. Switching
is instant: both designs are already in the DOM and CSS decides which is
shown, so there is no reload and nothing to rebuild.

Turning it on:

| | |
|---|---|
| `localhost`, `127.0.0.1`, `*.local` | on automatically |
| `?labs=1` | on anywhere, remembered for that browser |
| `?labs=0` | off again, also remembered — this beats the automatic on, so it works on localhost too |
| `?design=fresh_take` / `?design=control` | pins a layout straight from the URL |

`?design=` is the shareable form: send someone a link to one arm and that is
what they get. The pin is resolved by the inline script in `templates/base.html`
before anything else loads, so the pinned layout paints first time with no
flash of the other one, and it works with measurement declined, with a DNT
signal, or with `analytics.js` blocked outright — which is exactly when you
want to look at a layout undisturbed.

Everywhere else it stays off, so a visitor never sees the panel — and there is
nothing in the page for them to find. No `<script>` tag for `labs.js` is built
into the HTML; the inline gate injects it, and only for a browser that has Labs
switched on. An ordinary visit downloads none of it and its markup carries no
reference to it.

It is invisible rather than secret, though: anyone who works out `?labs=1` can
switch it on for their own browser. That reveals nothing they couldn't already
get — both layouts ship in the homepage HTML either way, so the variant is
readable from the page source or reachable by editing `data-home-design` in
devtools — and because a pinned pageview logs nothing, someone doing it cannot
disturb the experiment's results.

### Getting the disclaimer back

The panel also shows what this browser answered to the measurement disclaimer —
accepted, declined, or not answered yet — with a **Reset it and show the
disclaimer** button beneath it. The button is disabled when there is no answer
stored, since there would be nothing to clear.

Reset forgets the answer and reloads the page, so what you get is a genuine
first visit: no SDK loaded, and the dialog's own "Nothing has loaded yet"
wording is actually true. Reopening it in place instead — which is what the
footer control does — would claim that while Amplitude and Session Replay were
already running.

It clears only the answer. Your Labs pin lives under a separate key, so
resetting the disclaimer does not cost you the layout you were looking at.

The work is `window.aqConsent.reset()` in `analytics.js`, not in the panel:
`STORE_KEY` is versioned on purpose, so bumping it keeps the button clearing
the right thing instead of silently clearing a key nobody uses any more. That
same call is the way to do it from the console.

**A pinned pageview records nothing.** `analytics.js` returns before it asks
Statsig for an assignment — asking would log an exposure for a variant nobody
was really bucketed into — and it logs no `home_viewed`, `blog_viewed`,
`post_viewed`, `nav_link_clicked` or CTA events either. A like still saves, since that is local state rather than
experiment data, but logs nothing.
So Labs is for looking at layouts, never for checking that tracking fires. To
test tracking, turn Labs off with `?labs=0` and let the real assignment run.

## Do Not Track / Global Privacy Control

With `respect_dnt: true` (the default), visitors whose browser sends Global
Privacy Control or Do Not Track get **no analytics scripts loaded at all** —
not loaded-then-disabled, and not even asked. Set it to `false` to fall back
to the consent banner for those visitors.

## Disclosure

Both pieces Amplitude's guidance asks for are in place: the recording is
disclosed on `/privacy/`, and consent is collected before anything loads.

What this does **not** settle is whether the banner is legally required for
this site — that depends on where her visitors are, and it's a question for
someone qualified to answer. EU/UK visitors generally need prior consent, and
Session Replay at `sample_rate: 1` is the strongest reason to assume they
might arrive. A US-only audience would be a weaker case, where honouring GPC
alone might have been enough.

## Versions

SDKs load from CDN, pinned to exact versions in `assets/js/analytics.js`:

| | Version |
|---|---|
| `@amplitude/analytics-browser` | 2.45.10 |
| `plugin-session-replay-browser` | 1.35.1 |
| `@statsig/js-client` | 3.33.5 (core `statsig-js-client.min.js`, not `+web-analytics`) |

Pinned rather than floating (`@2`) so a CDN-side release can't change the
site's behaviour without a commit here. Bump them deliberately.

Note the Amplitude analytics bundle used is the **analytics-only** build —
not the unified `cdn.amplitude.com/script/<KEY>.js`, which bundles Session
Replay and Web Experiment together and gives less control over the replay
configuration. Statsig is the core client only — no autocapture bundle — so
product analytics cannot double through the Statsig → Amplitude integration.

## Checking it works

Open the live site, **accept the disclaimer**, then in the browser console:

```js
window.aqConsent.state()  // "granted"
window.amplitude          // object
window.sessionReplay      // object, when replay is enabled
window.statsigClient      // object
```

All three are `undefined` before accepting — that's the gate working, not a
broken key. To get the banner back: `localStorage.removeItem('aq_consent_v1')`
and reload.

Events should appear in Amplitude within a minute or two. In Amplitude,
Session Replay sits alongside the event stream for the same user.
