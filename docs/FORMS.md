# Connecting the forms

Four forms need somewhere to send submissions — three on the home page:

- the **Career Disruptor Memo** signup
- the **2027 career counseling interest list**, which opens as a dialog from
  the Career Counseling service (see `assets/js/waitlist.js`)
- the **let's connect** contact form at the bottom

and one at the foot of the blog index:

- the **Career Disruptor Memo** signup again, the same list and the same
  endpoint, asked of readers who reached the end of the post list

A GitHub Pages site is static — it can't send email by itself. The handler is
a small Google Apps Script web app that runs on Alina's own Google account:
free, nothing to maintain, and no new service to sign up for.

> **The destination email address never goes in this repository.** The repo is
> public. The address is stored as a Script Property inside the Apps Script
> editor, which only she can see. `tools/form-endpoint.gs` reads it at runtime.

## One-time setup

**1. Create the script**

Go to <https://script.google.com>, signed in as the account that should
*receive* the emails, and click **New project**. Name it something like
`aqcareer.com forms`.

**2. Paste the code**

Delete the contents of `Code.gs` and paste in all of
[`tools/form-endpoint.gs`](../tools/form-endpoint.gs). Save.

**3. Set the destination address**

Click the gear (**Project Settings**) in the left sidebar, scroll to
**Script Properties**, and click **Add script property**:

| Property | Value |
|---|---|
| `RECIPIENT` | the address that should receive submissions |
| `TURNSTILE_SECRET` | the Turnstile **secret** key from Cloudflare (not the site key) |

Save. This is the only place those values are stored. The site key is public
and lives in `site.json`; the secret must never go in this repository.

*Optional:* to also log every submission to a spreadsheet as a backup, create
a Google Sheet, copy the long ID out of its URL, and add a second property
`SHEET_ID` with that value.

**4. Deploy it**

**Deploy** → **New deployment** → gear icon → **Web app**, then set:

| Field | Value |
|---|---|
| Description | `forms` |
| Execute as | **Me** |
| Who has access | **Anyone** |

Click **Deploy**. Google will ask you to authorize the script — it needs
permission to send email as you, and (once Turnstile is on) to fetch
Cloudflare's verification URL. Approve it. ("Anyone" means anyone can
*submit the form*; it does not let anyone read the script or the secrets.)

Copy the **Web app URL**. It looks like:

```
https://script.google.com/macros/s/AKfycb..…/exec
```

**5. Point the site at it**

Put that URL in `site.json`:

```json
"form_endpoint": "https://script.google.com/macros/s/AKfycb..…/exec"
```

Then rebuild and push:

```bash
python3 tools/build.py && git add -A && git commit -m "Connect forms" && git push
```

**6. Test it**

Open the live site, submit each form, and confirm an email arrives for every
one — including the memo signup on `/blog/`, which posts to the same endpoint
as the home page's but is a separate form that can break on its own. The
contact form sets `reply-to` to the visitor's address, so replying in Gmail
goes straight back to them.

## Until step 5 is done

The forms stay visible but don't pretend to work. Submitting shows
*"This form isn't connected yet"* and points visitors to LinkedIn, rather
than silently swallowing the message.

## Spam handling

The endpoint is public — GitHub Pages cannot hide it — so the script has to
decide what to drop:

- Each form has a hidden **honeypot** field. Bots fill it; humans can't see
  it. Those submissions are dropped silently.
- The script checks the submission came from the site's own domain (when
  JavaScript sent an `origin`).
- JavaScript also sends `loaded_at`. A POST that arrives in under two seconds
  is treated as a bot. Visitors without JavaScript skip this check.
- Fields are length-capped (email 254, names 80, message 4000).
- Rate limits: 3 submissions per email per hour, and 20 across the whole
  site per hour. Extra attempts get a polite error, not an email.
- **Cloudflare Turnstile** issues a one-time token in the browser. The
  script asks Cloudflare whether that token is real before it sends any
  email. Direct POSTs to the `/exec` URL without a token are dropped.
- Free Apps Script accounts can send roughly 100 emails a day. These limits
  sit well below that.

The Turnstile **site key** is in `site.json`. The **secret key** is a Script
Property named `TURNSTILE_SECRET`. After changing the Apps Script, deploy a
new version of the existing web app so the live endpoint picks it up.

## Changing the address later

Edit the `RECIPIENT` script property in Project Settings. No code change,
no rebuild, no redeploy needed.

## If submissions stop arriving

1. In the Apps Script editor, open **Executions** in the left sidebar — it
   logs every call and any error.
2. Check the receiving account's spam folder.
3. If the browser console shows a CORS error, redeploy and confirm
   **Who has access** is still **Anyone**.
4. Re-deploying after editing the code creates a *new* URL unless you choose
   **Manage deployments** → edit the existing one. If you create a new URL,
   update `site.json` to match.
