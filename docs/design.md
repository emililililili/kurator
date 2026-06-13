# How Kurator works

Kurator is a Slack bot for sharing what your team is into lately: someone runs `/kurate`, drops a rec (book, pod, album, film, show, game, recipe), and everyone can react with 💯 🔖 🤔. On a schedule you set, it rounds up the favourites and posts a digest.

This is the guided tour of how it fits together. If you just want to run it, the [README](../README.md) has you covered.

## Contents

- [Architecture](#architecture)
- [Modal](#1-modal)
- [Posted message format](#2-posted-message-format)
- [Reactions](#3-reactions)
- [Digest](#4-digest)
- [Channel canvas](#5-channel-canvas)
- [Kickoff message](#6-kickoff-message)
- [Slack app setup](#7-slack-app-setup)
- [Worker layout](#8-worker-layout)
- [Security](#9-security)
- [Limitations and workarounds](#limitations-and-workarounds)
- [Verification](#verification)
- [Sources](#sources)

## Architecture

- **Custom Slack app** (`Kurator`): slash command + modal, registered at api.slack.com.
- **Cloudflare Workers**: single TS Worker, two HTTP handlers + scheduled handler. Strictly free, no commercial-use restriction, no card required.
- **No database**: state lives in Slack messages.
- **Channels:** `/kurate` works in any channel the bot is invited to (so you can test in a private channel before launch). The digest **aggregates recs from every member channel into one combined digest**, posted to a single configured `DIGEST_CHANNEL_ID` (for example your main channel in production, a private test channel during soft-launch).

## 1. Modal

| Field | Type | Required | User-facing copy |
|---|---|---|---|
| Modal title | n/a | n/a | `Kurate something ✨` |
| Submit button | n/a | n/a | `Share` |
| What kind? | static_select | yes | Options: `📚 Books`, `🎮 Games`, `🎬 Movies & TV`, `🎵 Music & Pods`, `🍳 Recipes`. Emoji is *in* the option label so the value carries it through. |
| What's it called? | plain_text_input | yes | placeholder: `the alchemist, me myself and i, interstellar etc.` |
| Who made it? | plain_text_input | no | placeholder: `paulo coelho, beyonce, christopher nolan etc.` |
| Got a link? | url_text_input | no | placeholder: `paste it if you've got it` |
| Why's it good? | plain_text_input | no | placeholder: `one line, no pressure` |

## 2. Posted message format

```
{emoji} <@user>'s been {action}...
✨ *{thing}* by {author}
🗣️ _"{why}"_
```

If a link was provided, the title itself is the clickable hyperlink (`*<link|thing>*`), with no separate ↗ symbol. If `author` is empty, drop the ` by {author}` segment. If `why` is empty, drop the 🗣️ line. User input (`thing`, `author`, `why`) is HTML-escaped (`<`, `>`, `&`) before composition so user-typed angle brackets can't break Slack's link/mention syntax. The bot then auto-reacts in this order: 💯, 🔖, 🤔.

## 3. Reactions

The bot auto-adds three reactions to every kurate post (in this order, so they sit as one-tap buttons in the most natural left-to-right order):

| Emoji | Slack name | Meaning | Digest weight |
|---|---|---|---|
| 💯 | `:100:` | "love it" | **+2** |
| 🔖 | `:bookmark:` | "added to my list" | **+1** |
| 🤔 | `:thinking_face:` | "questionable choice" | **−1** |

Other reactions are allowed but ignored by the digest scorer. Net score per rec = sum across all three. Only recs scoring 0 or higher appear in the digest; negatives are dropped.

## 4. Digest

Cron wakes the Worker (see `wrangler.toml`); the `DIGEST SCHEDULE` block in `src/digest.ts` is the source of truth for when to post (cadence, weekday, hour, timezone, start/end). Manual trigger: `GET /digest?force=$DIGEST_FORCE_SECRET`.

Steps:
1. Schedule check (`shouldPostDigest`): early-return on off-day, off-time, off-week, or outside the start/end window.
2. `users.conversations` to discover every channel the bot is a member of.
3. For each channel: `conversations.history` (`oldest = now - INTERVAL_DAYS days`, matching the cadence, paginate). For each top-level message with `reply_count > 0`, also fetch `conversations.replies` so kurate posts in threads still count.
4. Filter to bot-authored messages only (i.e., posted via `/kurate`); skip direct-typed messages even if they start with a category emoji. Defensively skip messages whose text starts with the digest header emoji so digest reactions can never pollute scores. Leading emoji → category bucket. Each scored message remembers its source channel so its permalink resolves correctly.
5. `score = 💯 × 2 + 🔖 × 1 − 🤔 × 1` (excluding the bot's own auto-reactions via `auth.test` user_id).
6. **Aggregate** all channel buckets into one combined set of category buckets. Per category: drop negative-scored recs, sort desc, take top 3. Categories with nothing left to show display an italic prompt (`Quiet on the speakers. What's on repeat?` etc.) instead of a numbered list.
7. Post the **single combined digest** via `chat.postMessage` to `DIGEST_CHANNEL_ID`:

```
🎩 *Acme Kurated · 2 Jan 2026* 🎩

Here's what everyone's been loving lately.

📚 *Books*
_Nothing on the shelf yet. What've you been reading?_

🎮 *Games*
 1. <permalink|Hollow Knight> · <@U123> · 4

🎬 *Movies & TV*
 1. <permalink|Past Lives> · <@U456> · 11
 2. <permalink|Hacks> · <@U123> · 3

🎵 *Music & Pods*
_Quiet on the speakers. What's on repeat?_

🍳 *Recipes*
_Empty kitchen. Cooked anything good?_

→ `/kurate` to add yours :sparkles:
```

Permalinks via `chat.getPermalink` (using each rec's source channel).

## 5. Channel canvas

Paste-ready copy for a channel canvas guide that introduces Kurator. Replace the
`«placeholders»` first:

- `«schedule»`: when the digest posts, e.g. `Every other Friday at 3pm UK`
- `«digest name»`: your `DIGEST_TITLE`, e.g. `Kurated`
- `«#channel»`: where the digest lands (`DIGEST_CHANNEL_ID`)
- `«your archive»`: a link to your Google Sheet, only if the [Sheets archive](../integrations/google-sheets/) is enabled

Formatting (Slack canvas markers): the first line is the canvas **Title** style;
`*...*` renders **bold**, `_..._` renders _italic_; turn `«your archive»` into a
hyperlink.

```
:sparkles: Kurator Guide

*Kurator is an archive of what we're loving lately.*

Type `/kurate` anywhere the @Kurator app has been invited to, and share
something you've been into lately: whether it be a book :books:, game
:video_game:, music :musical_note:, show :clapper:, or recipe :fried_egg:.
Anything good.

The bot posts your rec for everyone to react to:

* 💯 "love it"
* 🔖 "added to my list"
* 🤔 "questionable choice"

«schedule», Kurator drops a *"«digest name»"* digest of our recent top picks
into «#channel».

*No longer feeling the rec?*

To remove a `/kurate` post: hover the message → ⋮ More Actions → Connect to
Apps → [search:] Delete Kuration
_(Only the original poster can delete their own kuration.)_

*Want to see the full archive?*
Head over to «your archive» (hyperlink only if the Google Sheets archive is enabled).

*Happy /kurating! :sparkles:*
```

## 6. Kickoff message

A one-time post for launch day:

```
👋  Hey team, meet the Kurator.

  Type /kurate anywhere to share something you're loving:
  book, pod, album, film, show, game, recipe. Anything good.

  💯  if you love it
  🔖  if you'll add it to your list
  🤔  if you're not sure about this one

  On a schedule, the Kurator picks the best of the bunch
  and drops them right here.

  To kick us off: what have you kurated lately?
```

## 7. Slack app setup

**Display info** (Basic Information → Display Information). Example copy, change it to taste:

- **App name:** `Kurator`
- **Short description / tagline:** `Good taste is better when it's shared`
- **Long description:** Think of Kurator as your team's most cultured colleague. The one who always knows what to watch, what to read, and what to cook on a Sunday. Except it's not one person, it's everyone. Drop your recs, react to others, and never run out of things to love!
- **App icon:** Any image you like.

**Bot Token Scopes:**

| Scope | Why |
|---|---|
| `commands` | `/kurate` slash command |
| `chat:write` | Post entries + digest |
| `reactions:write` | Auto-add the three reactions (💯 🔖 🤔) |
| `reactions:read` | Score digest |
| `channels:history` + `groups:history` | Read recent public + private channel history for the digest |
| `channels:read` + `groups:read` | List public + private channels the bot is a member of (for digest) |
| `users:read` | Resolve `@mentions` in digest |

**Features:**
- Slash command `/kurate` → `https://kurator.<sub>.workers.dev/slack/command` · short desc `Share something you're loving` · usage hint **left empty** (filled hints make Slack require two Enters)
- Interactivity & Shortcuts → `https://kurator.<sub>.workers.dev/slack/interactive`
- Event Subscriptions: not needed.

After install: copy **Bot Token** (`xoxb-…`) and **Signing Secret**. Invite `@Kurator` to whichever channel you want it in (private test channel for soft-launch; your main channel once you're happy).

## 8. Worker layout

```
kurator/
├── src/
│   ├── index.ts      ← routes /slack/command, /slack/interactive, /digest, scheduled()
│   ├── slack.ts      ← fetch-based Slack Web API wrapper (no SDK)
│   ├── verify.ts     ← HMAC-SHA256 signature check via crypto.subtle
│   ├── modal.ts      ← Block Kit modal definition
│   └── digest.ts     ← fetch + score + format + post
├── wrangler.toml     ← + cron trigger
├── package.json      ← devDeps: wrangler, typescript, @cloudflare/workers-types
└── README.md
```

`wrangler.toml`:
```toml
[triggers]
# Fires Fri 14:00 + 15:00 UTC; code posts only at 3pm Europe/London (DST-safe).
crons = ["0 14 * * 5", "0 15 * * 5"]
```

**Secrets** (`wrangler secret put`):

| Name | Source |
|---|---|
| `SLACK_BOT_TOKEN` | OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | Basic Information |
| `DIGEST_CHANNEL_ID` | Channel where the combined digest is posted (for example your main channel's ID; the test channel's ID during soft-launch) |
| `DIGEST_FORCE_SECRET` | random string |
| `DIGEST_TITLE` | *Optional.* Digest header text, e.g. `Acme Kurated`. Defaults to `Kurated`. |
| `DIGEST_HEADER_EMOJI` | *Optional.* Header marker emoji shortcode, e.g. a custom `:acme:`. Defaults to `:tophat:`. Must stay stable for a deployment, since it is also how digest posts are detected. |
| `SHEETS_WEBHOOK_URL` | *Optional.* Enables the Google Sheets archive (see below). |
| `SHEETS_WEBHOOK_SECRET` | *Optional.* Shared secret for the Sheets webhook. |
| `APP_OWNER_USER_ID` | *Optional.* Slack user ID allowed to delete digest posts alongside workspace owners. |

Set `DIGEST_TITLE` / `DIGEST_HEADER_EMOJI` as secrets (not in `wrangler.toml`) so your branding stays out of the repo. The bot must be a member of `DIGEST_CHANNEL_ID` to post there. To switch the digest target, update the secret (`wrangler secret put DIGEST_CHANNEL_ID`). No redeploy needed; the next cron run picks it up.

**Optional Google Sheets archive:** set `SHEETS_WEBHOOK_URL` / `SHEETS_WEBHOOK_SECRET` to mirror entries into a sheet for a browsable archive and leaderboard. The one-time Apps Script setup lives in [integrations/google-sheets/](../integrations/google-sheets/).

Zero runtime deps (Workers ships `fetch` + `crypto.subtle` + JSON natively). Bundle: <30KB.

## 9. Security

- Verify `X-Slack-Signature` (HMAC-SHA256, `v0:{ts}:{body}`) on every Slack-originated request. Reject if signature fails or `ts` is older than 5 min. Docs: <https://api.slack.com/authentication/verifying-requests-from-slack>.
- `/digest`: Cloudflare cron invokes `scheduled()` internally (no public auth); manual trigger requires `?force=$DIGEST_FORCE_SECRET`.
- Slack 3s response deadline: both handlers do one Slack API call, well under.

## Limitations and workarounds

1. **Custom Workflow Builder steps need org/Enterprise install.** The slash command is the Pro-tier equivalent.
2. **Cloudflare cron has no biweekly or timezone support.** Handled in code: the cron just wakes the Worker, and `shouldPostDigest` anchors the cadence to a start date and posts at the right local time (DST-safe). One constant (`INTERVAL_DAYS`) flips weekly/biweekly.
3. **Bot must be a member of any channel where `/kurate` is used**, otherwise `chat.postMessage` fails. We catch this and surface an inline modal error: "Invite me to that channel first." The bot also needs to be in `DIGEST_CHANNEL_ID` for the digest to post; if not, the cron run logs an error and skips silently.

   *Important:* if you remove the bot from a channel, that channel's history since the last digest becomes invisible to the next one, and no "final digest" runs automatically. (`users.conversations` only returns channels the bot currently belongs to, and `conversations.history` would 401 anyway.)
4. **Workspace admins may gate custom apps.** If your workspace allows "approved apps only", a workspace admin needs to approve the app first (typically ~1 day).
5. **Only `/kurate` submissions count toward the digest.** Direct-typed messages are ignored even if they start with a category emoji, so casual `🎵 nice tune` chatter doesn't pollute the leaderboard. To be eligible: use `/kurate`.
6. **Slack doesn't pass thread context to slash commands.** `/kurate` always posts at channel top level, even if invoked while reading a thread. The digest does scan thread replies, so any kurate-format messages that *do* land in threads still count, but the slash command can't put them there itself.

## Verification

1. `/kurate` in any channel → modal opens with 5 emoji-prefixed category options.
2. Submit one rec per category → posts in your main channel with the right emoji + the three auto-reactions (💯 🔖 🤔).
3. Add 1× 💯, 1× 🔖, 1× 🤔, 1× 🔥 to a test post → manual score = 2 + 1 − 1 = 2; ➕ and 🔥 ignored.
4. `GET /digest?force=…` → combined digest posts to `DIGEST_CHANNEL_ID`; buckets correct, scores correct, empty categories show italic prompts, permalinks open original posts (across whichever channels they came from).
5. Off-week / off-day / off-time scheduled runs post nothing (check `wrangler tail` for the skip reason); an on-week Friday at 3pm local posts.
6. `curl /slack/command` with no signature → 401.
7. Soft-launch 2–3 people seed real recs; trigger one manual digest before the first real Friday.

## Sources

- Slack: [slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/) · [workflow steps](https://docs.slack.dev/workflows/workflow-steps/) · [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/) · [request signing](https://api.slack.com/authentication/verifying-requests-from-slack) · [scopes](https://docs.slack.dev/reference/scopes/)
- Cloudflare: [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
