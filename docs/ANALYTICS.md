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
| Amplitude | **AQ Career Site** |
| Statsig | the Statsig project whose **client** key is in `site.json` |

Do not paste a key from a personal or shared test project — that silently
mixes this site's visitor traffic into someone else's analytics. Confirm the
project name in each console before committing a key. The Statsig key currently
configured is a `client-` key validated against Statsig's initialize endpoint.

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
   **`amp-block`** class to every `<form>` element. `amp-block` is read from
   the markup, so it replaces each form with a blank placeholder in the
   recording and a remote config change cannot switch it off. Trade-off: the
   form area shows as an empty box in replays. The analytics events
   (form start / form submit) are unaffected, so conversion is still
   measurable.
2. The project's own `defaultMaskLevel`, now `medium`, which also covers any
   text input added outside the forms. This is the setting that wins if
   the layers ever disagree, so re-check it before relying on it — it lives
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
| Pageviews, sessions, forms, clicks, likes, Session Replay | **Amplitude SDK** |
| Experiment assignment (`homepage_fresh_take`) | **Statsig SDK** |
| Pulse scorecard conversions | **Statsig `logEvent`** for a short allow-list only |
| Variant breakdown in Amplitude charts | **Statsig → Amplitude integration: exposures only** |

**Pulse events (also sent to Amplitude):** `hero_cta_clicked`,
`cta_clicked`, `connect_form_submitted`, `newsletter_subscribed`,
`waitlist_joined`.

**Amplitude only:** `home_viewed` / `blog_viewed` / `post_viewed`,
`element_clicked`, `nav_link_clicked`, `post_card_clicked`, `form_submitted`,
`waitlist_opened`, `post_liked` / `post_unliked`, plus Amplitude autocapture.

**Identity:** Statsig initializes first; Amplitude then inits with
`deviceId` set to Statsig's `stableID`, so forwarded exposures join the same
user as Replay and product events.

#### Statsig → Amplitude Event Filtering

Set on 2026-09-21 in the Statsig console under
**Project Settings → Integrations → Amplitude → Event Filtering**. The outgoing
connection stays **enabled** (API key for **AQ Career Site**); only exposures
cross the wire:

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
| `element_clicked` | any button or link with no more specific event | `element_type`, `element_text`, `element_id`, `element_location`, `link_type`, `link_url`, `page` | Amplitude |
| `nav_link_clicked` | any nav link, `[data-nav]` | `nav_item`, `nav_label`, `nav_location` | Amplitude |
| `post_card_clicked` | a card on the blog index | `post` (the slug), `post_title`, `card_position` | Amplitude |
| `hero_cta_clicked` | `[data-cta="hero"]` | | Amplitude + Statsig (Pulse) |
| `cta_clicked` | `[data-cta="primary"]` | | Amplitude + Statsig (Pulse) |
| `waitlist_opened` | the 2027 interest list dialog, when it opens | `source` (`link` / `hash`), `page` | Amplitude |
| `form_submitted` | any form, on a submit the browser accepted | `form` (`contact` / `newsletter` / `waitlist`), `page` | Amplitude |
| `connect_form_submitted` | contact form, on success | `page` | Amplitude + Statsig (Pulse) |
| `newsletter_subscribed` | either memo form, on success | `page` | Amplitude + Statsig (Pulse) |
| `waitlist_joined` | 2027 counseling interest form, on success | `page` | Amplitude + Statsig (Pulse) |
| `post_liked` / `post_unliked` | the like button | `post` (the slug) | Amplitude |

**The memo signup is on two pages, and `page` is how you tell them apart.**
It sits on the home page and again at the foot of the blog index, both
posting to the same list, both logging `newsletter_subscribed`. `page` is
`home` or `blog`, derived from `data-page` on `<html>` exactly as
`element_clicked`'s is, so the conversion can be read per surface or as one
total.

