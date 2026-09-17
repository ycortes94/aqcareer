# Analytics

Amplitude and Statsig are wired in but **switched off** until keys are set.
With no keys in `site.json`, the build emits no third-party scripts at all.

## Turning it on

Put the two client keys in `site.json`:

```json
"analytics": {
  "amplitude_api_key": "<Amplitude API key>",
  "statsig_client_key": "client-…",
  "session_replay": { "enabled": true, "sample_rate": 1, "mask_forms": true },
  "respect_dnt": true
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

Both keys must come from projects that are meant to hold this site's data.
Check before pasting — a key from an unrelated or shared project silently
mixes a personal website's visitor traffic into someone else's analytics.

## Session Replay

Enabled by default, recording every session (`sample_rate: 1` = 100%). Lower
it to e.g. `0.2` for a fifth of sessions if volume ever matters.

### What's masked

This site's contact form collects a name, an email address, and a free-text
message to a career counselor. That's exactly the kind of content that should
never end up in a replay, so masking is layered:

1. **Amplitude masks all text inputs by default.** Typed characters are
   replaced with asterisks in the recording. This is SDK behaviour, not
   something this repo turns on — and nothing here ever adds `.amp-unmask`,
   which is what would switch it off.
2. **`mask_forms: true`** additionally passes both form blocks
   (`#memo-form` and `form.contact`) as `maskSelector`, so the surrounding
   text and the message textarea are masked too, not just the inputs.

Setting `mask_forms: false` drops layer 2 only. Layer 1 still applies, so
typed input stays masked either way.

To mask something else later, add `.amp-mask` to the element (masks its
text) or `.amp-block` (replaces it with a blank placeholder of the same
size).

### Statsig and replay

Statsig loads the `statsig-js-client+web-analytics` bundle, which contains
**no session replay code at all** — verified: the string
`runStatsigSessionReplay` does not appear in it. Only one tool records
sessions, and its masking is configured above.

Statsig's autocapture also has form and input events filtered out before
logging (`eventFilterFunc` in `assets/js/analytics.js`), so field names and
typed content from those two forms don't reach Statsig either.

## Do Not Track / Global Privacy Control

With `respect_dnt: true` (the default), visitors whose browser sends Global
Privacy Control or Do Not Track get **no analytics scripts loaded at all** —
not loaded-then-disabled. Set it to `false` to track everyone.

## Still needed: a privacy notice

Session Replay records how visitors move through the site. Amplitude's own
guidance is that you must disclose that recording in a privacy policy, and
collect consent where local law requires it. There is **no privacy page on
this site yet**, and no consent banner.

Worth deciding deliberately:

- A short privacy page covering analytics, replay, and what the forms collect
  is the minimum, and is quick to add.
- A consent banner is a separate question. It's generally required before
  loading analytics for EU/UK visitors; her blog could plausibly reach them.
  A US-only audience is a weaker case, and honouring GPC (above) already
  covers California's opt-out signal.

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

Open the live site, then in the browser console:

```js
window.amplitude          // object
window.sessionReplay      // object, when replay is enabled
window.statsigClient      // object
```

Events should appear in Amplitude within a minute or two. In Amplitude,
Session Replay sits alongside the event stream for the same user.
