# Connecting the forms

## Newsletter delivery through Kit

The Career Disruptor Memo uses Kit form `10080050` (Career Disruptor Memo —
Website). After the existing Apps Script spam/consent checks and backup delivery
succeed, the browser posts only `email_address` to Kit's public HTML form action.
The request asks for JSON, so visitors stay on the page and see an inline
confirmation prompt only after Kit reports success. Kit emails a confirmation link. Send confirmation
email is enabled and Auto-confirm new subscribers is disabled. Contact and
counseling-interest submissions continue to use Google only.

`newsletter_signup_requested` records the handoff, not confirmation or delivery.
Use Kit's subscriber status to verify a completed opt-in. Do not manually add
the emailed signup request as an already-confirmed subscriber. The CSP allows
fetch requests to `https://app.kit.com`; no Kit API key is stored on the site.


Five forms need somewhere to send submissions — three on the home page:

- the **Career Disruptor Memo** signup
- the **2027 career counseling interest list**, which opens as a dialog from
  the Career Counseling service (see `assets/js/waitlist.js`)
- the **let's connect** contact form at the bottom

one at the foot of the blog index:

- the **Career Disruptor Memo** signup again, the same list and the same
  endpoint, asked of readers who reached the end of the post list

and one on every post page:

- the **Career Disruptor Memo** signup once more, as a dialog opened by a
  Subscribe button in the body of a post (the same dialog machinery as the
  interest list). Only posts whose body carries the button offer it; see
  `content/posts/_TEMPLATE.html` for the markup.

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

To save to a second account as well, create a Sheet in that account with the
same ten columns (Sent, Form, Email, First name, Last name, Message, Consent,
Organization, Inquiry type, Consent policy version). Share it with the account running the script as
an **Editor**. Keep `SHEET_ID` and add `SHEET_IDS` containing the additional
spreadsheet ID, or several IDs separated by commas. IDs are deduplicated.
Deploy the updated `tools/form-endpoint.gs` as a new version of the existing
web app. Each Sheet is attempted independently, before email, so a full
account cannot stop the other Sheet receiving submissions. Run
`testSpreadsheetDelivery` in the script editor to append labeled test rows
without emailing anyone. Inspect its execution log and each Sheet afterward.
The form reports success only if at least one Sheet or the email succeeds;
individual destination errors are recorded in Apps Script Executions.

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
one — including the memo signup on `/blog/` and the Subscribe dialog on a
post page, which post to the same endpoint as the home page's but are
separate forms that can break on their own. The
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
  it. Those submissions are dropped — the bot is answered with the same
  success it would get for a real submission, so it doesn't retry, but no
  email is sent. The reply carries `skipped: "honeypot"`, which tells the
  page not to log a conversion event for it.
- A submitted `origin` is checked for consistency, but can be forged or omitted.
  The mandatory Turnstile hostname/action checks provide the bot-token binding.
- JavaScript also sends `loaded_at`. A POST that arrives in under two seconds
  is treated as a bot. Timing is a hint, not proof that a sender is human.
- Fields are length-capped (email 254, names 80, message 4000).
- Rate limits: 3 submissions per email and 20 across the whole site per fixed
  UTC clock hour. Counters live in Script Properties under `AQ_RATE_WINDOW`
  and are updated under a script lock. Only email hashes are stored in that
  bounded record; it is replaced in the next hour. Lock/storage failure rejects
  the submission. These limits protect quotas but a determined sender with
  valid tokens can still exhaust the shared site allowance.
- **Cloudflare Turnstile** issues a one-time token in the browser. The
  script asks Cloudflare whether that token is real before it sends any
  email. Direct POSTs to the `/exec` URL without a token are rejected.
  A missing `TURNSTILE_SECRET` also rejects submissions. Successful tokens must
  carry hostname `www.aqcareer.com` or `aqcareer.com` and action `aq_form`.
- Memo and waitlist submissions require the exact consent value `yes` on the
  server; the policy version is stored in the tenth spreadsheet column.
- Spreadsheet formula prefixes are escaped to store visitor values as text.
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

## Security release activation

Deploy the matching frontend and Apps Script together: the frontend now sends
Turnstile action `aq_form`, and the backend requires it. A mismatched release
will reject forms. In a separate test deployment, verify both destinations,
consent rejection and formula text handling before updating production.

1. Confirm `RECIPIENT`, `TURNSTILE_SECRET`, `SHEET_ID` / `SHEET_IDS` and the
   widget's hostname allowlist. Never paste those secrets into GitHub.
2. Append the **Consent policy version** column to every destination Sheet.
   Manually send harmless `=1+1` to a test Sheet through the test handler and
   confirm it displays literally and has no formula.
3. Deploy this file as a new version of the existing Apps Script web app.
   Its GET response identifies `2026-10-16-security-1`. Record the Apps Script
   deployment/version ID and corresponding Git commit privately.
4. Publish the matching static site, then send one labeled inquiry and signup
   and verify delivery in each configured destination. Do not subscribe the
   test address to the live mailing list. The regression suite sends no mail.
5. Enable email ownership confirmation in the actual mailing platform before
   activating subscribers; this form handler only records signup requests.

JavaScript is required for Turnstile; without it, the server rejects the form.
The pages provide LinkedIn as an alternate contact route.