Worth knowing before reading the experiment: `newsletter_subscribed` is a
Pulse conversion, so the blog index is now a **second way for an exposed
visitor to convert** on that metric. Someone who saw the homepage, went to
the blog and subscribed there counts. That is a genuine conversion rather
than a measurement error, but it means the metric changed meaning on the day
the blog form shipped — compare periods across that date with care, and split
by `page` if you want the homepage-only number the earlier data represents.

Through 2026-09-18 every hand-logged event went to both SDKs, and Statsig
autocapture was on. That, plus the Statsig → Amplitude integration, duplicated
volume in Amplitude. As of the architecture above, only Pulse conversions
dual-write.

### Nothing logged before Amplitude exists

Worth knowing, because it silently cost this site every design pageview it
ever recorded. `startTracking()` loads **Statsig first**, so Amplitude can
take Statsig's `stableID` as its `deviceId`; the `*_viewed` events fire the
moment the assignment lands, which is a beat *before* Amplitude is fetched.
Sent straight through, they found `window.amplitude` undefined and vanished.
`home_viewed`, `blog_viewed` and `post_viewed` were in the code, in the docs
and in nobody's Amplitude project.

`trackAmplitude()` now holds events in a bounded queue until the SDK is
there, and flushes once `startAmplitude()` has settled — either way, so a
blocked CDN empties the queue instead of filling it for the whole session.
Anything logged from a click is long past this and goes straight out.

**So an empty `home_viewed` before 2026-09-21 is the bug, not the traffic.**
Charts that used those events to split the experiment by arm have no data to
read before that date; the exposures Statsig forwarded are unaffected.

### Clicks

Amplitude's `elementInteractions` autocapture is **off** (see
`startAmplitude()`), so a control logs nothing unless `analytics.js` logs it.
Until 2026-09-21 that meant two named events — the hero CTA and the nav links
— and a site where everything else was silent: the testimonial arrows and
dots, the burger menu, the post cards on the blog index, the links at the
foot of an article, the social icons. A session replay showed the visitor
clicking and the event stream showed nothing.

One delegated listener on `document` now covers all of it, and **one click
produces one event** — the most specific one that fits:

| Clicked | Event |
|---|---|
| A nav link (`[data-nav]`) | `nav_link_clicked` |
| A CTA (`[data-cta]`) | `hero_cta_clicked` / `cta_clicked` |
| A post card on the blog index | `post_card_clicked` |
| A control that owns its event — the like button, the form submit buttons | that control's event, nothing else |
| The consent buttons, the Labs panel | nothing: measurement UI and development furniture, not the site |
| **Anything else clickable** — buttons, links, `[role="button"]` | `element_clicked` |

`element_clicked` is the catch-all, so a control added later reports itself
without anyone remembering to wire it up:

| Property | Example | Notes |
|---|---|---|
| `element_type` | `button` / `link` | |
| `element_text` | `Next testimonial` | `aria-label` first — the carousel arrows and social icons have no text at all — then the visible text, capped at 80 characters. |
| `element_id` | `memo-email` | Empty for most things; the stable handle where there is one. |
| `element_location` | `header` / `footer` / `page` | Nearest `<header>`/`<footer>`, same derivation as `nav_location`. |
| `link_type` | `internal` / `external` / `anchor` / `email` / `phone` | Links only. `anchor` is a same-page jump. |
| `link_url` | `../../blog/` | Links only, as written in the markup. |
| `page` | `home` / `blog` / `post` / `other` | `data-page` on `<html>`; `other` is privacy and 404, which carry none. |

`nav_link_clicked` still carries what it always did:

| Property | Example | Notes |
|---|---|---|
| `nav_item` | `about` | The `data-nav` value. Stable — the grouping key to chart. |
| `nav_label` | `Services & Products` | The visible text. Reads well, but changes when the wording does. |
| `nav_location` | `header` / `footer` | Derived from the nearest `<header>`/`<footer>`, not a second attribute to keep in sync. |
| `homepage_design` | `fresh_take` | On every event above. Omitted on pages outside the experiment — privacy, 404 — rather than guessed. |
| `labs_pinned` | `true` | Only present when a Labs layout is pinned; absent for every real visitor. Exclude it when charting. |

