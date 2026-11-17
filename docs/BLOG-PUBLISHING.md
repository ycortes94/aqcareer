# Google Docs blog publishing

Google account owner: **aalinaquintana@gmail.com**.

## Writing a post

1. Open [the template](https://docs.google.com/document/d/1NbqB82lQvIX885Uy2CCt224Uctw8-Fkr5OSwPOlqWN0/edit)
   in [Edits](https://drive.google.com/drive/u/1/folders/1r_6SLeOn5SNHZBbR_huN1tVRqshlXKl5).
2. Choose **File → Make a copy**, save the copy in Edits and rename it.
3. Fill in Title, Author and Date (YYYY-MM-DD). Leave Slug blank to derive
   the URL from the title. Use Slug only to choose a different URL before the
   first publication; existing article URLs stay fixed.
4. Replace the sample content between the **POST START** and **POST END**
   paragraphs. Keep those two marker paragraphs. Delete unused sample sections.
   Instructions outside the markers are excluded from the article.
5. Move the finished copy into [Ready to Publish](https://drive.google.com/drive/u/1/folders/1590gkaYbSf6zlzrt879OydfTT5Yywlu1).
   **Once activated, moving a document here approves publishing its content
   and images to the public website and public GitHub repository.**
6. After a successful deployment, it moves to [Published](https://drive.google.com/drive/u/1/folders/17Nmyo-SGbckB9BzK93Y7srie4zdVYXN7).

To revise an article, move the same document from Published to Edits, make
changes, then move it back to Ready to Publish. Do not make a new copy for a
revision. Edits and Published are never scanned for new changes. Deleting or
moving a document does not remove its published article; unpublishing requires
a deliberate removal of its saved snapshot from the content branch.

Supported: paragraphs, headings, bold, italic, strikethrough, web/email links,
bulleted and numbered lists, nested lists, and inline images. The first article
image is also the cover; it remains in the article at its insertion point.
Add alt text through Google Docs' image options. Images are saved on the site,
resized to fit 1800 × 1800 and converted to JPEG. Transparent/animated images
are not preserved. Avoid tables, drawings, floating images, footnotes, chips,
and multiple document tabs. Resolve suggested edits before publishing.

Future dates stay queued until that date in America/Los_Angeles. The scheduled
blog check runs once a day at 16:07 UTC (8:07 a.m. Pacific Standard Time /
9:07 a.m. Pacific Daylight Time); GitHub may delay scheduled runs. For an
immediate run, use GitHub Actions → **Publish site and blog** → **Run workflow**.
Main-branch updates also check for approved posts. The weekly likes-only
schedule does not import new posts.
GitHub can disable scheduled workflows in inactive public repositories after
60 days. Check Actions if automatic publishing stops; a manual run is available.

## Activation (not enabled by adding these files)

1. In Google Cloud, sign in as **aalinaquintana@gmail.com**. Create a dedicated
   project and enable **Google Drive API** and **Google Docs API**. No paid
   compute service or hosting plan is used.
2. Create a dedicated service account, e.g. `aqcareer-blog-publisher`. It needs
   no project-level IAM roles or domain-wide delegation. Give its email Viewer
   access to the [AQ Career Blog Posts folder](https://drive.google.com/drive/u/1/folders/1QYAWVbHdrbunDzy3lP1EzihxZ2zVDJGY),
   then Editor access on **only Ready to Publish and Published**. Drafts in
   Edits remain read-only. Google Drive's Editor role allows changing and
   removing items inside those two publishing folders; it is needed to move
   successful documents from the queue into Published. The renderer requests
   suggestions inline to reject unresolved suggestions, which also requires
   Editor access on queued documents.
3. Store the service account JSON as the GitHub Actions secret
   `GOOGLE_BLOG_SERVICE_ACCOUNT_JSON` in `ycortes94/aqcareer`. Keep the JSON out
   of chat, Git, and shared Drive folders. The importer requires a service
   account, so the Drive scope is limited by that account's folder access;
   it does not authorize access to Alina's entire personal Drive.
4. Merge the implementation into main through the existing protected-branch
   review flow. GitHub Pages must use **GitHub Actions** as its source.
5. Set repository variable `BLOG_PUBLISHING_ENABLED` to `true` only once
   credentials and folder sharing are ready. Allow the workflow token to
   write the `codex/blog-content` branch; main remains protected.
6. Run the workflow with an empty Ready to Publish folder to verify access,
   the build and deployment. Then test a completed, intentionally public
   article. Confirm its page, list entry, feed, images and move to Published.

The connected Drive plugin and browser session are not credentials for a
scheduled GitHub runner. This separate connection is required for unattended
publishing. Revoke the key and folder sharing if the integration is retired.

## How it works

The existing `refresh-likes.yml` is the single Pages publisher. It restores
snapshots from the data-only `codex/blog-content` branch on every deployment,
including ordinary main-branch code updates. With the feature enabled, it
imports approved Google Docs, validates and builds, saves snapshots to the
content branch, deploys Pages, then acknowledges publication by moving docs.
The content branch also preserves the last refreshed like totals, so a blog
deployment does not reset them to the older totals checked into main.

Snapshots are immutable with respect to draft edits. Each is keyed by the
Google document ID and contains metadata, sanitized article HTML and the
imported modification timestamp. Images use content hashes and local paths.
Instructions, temporary signed image URLs, comments and API credentials are
not saved. No code is executed from the content branch.

The whole import batch must validate before snapshots are written. A failed
build or deployment leaves the current live site and Ready folder intact.
Snapshots saved before a failed deployment are reused on retry. If a document
changes during import, the run stops. If it changes after import, the imported
version can still deploy, but the newer document stays queued and is not
archived; the next run imports the revision. Avoid editing queued documents.

Disabling the feature variable stops new imports but still restores existing
snapshots, preserving published articles on later deployments. Removing the
credential while leaving the feature enabled fails the deployment rather than
silently publishing an incomplete blog.

## Local checks and preview

```sh
python3 tools/test_drive_blog.py
sh tools/check.sh
```

For a preview including already published Drive posts:

```sh
python3 tools/drive_blog.py restore
python3 tools/build.py
```

To test an import locally, supply `GOOGLE_BLOG_SERVICE_ACCOUNT_JSON` through a
private environment and run `.tools/uv run --frozen python tools/drive_blog.py sync`.
This writes local snapshots only. It does not publish or move documents.
Do not run `save` or `acknowledge` for a preview; those are workflow steps.

Use `.tools/uv sync --frozen` for dependencies. Do not commit the ignored local
snapshot directories or `_blog-*` bookkeeping files to main. To undo a public
article, remove its snapshot on the content branch and trigger a clean Pages
deployment; repository history retains previously published content.
