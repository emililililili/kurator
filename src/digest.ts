import {
  slack,
  type SlackChannel,
  type SlackMessage,
  type SlackReaction,
} from "./slack";

// Order is alphabetical by category name (Books, Games, Movies & TV,
// Music & Pods, Recipes) — drives the section order in the digest.
const CATEGORY_EMOJIS = ["📚", "🎮", "🎬", "🎵", "🍳"] as const;
type CategoryEmoji = (typeof CATEGORY_EMOJIS)[number];

const CATEGORY_NAMES: Record<CategoryEmoji, string> = {
  "📚": "Books",
  "🎵": "Music & Pods",
  "🎬": "Movies & TV",
  "🎮": "Games",
  "🍳": "Recipes",
};

// Slack normalises unicode emoji to `:shortcode:` form when storing messages
// posted via chat.postMessage, so conversations.history returns shortcodes.
// We match on either form when scanning history.
const CATEGORY_SHORTCODES: Record<CategoryEmoji, string> = {
  "📚": ":books:",
  "🎵": ":musical_note:",
  "🎬": ":clapper:",
  "🎮": ":video_game:",
  "🍳": ":fried_egg:",
};

// Shown italicised when a category has zero recs in the window, instead of
// dropping the section entirely. Gives people a specific nudge per category.
const EMPTY_PROMPT: Record<CategoryEmoji, string> = {
  "📚": "Nothing on the shelf yet. What've you been reading?",
  "🎵": "Quiet on the speakers. What's on repeat?",
  "🎬": "Screens are dark. Watch anything good?",
  "🎮": "Controllers untouched. What's eating your evenings?",
  "🍳": "Empty kitchen. Cooked anything good?",
};

// Digest header marker and title. The marker is what the bot posts the digest
// with, and what history scans match on to identify digest posts, so it must be
// stable for a given deployment. Both are overridable per-deployment via
// env.DIGEST_HEADER_EMOJI / env.DIGEST_TITLE (set with `wrangler secret put`),
// e.g. a custom workspace emoji. Defaults are generic so the public build works
// in any workspace.
const DEFAULT_DIGEST_HEADER_EMOJI = ":tophat:";
const DEFAULT_DIGEST_TITLE = "Kurated";

// ─────────────────────────────────────────────────────────────────────────
// DIGEST SCHEDULE — edit these to change when the digest posts.
//
// How it works: wrangler.toml `crons` decides the UTC times the Worker WAKES
// UP; the values below decide which of those wake-ups actually POST. The code
// is the source of truth, so any extra cron fires are simply ignored. All
// times below are in TIME_ZONE local time, and DST (e.g. UK BST/GMT) is
// handled automatically.
//
//   • Weekly instead of biweekly → set INTERVAL_DAYS = 7
//   • Different time of day       → set POST_HOUR (24h clock, in TIME_ZONE)
//   • Different timezone          → set TIME_ZONE (any IANA name)
//   • Different day of week        → set POST_WEEKDAY, AND update the cron
//                                     weekday in wrangler.toml, AND pick a
//                                     FIRST_DIGEST that falls on that weekday
//   • Different start / end       → set FIRST_DIGEST / LAST_DIGEST
//
// FIRST_DIGEST is the anchor: the digest posts on that date, then every
// INTERVAL_DAYS after it. It MUST fall on POST_WEEKDAY, and wrangler.toml must
// fire the cron on that weekday at/around POST_HOUR (see the note there).
// ─────────────────────────────────────────────────────────────────────────

const TIME_ZONE = "Europe/London"; // IANA timezone all the times below are in
const POST_WEEKDAY = 5; // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
const POST_HOUR = 15; // 24-hour clock, in TIME_ZONE (15 = 3pm)
const INTERVAL_DAYS = 14; // 14 = biweekly / fortnightly, 7 = weekly
const FIRST_DIGEST = "2026-06-12"; // anchor, YYYY-MM-DD, must fall on POST_WEEKDAY
const LAST_DIGEST: string | null = null; // e.g. "2026-12-11" (your final digest's date), or null for no end

