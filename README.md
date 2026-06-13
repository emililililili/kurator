# Kurator

*Good taste is better when it's shared.*

Kurator is a Slack bot for sharing what your team is loving. Someone runs `/kurate`, to drop a book, film, album, podcast, game, or recipe rec, and everyone else can react with 💯 🔖 🤔. On a schedule, the bot rounds up your team favourites, and posts a tidy digest in a channel you pick.

It started as a for-fun side project: zero runtime dependencies, runs free on Cloudflare Workers, and you can set up your own copy for your team in about half an hour. Curious how it all works? See [docs/design.md](docs/design.md).

## Set it up (about 30 minutes, once)

### 1. Create the Slack app

1. <https://api.slack.com/apps> → **Create New App** → **From scratch** → name it `Kurator`.
2. **OAuth & Permissions** → add Bot Token Scopes:
   `commands`, `chat:write`, `reactions:write`, `reactions:read`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`.
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information** → copy the **Signing Secret**.

(The request URLs come in step 3; leave the slash command and interactivity URLs empty for now.)

### 2. Deploy the Worker

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Note your Worker URL: `https://kurator.<your-subdomain>.workers.dev`.

Set the secrets:

```bash
npx wrangler secret put SLACK_BOT_TOKEN       # xoxb-…
npx wrangler secret put SLACK_SIGNING_SECRET  # from Basic Information
npx wrangler secret put DIGEST_CHANNEL_ID     # channel the digest posts to
npx wrangler secret put DIGEST_FORCE_SECRET   # any random string
```

Optional branding (defaults to `🎩` and `Kurated`):

```bash
npx wrangler secret put DIGEST_TITLE          # e.g. "Acme Kurated"
npx wrangler secret put DIGEST_HEADER_EMOJI   # e.g. ":acme:" (a custom workspace emoji)
```

Keep these as secrets rather than in `wrangler.toml` so your team name stays out of the repo.

Channel ID: in Slack, right-click the channel → **View channel details** → bottom of the panel.

`/kurate` works in any channel Kurator is invited to. The digest gathers recs from every channel the bot is in and posts one combined roundup to `DIGEST_CHANNEL_ID`. To move where it lands, run `wrangler secret put DIGEST_CHANNEL_ID` again. No redeploy needed.

### 3. Wire Slack to the Worker

Back in api.slack.com → your Kurator app:

- **Slash Commands** → Create New Command:
  - Command: `/kurate`
  - Request URL: `https://kurator.<your-subdomain>.workers.dev/slack/command`
  - Short description: `Share something you're loving`
  - **Leave the usage hint empty.** If it's filled, Slack's autocomplete makes people press Enter twice.
- **Interactivity & Shortcuts** → toggle on:
  - Request URL: `https://kurator.<your-subdomain>.workers.dev/slack/interactive`
- **Reinstall the app** when Slack prompts (and any time you change scopes).
- Invite `@Kurator` to a channel. For testing, use a private one with just you and a teammate; go wider once you're happy.

### 4. Smoke test (in that private channel first)

- `https://kurator.<your-subdomain>.workers.dev/` → returns `Kurator's awake.`
- Type `/kurate` → the modal opens.
- Submit one rec per category → it posts with the three auto-reactions (💯 🔖 🤔).
- `https://kurator.<your-subdomain>.workers.dev/digest?force=YOUR_DIGEST_FORCE_SECRET` → a digest posts to every channel Kurator is in.

When it all looks good: move Kurator to your real channel, update `DIGEST_CHANNEL_ID`, and you're live.

### 5. Welcome your team

Paste-ready channel canvas and kickoff message templates are in [docs/design.md](docs/design.md).

### 6. (Optional) Archive to a Google Sheet

Want a browsable archive and leaderboard outside Slack? Kurator can mirror every entry into a Google Sheet. It's off unless you set `SHEETS_WEBHOOK_URL` / `SHEETS_WEBHOOK_SECRET`; the one-time Apps Script setup is in [integrations/google-sheets/](integrations/google-sheets/).

## Running it

- **Logs:** `npx wrangler tail`
- **Schedule:** everything lives in the `DIGEST SCHEDULE` block at the top of [src/digest.ts](src/digest.ts). Cadence, time, day, timezone, and start/end are each one labelled constant (for example `INTERVAL_DAYS = 7` for weekly). The cron in `wrangler.toml` only wakes the Worker; the code decides whether to post, so the time stays right across DST.
- **Manual digest:** `GET /digest?force=$DIGEST_FORCE_SECRET`.
- **Move the digest channel:** `wrangler secret put DIGEST_CHANNEL_ID`, paste the new ID. The next run picks it up, no redeploy needed.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in your own values (it's gitignored, so secrets stay local).

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev
```

Workers don't get a public URL in dev. To test Slack webhooks locally, run `cloudflared tunnel --url http://localhost:8787` and point Slack's request URLs at the tunnel.

## How it works

Architecture, message formats, scopes, and the security model are all in [docs/design.md](docs/design.md).

## License

MIT. See [LICENSE](./LICENSE).
