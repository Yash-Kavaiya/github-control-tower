# GitHub Control Tower

Clasp project for the **GitHub Control Tower** web app bound to the spreadsheet **Yash GitHub Review Board**.

| | |
| --- | --- |
| Spreadsheet | `1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w` |
| Bound Apps Script | `19UqmybsrjYhamFM6wiIfawBXI2lxnMrctfYHg6Urwp1UB0oo6mqwDtnA` |
| Source | [Yash-Kavaiya/github-control-tower](https://github.com/Yash-Kavaiya/github-control-tower) |

The live runtime is Google Apps Script. `clasp push` uploads the `.gs` and `.html` files. A local preview server only renders the UI with sample rows so the layout can be reviewed without the sheet.

## What it does

- **Overview** reads Full Inventory (header row 4, data from row 5) and shows total, P1/P2/P3, NVIDIA, Google Cloud, deployed, average production relevance score, and CI coverage. Rows 1–3 are the KPI banner and are never written.
- **Inventory** searches and filters by priority bucket, deploy status, category, and CI. A repository name opens its GitHub URL when the URL cell is `http` or `https`.
- **Priorities** shows Today & Priorities. Status can be changed by a signed-in editor.
- **Deploy** shows Deploy Tracker.
- **Webhooks** shows Webhook Log (created on first use) and whether the script properties are set.
- **Classify** asks Gemini for a priority, tech stack, deploy hint, and short rationale. Editors run it from Overview or Inventory. With `AI_AUTO_CLASSIFY` set, a repository webhook or a default-branch push can classify a new or still-unclassified row.

`doPost` accepts GitHub `push`, `repository`, `workflow_run`, `star`, and `ping`. It upserts Full Inventory by repository name and appends a log line. Auto-classify is off unless `AI_AUTO_CLASSIFY` is true, so a normal webhook does not call Gemini or the GitHub API.

## Files

| File | Role |
| --- | --- |
| `appsscript.json` | Timezone `Asia/Calcutta`, V8, web app defaults |
| `Main.gs` | Menu, `doGet`, `doPost`, spreadsheet id |
| `Api.gs` | `getOverviewMetrics`, `getInventoryRows`, `getPriorities`, `getDeployRows`, `updatePriorityStatus`, `getWebhookHealth`, optional GitHub enrich |
| `Ai.gs` | Gemini classify, batch classify, optional auto-classify, owner/org repo list |
| `Webhook.gs` | Signature/token check, inventory upsert, Webhook Log |
| `Index.html` | Material web app |
| `Sidebar.html` | Sheet sidebar |

`Index.html` does not share a basename with a `.gs` file. `doGet` uses `HtmlService.createHtmlOutputFromFile('Index')`.

## Architecture

The web app and the webhook share one `/exec` deployment. Reads go through `SpreadsheetApp.getActive()` when the script is bound, otherwise `openById`. Inventory responses are cached in `CacheService` for three minutes, in chunks, and the cache is dropped after a webhook upsert, an enrich write, or a classification write. `doPost` holds a short script lock, updates one inventory row (or appends one), appends one log row, and returns JSON. It calls Gemini only when `AI_AUTO_CLASSIFY` is true and the row is new or still unclassified. `GITHUB_TOKEN` is sent as `Authorization: Bearer` on GitHub API reads when the property is set. Without it, public requests continue and a rate-limit response tells you to set the property.

Other existing tabs (`Incomplete Projects`, `NVIDIA & Google Cloud`, `Master Plan`, `KPI Dashboard`) are left alone. Today & Priorities and Deploy Tracker are read by detecting their header row. Only `Webhook Log` is created when it is missing.

## 1. Bind and push with clasp

Install clasp and log in with the Google account that owns the spreadsheet:

```bash
npm install -g @google/clasp
clasp login
```

Copy `.clasp.json.example` to `.clasp.json` (gitignored). The example keeps a script id placeholder. For this board, set `scriptId` to the bound project:

`19UqmybsrjYhamFM6wiIfawBXI2lxnMrctfYHg6Urwp1UB0oo6mqwDtnA`

That project is bound to spreadsheet `1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w`. The same id is under **Extensions → Apps Script → Project settings → Script ID**.

```json
{
  "scriptId": "19UqmybsrjYhamFM6wiIfawBXI2lxnMrctfYHg6Urwp1UB0oo6mqwDtnA",
  "rootDir": "."
}
```

From this directory:

```bash
clasp push
```

`clasp push` replaces the Apps Script project files with this repo. If the manifest prompt blocks the push, run `clasp push --force`. Reload the spreadsheet. The **Control Tower** menu should appear. The first run asks you to authorize the spreadsheet, UI, external request, and email scopes.

If this upgrade replaces an older sidebar script, remove leftover files in the Apps Script editor that are not in this repo so an old `onOpen` cannot collide with `Main.gs`.

## 2. Script properties

**Project settings → Script properties**. Do not put these values in git.

| Property | Required | Purpose |
| --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Yes, for webhooks | Shared secret. Long random string. |
| `GITHUB_TOKEN` | No | Classic or fine-grained PAT with metadata read. Sent as a bearer token for repo metadata, languages, topics, README, and owner/org listing. Public requests still run when it is unset. |
| `GEMINI_API_KEY` | No | Google AI Studio key used by Classify. The dashboard reports whether it is set and never shows the value. |
| `GEMINI_MODEL` | No | Model id. Defaults to `gemini-3.8-flash`. |
| `AI_AUTO_CLASSIFY` | No | Set to `true` to classify new or unclassified rows after a `repository` event or a push to the default branch. Leave unset to keep webhooks from calling Gemini. |
| `CONTROL_TOWER_EDITORS` | No | Comma-separated emails allowed to change priority status, enrich, and classify. If empty, only the effective user (the account the script runs as in the sheet) can edit. |

Anonymous visitors never pass the editor check, because Apps Script does not give them an email on an Anyone deployment.

## 3. Deploy the web app

1. Apps Script → **Deploy → New deployment → Web app**.
2. **Execute as:** Me.
3. **Who has access:** **Anyone**.
4. Deploy and copy the URL that ends in `/exec`. The `/dev` URL always requires a Google login and cannot receive GitHub hooks.
5. **Control Tower → Web app URL** shows the same address after a deployment exists.

The manifest asks for `ANYONE_ANONYMOUS`, which is the “Anyone” choice. Confirm it in the deploy dialog. “Anyone with a Google account” returns a login page to GitHub and the delivery fails.

That single `/exec` URL serves both the dashboard (`GET`) and the webhook (`POST`). Anyone with the URL can view inventory data. Treat the deployment URL as unlisted.

## 4. GitHub webhook

Repository → **Settings → Webhooks → Add webhook**.

- **Payload URL:** `https://script.google.com/macros/s/DEPLOYMENT_ID/exec?token=YOUR_SECRET`
- **Content type:** `application/json`
- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** Pushes, Stars, Workflow runs, and Repository (ping is sent when you save)
- **SSL:** enabled

Use the same secret in both places. GitHub signs the raw body with `X-Hub-Signature-256`, but Apps Script web apps do not expose request headers, so the check that actually runs is the `token` query parameter. The script still verifies `X-Hub-Signature-256` when a header is present. A missing or wrong token returns JSON `{ "ok": false, "error": "unauthorized" }` and does not change the sheet. Apps Script still answers HTTP 200 for both success and rejection; read the JSON body. GitHub will not retry a 200.

What an accepted event writes on Full Inventory:

- **push / repository / star / workflow_run:** URL, description, visibility, stars, fork, and non-empty topics, matched by full name, exact repo name, or a single `owner/name` suffix
- **workflow_run:** Has CI becomes Yes. Deploy status becomes `Deployed` or `Failed` only when the workflow name looks like deploy, release, pages, production, or publish, and the current cell is empty or already one of those webhook values. A status such as `Live` is left as it is.
- **repository deleted:** logged only. The inventory row stays.
- **repository renamed:** the Repo cell is updated from `changes.repository.name.from`
- New repositories are appended below the existing rows. Category, score, priority, and future plan are left blank.

Values that start with `=`, `+`, `-`, or `@` are prefixed with an apostrophe before they are written.

## Edits

`updatePriorityStatus(repo, status, rowNumber)` writes the Status column on Today & Priorities. It refuses formula-like text. From the public web app this succeeds only when `Session.getActiveUser()` is the owner or an address in `CONTROL_TOWER_EDITORS`. The sheet sidebar runs as the person who opened the spreadsheet, so the owner can edit there.

**Refresh from GitHub** uses the row’s `owner/repo` name or `github.com` URL. It can fill stars, description, visibility, topics, fork, README, and Has CI when Actions workflows exist. It does not invent a deploy status. With `GITHUB_TOKEN` set, the request is authenticated. Without it, public repositories are read until GitHub’s unauthenticated rate limit, and the error tells you to add the token. Private repositories need the token.

## Classify with Gemini

1. In Apps Script, open **Project settings → Script properties**.
2. Add `GEMINI_API_KEY` with the key from Google AI Studio. Optionally add `GITHUB_TOKEN` so classification can read private repos and avoid the public rate limit. Optionally set `GEMINI_MODEL` (default `gemini-3.8-flash`).
3. Deploy or reload the web app. Overview and Inventory show two chips: Gemini configured or not, and GitHub token configured or not. The chips are booleans. The key and token are not sent to the browser.
4. Sign in as an editor. **Classify next N unclassified** walks rows whose Priority is empty or not P1/P2/P3, up to 8 per run, with a pause between Gemini calls. **Classify selected** uses the checkboxes on Inventory. The details drawer has **Classify** for one repository.
5. A successful run writes **Priority** and **Tech stack**. **Deploy status** is filled only when that cell is empty or already `Demo` or `None` (`Live`, `Deployed`, and `Failed` stay as they are). The GitHub **Description** is left unchanged. The rationale, deploy hint (`live`, `demo`, or `none`), and tags appear in the result panel and toast.
6. If `GEMINI_API_KEY` is missing, Classify returns a clear error and the rest of the dashboard keeps loading.

`listOwnerRepos(owner)` is available to editors from the script editor. It lists the user, then the organization if the user lookup is not found, and uses `GITHUB_TOKEN` when that property is set.

Set `AI_AUTO_CLASSIFY` to `true` only if webhook deliveries should spend a Gemini call. It runs for `repository` events (except deleted or transferred) and for pushes to the repository default branch, and only when the inventory row was just inserted or its priority is still unclassified. The webhook still returns success when classification fails; the log detail says `classify skipped` plus the reason. Leave the property unset for the cheaper webhook path.

## Local preview and tests

```bash
node --test tests/logic.test.mjs
node preview/server.mjs
```

The preview listens on port **41773** and labels itself as sample data. It is not the production app and it does not read the spreadsheet.

## Sheet contract

Full Inventory header **row 4**:

Repo, URL, Description, Visibility, Stars, Fork?, Topics, Has README, Has CI, Deploy status, Security alerts, Category, Tech stack, Production relevance score, Priority, Future plan.

Data starts on **row 5**. Classify matches those headers by name (Priority, Tech stack, Deploy status) and does not rewrite rows 1–3. Webhook Log headers, when this project creates the tab: Timestamp, Event, Repo, Action, Result, Detail.