interface DigestEnv {
  SLACK_BOT_TOKEN: string;
  DIGEST_CHANNEL_ID: string;
  SHEETS_WEBHOOK_URL?: string;
  SHEETS_WEBHOOK_SECRET?: string;
  // Optional branding overrides. If unset, generic defaults are used.
  DIGEST_HEADER_EMOJI?: string;
  DIGEST_TITLE?: string;
}

interface ScoredMessage {
  channel: string;
  ts: string;
  text: string;
  emoji: CategoryEmoji;
  score: number;
}

function leadingEmoji(text: string): CategoryEmoji | null {
  for (const e of CATEGORY_EMOJIS) {
    if (text.startsWith(e) || text.startsWith(CATEGORY_SHORTCODES[e])) return e;
  }
  return null;
}

// Pulls a clean "Title by Author" string from a kurate post. The current
// format puts the title between the ✨/:sparkles: marker and either the
// :speaking_head_in_silhouette: marker (when there's a why) or end of text.
// Negative lookahead skips legacy "✨ Kurated by <@user>" attribution lines
// so the regex matches the actual title, not the kurator credit. Legacy
// posts (no title-bearing sparkles line) fall through to line 1.
function extractTitle(text: string): string {
  const titleMatch = text.match(
    /(?:✨|:sparkles:)\s+(?!Kurated\s)(.+?)(?:\s+:speaking_head_in_silhouette:|\s*$)/s,
  );
  if (titleMatch) return cleanTitleFragment(titleMatch[1]);
  return cleanTitleFragment(text.split("\n")[0])
    .replace(/^[📚🎵🎬🎮🍳]\s*/u, "")
    .replace(/^:(books|musical_note|clapper|video_game|fried_egg):\s*/, "");
}

function cleanTitleFragment(s: string): string {
  return s
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2") // <url|label> → label
    .replace(/\*/g, "") // strip bold markers
    .trim();
}

// First user mention in the post — line 1 in the new format
// ("{emoji} <@USER>'s been {action}..."), or the trailing "Kurated by"
// line in legacy posts.
function extractKurator(text: string): string | null {
  const m = text.match(/<@([UW][A-Z0-9]+)>/);
  return m ? m[1] : null;
}

// Bot's own auto-reactions shouldn't count. Filter by user IDs when the
// `users` array is present; fall back to raw count otherwise.
//   💯 (100)            → "love it"           → +2
//   🔖 (bookmark)       → "added to my list"  → +1
//   🤔 (thinking_face)  → "questionable"      → -1
function scoreReactions(
  reactions: SlackReaction[] | undefined,
  botUserId: string,
): number {
  if (!reactions) return 0;
  let s = 0;
  for (const r of reactions) {
    const human = r.users
      ? r.users.filter((u) => u !== botUserId).length
      : r.count;
    if (r.name === "100") s += human * 2;
    else if (r.name === "bookmark") s += human;
    else if (r.name === "thinking_face") s -= human;
  }
  return s;
}

// Wall-clock parts of `date` as seen in TIME_ZONE. Uses the platform timezone
// database, so it accounts for BST/GMT (and any other zone's DST) on its own.
function zonedParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // some platforms emit "24" for midnight
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10),
    day: parseInt(p.day, 10),
    hour,
    weekday: weekdays[p.weekday],
  };
}

function parseYmd(s: string): number {
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
}

// Decides whether a scheduled wake-up should post. Checks, in order: right
// weekday, right hour in TIME_ZONE, inside the optional start/end window, and
// on the right cadence (a whole number of INTERVAL_DAYS since FIRST_DIGEST).
// Because the day-of-week and date are read in TIME_ZONE, the post always lands
// at POST_HOUR local time regardless of DST.
export function shouldPostDigest(now: Date): { ok: boolean; reason?: string } {
  const t = zonedParts(now);
  if (t.weekday !== POST_WEEKDAY) return { ok: false, reason: "off-day" };
  if (t.hour !== POST_HOUR) return { ok: false, reason: "off-time" };

  const today = Date.UTC(t.year, t.month - 1, t.day);
  const first = parseYmd(FIRST_DIGEST);
  if (today < first) return { ok: false, reason: "before-start" };
  if (LAST_DIGEST !== null && today > parseYmd(LAST_DIGEST)) {
    return { ok: false, reason: "after-end" };
  }

  const days = Math.round((today - first) / 86_400_000);
  if (days % INTERVAL_DAYS !== 0) return { ok: false, reason: "off-week" };

  return { ok: true };
}