Only site navigation carries `data-nav`: home, about, services, blog,
connect, privacy. Social and external links are left out — they are
`element_clicked` instead, which is where to look for them.

**`about` only exists in the fresh-take chrome** — the control homepage has no
About section, so an empty `about` count for `homepage_design: control` is the
design, not a bug. `services` is in both, which is why that's the one
`SITE_WIDE` in `tools/build.py` checks for: a chrome that loses `data-nav`
goes silent while the other keeps reporting, and the breakdown then reads as a
design preference rather than a missing attribute.

Three things to know before charting any of it:

- **The fresh-take Connect link logs twice** — `cta_clicked` and
  `nav_link_clicked`. It is one link wearing both hats: `data-cta` for the
  experiment's CTA analysis, `data-nav` so the nav breakdown accounts for
  every item in the bar. Filter by one event or the other, never sum them.
  It is the only overlap; everything else logs once.
- **`element_clicked` is a mixed bag by design.** It is one event covering
  every unnamed control, so chart it broken down by `element_text` or
  `element_id` rather than as a total. Anything worth watching on its own
  deserves its own event — add it above the catch-all in `onClick()`.
- **A pinned Labs layout carries `labs_pinned: true`.** Those clicks are
  someone checking a layout, so exclude them from anything meant to describe
  real visitors. Statsig gets none of them.

The handler is delegated from `document`, not bound per node, so it covers
both chromes (the homepage ships each nav twice, one hidden by CSS), pages
that never run the experiment — privacy, 404 — and controls rendered later,
such as the carousel's own dots. It is attached from `startTracking()`, so a
visitor who declined has no listener on the page at all.

Clicks that leave the document — POV Blog, Privacy, a post card, any link
followed from a post page — get a `flush()` on both SDKs, because an event
queued a moment before unload is an event that may never be sent.
Best-effort: the navigation can still win the race, so expect clicks that
navigate away to undercount slightly against ones that stay put.

#### Verified, 2026-09-21

Served the built site locally with the upload endpoints blocked in devtools
(so the test never reached the real project), accepted the disclaimer, then
clicked through both chromes with `amplitude.track` /
`statsigClient.logEvent` wrapped to watch the calls, and gunzipped the
outgoing payload to confirm what actually left the browser.

| Checked | Result |
|---|---|
| `blog_viewed` reaches the upload payload rather than being dropped | yes — this is the queue fix; before it, the payload held only `[Amplitude] Page Viewed` |
| Carousel arrows, carousel dots, burger menu | `element_clicked`, with `aria-label` as the text |
| Footer social icons | `element_clicked`, `link_type: external` |
| A blog index card | `post_card_clicked`, with the slug, title and position |
| A post's "← All posts" link | `element_clicked`, `link_type: internal` |
| Nav links, header and footer, both chromes | `nav_link_clicked`, properties unchanged |
| Hero CTA | `hero_cta_clicked` only — no duplicate `element_clicked` |
| Subscribe / Submit | `form_submitted` only — no duplicate `element_clicked` |
| The like button | `post_liked` only |
| "Tracking choice" and the consent buttons | nothing, as intended |
| Fires on the privacy page, which never runs the experiment | yes, with `homepage_design` absent |
| Suppressed while a Labs layout is pinned | no longer — see below |

#### Verified, 2026-09-21 — the fresh-take chrome and pinned sessions

The fresh-take arm had never logged a single event, and the reason was not the
tracking: `homepage_fresh_take` is **`assignment_stopped`** in Statsig, so
`getExperiment()` answers `ruleID: assignmentPaused` with no
`homepage_design` parameter at all and every visitor falls back to the
`control` default. Nobody has been served the variant, so nothing could have
reported it. The instrumentation was fine and had no traffic.

Checked against the real project from `?design=fresh_take` on the local build:

