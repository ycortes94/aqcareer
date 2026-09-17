# Connecting the forms

Two forms on the home page need somewhere to send submissions:

- the **Career Disruptor Memo** signup in the hero
- the **let's connect** contact form at the bottom

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

Save. This is the only place that address is stored.

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
permission to send email as you. Approve it. ("Anyone" means anyone can
*submit the form*; it does not let anyone read the script or the address.)

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

Open the live site, submit both forms, and confirm two emails arrive. The
contact form sets `reply-to` to the visitor's address, so replying in Gmail
goes straight back to them.

## Until step 5 is done

The forms stay visible but don't pretend to work. Submitting shows
*"This form isn't connected yet"* and points visitors to LinkedIn, rather
than silently swallowing the message.

## Spam handling

- Each form has a hidden **honeypot** field. Bots fill it; humans can't see
  it. Those submissions are dropped silently.
- The script checks the submission came from the site's own domain.
- Free Apps Script accounts can send roughly 100 emails a day, which is far
  above what this site will see. If spam ever becomes a problem, the next
  step is adding a CAPTCHA — worth doing only if it actually happens.

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