export async function runDigest(
  env: DigestEnv,
  force = false,
): Promise<{ posted: boolean; reason?: string }> {
  const now = new Date();
  const headerEmoji = env.DIGEST_HEADER_EMOJI || DEFAULT_DIGEST_HEADER_EMOJI;
  const title = env.DIGEST_TITLE || DEFAULT_DIGEST_TITLE;
  if (!force) {
    const check = shouldPostDigest(now);
    if (!check.ok) return { posted: false, reason: check.reason };
  }

  const auth = await slack.authTest(env.SLACK_BOT_TOKEN);
  const botUserId = auth.user_id;

  // Idempotency: if a digest was already posted in DIGEST_CHANNEL_ID within
  // the last hour, bail. Defends against rare cron double-fires. Manual
  // (force=true) triggers bypass this — they're already gated by the shared
  // DIGEST_FORCE_SECRET, and the operator typed the URL on purpose.
  if (!force) {
    const oneHourAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    const recent = await slack.history(
      env.SLACK_BOT_TOKEN,
      env.DIGEST_CHANNEL_ID,
      oneHourAgo,
    );
    const alreadyPosted = (recent.messages ?? []).some(
      (m) =>
        m.user === botUserId && (m.text ?? "").startsWith(headerEmoji),
    );
    if (alreadyPosted) {
      console.log("digest already posted within the last hour — skipping");
      return { posted: false, reason: "already-posted" };
    }
  }

  // Discover every channel the bot is a member of (paginated).
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const res = await slack.usersConversations(env.SLACK_BOT_TOKEN, cursor);
    if (res.channels) channels.push(...res.channels);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Sanity-check: bot must be a member of DIGEST_CHANNEL_ID to post there.
  // Fail fast with a clear log instead of burning API calls and 500ing on the
  // final postMessage.
  if (!channels.some((c) => c.id === env.DIGEST_CHANNEL_ID)) {
    console.error(
      `bot is not a member of DIGEST_CHANNEL_ID=${env.DIGEST_CHANNEL_ID} — skipping digest`,
    );
    return { posted: false, reason: "not-in-digest-channel" };
  }

  const buckets = new Map<CategoryEmoji, ScoredMessage[]>();
  for (const e of CATEGORY_EMOJIS) buckets.set(e, []);

  for (const channel of channels) {
    try {
      await collectFromChannel(
        env.SLACK_BOT_TOKEN,
        channel.id,
        botUserId,
        buckets,
        headerEmoji,
      );
    } catch (e) {
      console.error(`scan failed for channel ${channel.id}`, e);
    }
  }

  // Sync active entries (with current scores) to the sheet. Negative-score
  // entries are deliberately omitted from `active` — the script's
  // reconciliation removes any sheet row not in the set (within 14d), so
  // dropping them here cleans "questionable" picks out of the leaderboard.
  // Best-effort; failures only log.
  if (env.SHEETS_WEBHOOK_URL && env.SHEETS_WEBHOOK_SECRET) {
    const active: Array<{ ts: string; score: number }> = [];
    for (const messages of buckets.values()) {
      for (const m of messages) {
        if (m.score >= 0) active.push({ ts: m.ts, score: m.score });
      }
    }
    try {
      await fetch(env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: env.SHEETS_WEBHOOK_SECRET,
          kind: "scores",
          active,
          windowDays: INTERVAL_DAYS,
        }),
        redirect: "follow",
      });
    } catch (e) {
      console.error("sheet score sync failed", e);
    }
  }

  const text = await buildDigestText(
    env.SLACK_BOT_TOKEN,
    buckets,
    headerEmoji,
    title,
  );
  await slack.postMessage(env.SLACK_BOT_TOKEN, env.DIGEST_CHANNEL_ID, text);
  return { posted: true };
}