| Checked | Result |
|---|---|
| Fresh-take carousel arrow | `element_clicked`, `homepage_design: fresh_take`, `labs_pinned: true` |
| Fresh-take header nav | `nav_link_clicked`, `nav_item: services`, `nav_location: header` |
| All three fresh-take CTAs | `hero_cta_clicked` and `cta_clicked`; the Connect link also `nav_link_clicked`, the documented overlap |
| Newsletter submit | `form_submitted`, `form: newsletter`, `labs_pinned: true` |
| What Statsig received from any of it | nothing — `logEvent` wrapped and never called |
| `labs_pinned` arriving in the project | yes, on `home_viewed`, `element_clicked`, `nav_link_clicked`, `cta_clicked`, `hero_cta_clicked`, `form_submitted` |

The blog index has a memo form of its own, `#blog-memo-form`. Only one copy
of it ships, restyled per design rather than duplicated, so there is no
hidden twin to catch you out there.

The homepage ships both newsletter forms — `#memo-form` for the control and
`#ft-memo-form` for the variant — so a submit test that reaches for
`#memo-form` on a fresh-take page drives the hidden one and appears to log
nothing. Target the visible form.

### Likes

The fresh-take post page has a like button and the fresh-take blog index
shows a tally on each card; the control design has neither. This is a static
site with nowhere to POST a count to, so a like is remembered in the
visitor's own browser under **`aq_likes_v1`** (`{"<slug>":"<ISO date>"}`) and
nothing is shared between visitors.

**No `post_liked` has ever been logged, and that is the experiment, not the
button.** The bar is built as `ft-only` (`LIKE_BAR` in `tools/build.py`), so
only a visitor served the fresh-take arm can see it — and
`homepage_fresh_take` has been `assignment_stopped` in Statsig, which hands
every visitor the `control` default. Nobody has been given the layout the
button lives on. Restart assignment and the events start arriving on their
own; nothing in `likes.js` needs changing for that.

Until then the only way to reach the button is to pin the layout in Labs, so
those presses log with `labs_pinned: true` and the weekly export filters them
out rather than publishing development likes as reader likes.

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

With one limit: that endpoint answers **36 months** of monthly counts and
refuses a wider range with a 400, and the blog is older than that, so the
start is moved forward to fit. The run says so when it does. Nothing is lost
today — the like button shipped in September 2026 — but a like older than
36 months would eventually fall out of the total.

Uniques rather than event totals, so one person pressing the button twice is
one like. And the number is a **floor, not a census**: a visitor who declined
measurement still gets their like locally, it just never reaches Amplitude to
be counted. Expect the published figure to sit below reality by roughly
whatever share of visitors decline.

Presses made while a Labs layout was pinned are filtered out, with
`labs_pinned is not true` on both queries. The like button ships on the
fresh-take post page only, so pinning is how anyone working on that layout
reaches it, and their presses are development rather than readers. `is not`
keeps events where the property is unset, which is every real visitor —
checked against the project on 2026-09-21, where 5 `element_clicked` split
into 4 unset and 1 pinned.

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
devtools — and because a pinned session is kept out of Statsig altogether and
stamped `labs_pinned` in Amplitude, someone doing it cannot disturb the
experiment's results.

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

### A pinned session logs, and says so

**Statsig sees nothing from a pinned pageview.** `analytics.js` returns before
it asks for an assignment — asking would log an exposure for a variant nobody
was really bucketed into — and `logEvent()` skips the Pulse conversions
entirely while pinned, so the experiment's scorecards cannot be moved by
someone looking at a layout.

**Amplitude does see it, stamped `labs_pinned: true`.** Pinned sessions used
to log nothing at all, and that made the panel useless for the one question
people kept asking of it — *does the fresh-take markup fire anything?* The
only way to see that layout is to pin it, and pinning switched the logging
off, so the honest answer looked identical to a bug. Now the events arrive
and can be watched landing in the Amplitude Event Explorer while a layout is
being built.

The cost is that `labs_pinned` has to be excluded anywhere real visitors are
being counted. It is on every event from a pinned session — the `_viewed`
events, every click event, `form_submitted` and the form conversions — so one
filter covers all of them.

`homepage_design` on those events is the pinned design, not the arm this
pageview started in. Pinning is an attribute flip with no reload, so
`designNow()` reads the pin first; without that a click made after pinning
fresh take reported `control`.

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
