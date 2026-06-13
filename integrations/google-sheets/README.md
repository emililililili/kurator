# Google Sheets archive (optional)

Mirrors every `/kurate` entry into a Google Sheet and keeps a running score
column, so you have a browsable archive and leaderboard outside Slack.

This is entirely optional. If you don't set `SHEETS_WEBHOOK_URL` and
`SHEETS_WEBHOOK_SECRET` on the Worker, the bot skips it silently. The Worker
treats the sheet as best-effort: it fires the webhook and moves on, so a script
error never affects the Slack post.

## What the Worker sends

Each call is a `POST` with JSON, a shared `secret`, and a `kind`:

| `kind`   | Sent when                  | Fields (besides `secret`)                                                                 |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `entry`  | someone submits `/kurate`  | `timestamp`, `kurator_id`, `kurator_name`, `category`, `title`, `author`, `link`, `why`, `message_ts` |
| `delete` | a kurate post is deleted   | `message_ts`                                                                              |
| `scores` | each digest run            | `active`: `[{ ts, score }]` (current positive picks) plus `windowDays` (the digest's scan window) |

On `scores`, the script refreshes the score of each matching row, removes
rows within the digest's window (`windowDays`, default 14) that are no longer
positive (negative-scored or deleted), and leaves anything older than the
window as a permanent archive.

## Setup

1. Create a Google Sheet. Open **Extensions -> Apps Script**.
2. Replace the default code with [`Code.gs`](./Code.gs). Save.
3. **Project Settings (gear) -> Script Properties -> Add property**:
   - `SHEETS_WEBHOOK_SECRET` = a random string (e.g. `openssl rand -hex 16`).
   - `SHEET_NAME` (optional) = the tab to write to. Defaults to the first tab in
     the spreadsheet. Set this only if your archive is not the first tab.
4. **Deploy -> New deployment -> Web app**. Set **Execute as: Me** and
   **Who has access: Anyone**. Deploy and authorize when prompted.
5. Copy the **Web app URL** (ends in `/exec`).
6. Point the Worker at it (use the same secret as step 3):
   ```bash
   npx wrangler secret put SHEETS_WEBHOOK_URL      # the /exec URL
   npx wrangler secret put SHEETS_WEBHOOK_SECRET   # same random string
   ```
7. Test: submit one `/kurate` and confirm a row appears. Then
   `GET /digest?force=$DIGEST_FORCE_SECRET` and confirm the `score` column updates.

## Columns

The script writes columns in this order:

```
timestamp | kurator_id | kurator_name | category | title | author | link | why | score | message_ts
```

A fresh sheet gets this header row automatically. If you point the script at an
existing sheet, its columns must already be in this order. `message_ts` is the
unique key used for updates and deletes, and is written into a text-formatted
cell so the sheet doesn't round it to a number (which would break those lookups).

## Notes

- **Editing the script later:** changes don't go live until you publish a new
  version. Use **Deploy -> Manage deployments -> edit (pencil) -> Version: New
  version**, which keeps the same `/exec` URL so the Worker secret stays valid.
- **Access model:** "Anyone" means anyone with the URL can reach the endpoint.
  The `secret` check is what authorizes writes, and HTTPS encrypts it in transit.
  Keep both the URL and secret out of the repo (they live as Worker secrets).
