# GitHub Control Tower

Enterprise Material Apps Script dashboard for [Yash GitHub Review Board](https://docs.google.com/spreadsheets/d/1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w/edit), with near-instant **GitHub webhook** upserts into **Full Inventory**.

## Bound project

- Spreadsheet ID: `1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w`
- Apps Script ID: `19UqmybsrjYhamFM6wiIfawBXI2lxnMrctfYHg6Urwp1UB0oo6mqwDtnA`

## Deploy

```bash
cp .clasp.json.example .clasp.json
# set scriptId to 19UqmybsrjYhamFM6wiIfawBXI2lxnMrctfYHg6Urwp1UB0oo6mqwDtnA
clasp push
```

Then in the Apps Script editor: **Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: **Anyone** (required so GitHub can POST webhooks)

### Script properties

| Property | Purpose |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Shared secret (`?token=` on webhook URL; also HMAC when header present) |
| `GITHUB_TOKEN` | Optional enrich |
| `CONTROL_TOWER_EDITORS` | Optional allowlist of emails that may edit priority status |

### GitHub webhook

Payload URL:

`https://script.google.com/macros/s/DEPLOYMENT_ID/exec?token=YOUR_SECRET`

Content type: `application/json`  
Events: `push`, `repository`, `workflow_run`, `star`, `ping`

Apps Script often does not forward `X-Hub-Signature-256`; the `token` query param is the reliable check.

## Pages

Overview · Inventory · Priorities · Deploy · Webhooks

The weekday Full Inventory sync remains the reconciliation path; webhooks keep individual rows fresh.
