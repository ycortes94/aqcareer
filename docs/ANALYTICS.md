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

As checked on 2026-09-17, this project's remote config
(`sr-client-cfg.amplitude.com/config/<key>?config_group=browser`) returned:

```json
"sr_privacy_config": { "maskSelector": [], "blockSelector": [],
                       "unmaskSelector": [], "defaultMaskLevel": "light" }
```

Mask levels, per Amplitude's documentation:

| Level | Masks |
|---|---|
| `light` | only a subset of sensitive inputs — passwords, credit card numbers, telephone numbers, email addresses |
| `medium` | all form fields and text inputs |
| `conservative` | all text and all form fields, including HTML text and links |

At `light`, the message textarea and the name fields would be recorded in
the clear. So protection here does not rely on configuration:

1. **`mask_forms: true`** (the default) makes the build add the
   **`amp-block`** class to both `<form>` elements. `amp-block` is read from
   the markup, so it replaces each form with a blank placeholder in the
   recording and a remote config change cannot switch it off. Trade-off: the
   form area shows as an empty box in replays. The analytics events
   (form start / form submit) are unaffected, so conversion is still
   measurable.
2. `maskSelector` is still passed from the SDK as a secondary layer, for the
   case where the remote config is later set to honour it.

Setting `mask_forms: false` removes the class and the selectors, leaving the
project's UI mask level as the only protection.

**Also worth doing in the Amplitude UI:** set this project's mask level to
`medium` or `conservative` under *Settings → Organizational Settings →
Session Replay Settings*. That covers text elsewhere on the site, not just
the two forms, and it's the setting that actually wins.

### Statsig and replay

Statsig loads the `statsig-js-client+web-analytics` bundle, which contains
**no session replay code at all** — verified: the string
`runStatsigSessionReplay` does not appear in it. Only one tool records
sessions, and its masking is configured above.

Statsig's autocapture also has form and input events filtered out before
logging (`eventFilterFunc` in `assets/js/analytics.js`), so field names and
typed content from those two forms don't reach Statsig either.

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

**The homepage ships two complete layouts**, each with its own header and
footer: `templates/base.html` (the control, and every other page on the site)
and `templates/home-fresh-take.html` (the variant). A site-wide feature has
to be in **both**, or half of the traffic silently loses it — which is how
the variant first shipped without the opt-out link.

`tools/build.py` now refuses to build if either layout is missing one, via
the `SITE_WIDE` dict in `check_chrome()`. Add to that dict when something
else has to hold across both:

```
build aborted: templates/home-fresh-take.html is missing the tracking
opt-out control.
```

The banner itself is exempt — `analytics.js` injects it into `<body>` from
outside either layout, so it appears in both without duplication.

**Withdrawing reloads the page.** By then Session Replay is already
recording; `amplitude.setOptOut(true)` and `statsigClient.shutdown()` are
called first, but a reload is the only way to be certain nothing further is
captured.

### Effect on the homepage experiment

A visitor who hasn't accepted never loads Statsig, so they can't be bucketed
and always see the **control** homepage. That means the `homepage_fresh_take`
experiment only ever sees consenting traffic — expect it to run slower than
raw visitor numbers suggest, and read its result as applying to that
population.

Accepting part-way through a pageview is handled without a flicker: the page
is already showing control, so `analytics.js` reports `control` as the design
for that view rather than swapping the layout under the reader. The next
pageview buckets normally.

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
| `@statsig/js-client` | 3.33.5 |

Pinned rather than floating (`@2`) so a CDN-side release can't change the
site's behaviour without a commit here. Bump them deliberately.

Note the Amplitude analytics bundle used is the **analytics-only** build —
not the unified `cdn.amplitude.com/script/<KEY>.js`, which bundles Session
Replay and Web Experiment together and gives less control over the replay
configuration.

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