async function collectFromChannel(
  token: string,
  channelId: string,
  botUserId: string,
  buckets: Map<CategoryEmoji, ScoredMessage[]>,
  headerEmoji: string,
): Promise<void> {
  // Scan window matches the cadence so consecutive digests never overlap
  // (weekly) or leave gaps (biweekly).
  const oldest = Math.floor((Date.now() - INTERVAL_DAYS * 86_400_000) / 1000);

  const consider = (m: SlackMessage) => {
    if (m.subtype) return;
    // Only count messages we (the bot) posted via /kurate.
    if (m.user !== botUserId) return;
    const text = m.text ?? "";
    // Defensive: skip our own digest posts so reactions on those never count.
    if (text.startsWith(headerEmoji)) return;
    const emoji = leadingEmoji(text);
    if (!emoji) return;
    buckets.get(emoji)!.push({
      channel: channelId,
      ts: m.ts,
      text,
      emoji,
      score: scoreReactions(m.reactions, botUserId),
    });
  };

  // 1. Top-level channel messages (paginated).
  let cursor: string | undefined;
  const threadParents: string[] = [];
  do {
    const res = await slack.history(token, channelId, oldest, cursor);
    for (const m of res.messages ?? []) {
      consider(m);
      if ((m.reply_count ?? 0) > 0) threadParents.push(m.ts);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // 2. Thread replies (paginated per thread). Kurate posts that landed inside
  // a thread still count toward the digest.
  for (const parentTs of threadParents) {
    let replyCursor: string | undefined;
    do {
      const res = await slack.replies(token, channelId, parentTs, replyCursor);
      for (const r of res.messages ?? []) {
        if (r.ts === parentTs) continue;
        consider(r);
      }
      replyCursor = res.response_metadata?.next_cursor || undefined;
    } while (replyCursor);
  }
}

async function buildDigestText(
  token: string,
  buckets: Map<CategoryEmoji, ScoredMessage[]>,
  headerEmoji: string,
  title: string,
): Promise<string> {
  const dateStr = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const lines: string[] = [
    `${headerEmoji} *${title} · ${dateStr}* ${headerEmoji}`,
    "",
    "Here's what everyone's been loving lately.",
    "",
  ];

  // Compute the top picks per category up-front (drop negatives, rank,
  // truncate to 3). Doing this first lets us fire every permalink request
  // in one parallel batch instead of one batch per category.
  const tops = new Map<CategoryEmoji, ScoredMessage[]>();
  for (const e of CATEGORY_EMOJIS) {
    tops.set(
      e,
      buckets
        .get(e)!
        .filter((m) => m.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3),
    );
  }

  const flat = [...tops.values()].flat();
  const linkResults = await Promise.all(
    flat.map((m) => slack.permalink(token, m.channel, m.ts)),
  );
  const permalinkByTs = new Map(
    flat.map((m, i) => [m.ts, linkResults[i].permalink]),
  );

  for (const e of CATEGORY_EMOJIS) {
    const top = tops.get(e)!;
    lines.push(`${e} *${CATEGORY_NAMES[e]}*`);
    if (top.length === 0) {
      lines.push(`_${EMPTY_PROMPT[e]}_`);
    } else {
      for (let i = 0; i < top.length; i++) {
        const m = top[i];
        const title = extractTitle(m.text);
        const kurator = extractKurator(m.text);
        const kuratorPart = kurator ? ` · <@${kurator}>` : "";
        lines.push(
          ` ${i + 1}. <${permalinkByTs.get(m.ts)}|${title}>${kuratorPart} · ${m.score}`,
        );
      }
    }
    lines.push("");
  }

  lines.push("→ `/kurate` to add yours :sparkles:");
  return lines.join("\n");
}
