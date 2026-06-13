import { verifySlackSignature, timingSafeEqual } from "./verify";
import { slack, SlackApiError } from "./slack";
import { KURATE_CALLBACK_ID, KURATE_MODAL } from "./modal";
import { runDigest } from "./digest";

// Slack mrkdwn escaping for user-supplied text. `<`, `>`, `&` would otherwise
// break our `<url|label>` link syntax or be misread as channel/user mentions.
// URLs in `link` stay raw — escaping a URL would corrupt query strings.
function mrkdwnEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  DIGEST_CHANNEL_ID: string;
  DIGEST_FORCE_SECRET: string;
  // Optional — if either is unset, sheet logging is silently skipped.
  // Both must be set for sheet writes to be attempted.
  SHEETS_WEBHOOK_URL?: string;
  SHEETS_WEBHOOK_SECRET?: string;
  // Slack user ID of the app owner — allowed to delete digests alongside
  // workspace owners. Optional; if unset, only workspace owners can delete.
  APP_OWNER_USER_ID?: string;
  // Optional branding overrides, shared with digest.ts. If unset, generic
  // defaults are used. The header emoji is also how digest posts are detected,
  // so it must match what the digest is posted with.
  DIGEST_HEADER_EMOJI?: string;
  DIGEST_TITLE?: string;
}

// Defaults for the digest header marker / title. Must match the defaults in
// digest.ts so detection and rendering stay consistent.
const DEFAULT_DIGEST_HEADER_EMOJI = ":tophat:";
const DEFAULT_DIGEST_TITLE = "Kurated";

// Action verb per category emoji, used in the post header
// "<@user>'s been {action}...".
const ACTION_BY_EMOJI: Record<string, string> = {
  "📚": "reading",
  "🎮": "playing",
  "🎬": "watching",
  "🎵": "listening to",
  "🍳": "cooking",
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Kurator's awake.", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/slack/command") {
      return handleSlashCommand(request, env);
    }

    if (request.method === "POST" && url.pathname === "/slack/interactive") {
      return handleInteractive(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/digest") {
      const provided = url.searchParams.get("force") ?? "";
      // Guard against the secret being unset at runtime — the type says
      // required, but `wrangler secret delete` would leave it undefined and
      // a missing secret should mean "no one can call this" (401), not 500.
      if (
        !env.DIGEST_FORCE_SECRET ||
        !timingSafeEqual(provided, env.DIGEST_FORCE_SECRET)
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      ctx.waitUntil(
        runDigest(env, true).catch((e) => console.error("digest error", e)),
      );
      return new Response("Digest triggered.", { status: 202 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runDigest(env, false).catch((e) => console.error("digest error", e)),
    );
  },
};

function ephemeral(text: string): Response {
  return new Response(
    JSON.stringify({ response_type: "ephemeral", text }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function modalErrors(errors: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ response_action: "errors", errors }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function handleSlashCommand(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.text();
  if (!(await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const params = new URLSearchParams(body);
  const triggerId = params.get("trigger_id");
  const channelId = params.get("channel_id");
  const channelName = params.get("channel_name");

  if (!triggerId || !channelId) {
    return new Response("missing fields", { status: 400 });
  }

  // Refuse DMs — we need a channel to post the rec into.
  if (channelId.startsWith("D") || channelName === "directmessage") {
    return ephemeral(
      "I work in channels, not DMs. Invite me to a channel and try again.",
    );
  }

  // Carry the channel through the modal via private_metadata.
  const modal = {
    ...KURATE_MODAL,
    private_metadata: JSON.stringify({ channel: channelId }),
  };

  // Awaited so we can give the user feedback if Slack rejects us. views.open
  // is fast (~200ms); well under Slack's 3s slash-command deadline.
  try {
    await slack.openView(env.SLACK_BOT_TOKEN, triggerId, modal);
  } catch (e) {
    console.error("views.open failed", e);
    return ephemeral("Hmm, couldn't open the form. Try /kurate again?");
  }

  return new Response("", { status: 200 });
}

async function handleInteractive(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.text();
  if (!(await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payloadStr = new URLSearchParams(body).get("payload");
  if (!payloadStr) return new Response("missing payload", { status: 400 });

  // Slack always sends valid JSON after sig-verify, but if a request ever
  // arrives malformed we want a clean 400, not a 500 from an unhandled throw.
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  // Message shortcut — primary delete path going forward. Triggered from the
  // ⋮ overflow menu on any kurate post.
  if (
    payload.type === "message_action" &&
    payload.callback_id === "kurate_delete_shortcut"
  ) {
    return handleDelete(payload, env, ctx);
  }

  // Digest-delete shortcut — only workspace owners or the configured app
  // owner can delete a digest post.
  if (
    payload.type === "message_action" &&
    payload.callback_id === "digest_delete_shortcut"
  ) {
    return handleDigestDelete(payload, env, ctx);
  }

  if (
    payload.type !== "view_submission" ||
    payload.view?.callback_id !== KURATE_CALLBACK_ID
  ) {
    return new Response("", { status: 200 });
  }

  let channelId: string | undefined;
  try {
    const meta = JSON.parse(payload.view.private_metadata || "{}");
    channelId = meta.channel;
  } catch {
    /* fallthrough */
  }
  if (!channelId) {
    return modalErrors({
      thing: "Lost track of which channel — try /kurate again.",
    });
  }

  const values = payload.view.state.values;
  const category: string = values.category.category.selected_option.value;
  const rawThing: string = values.thing.thing.value;
  const rawAuthor: string | null = values.author?.author?.value || null;
  const link: string | null = values.link?.link?.value || null;
  const rawWhy: string | null = values.why?.why?.value || null;
  const userId: string = payload.user.id;

  const thing = mrkdwnEscape(rawThing);
  const author = rawAuthor ? mrkdwnEscape(rawAuthor) : null;
  const why = rawWhy ? mrkdwnEscape(rawWhy) : null;

  const emoji = category.split(" ")[0];
  const action = ACTION_BY_EMOJI[emoji] ?? "kurating";
  // Title is bold; if a link was provided, the title itself becomes the
  // clickable link — much more visible than a separate ↗ symbol.
  const titleBlock = link ? `*<${link}|${thing}>*` : `*${thing}*`;
  const lines: string[] = [
    `${emoji} <@${userId}>'s been ${action}...`,
    `✨ ${titleBlock}${author ? ` by ${author}` : ""}`,
  ];
  if (why) {
    lines.push(`:speaking_head_in_silhouette: _"${why}"_`);
  }
  const text = lines.join("\n");

  // Post synchronously so we can return an inline modal error if Slack
  // rejects (e.g. not_in_channel). Text-only — Block Kit accessory layout
  // isn't responsive across screen widths, and posting with `blocks`
  // flattens m.text in conversations.history (breaking digest title
  // extraction). Delete is via a Slack message shortcut instead.
  let ts: string;
  try {
    const res = await slack.postMessage(env.SLACK_BOT_TOKEN, channelId, text);
    ts = res.ts;
  } catch (e) {
    if (
      e instanceof SlackApiError &&
      (e.code === "not_in_channel" || e.code === "channel_not_found")
    ) {
      return modalErrors({
        thing: "Invite me to that channel first: /invite @Kurator",
      });
    }
    console.error("post failed", e);
    return modalErrors({ thing: "Slack didn't like that. Try again?" });
  }

  // Reactions are fire-and-forget — don't block closing the modal.
  // Add sequentially so they appear in the intended order in Slack
  // (love it → bookmark → questionable).
  ctx.waitUntil(
    (async () => {
      try {
        await slack.addReaction(env.SLACK_BOT_TOKEN, channelId, ts, "100");
        await slack.addReaction(env.SLACK_BOT_TOKEN, channelId, ts, "bookmark");
        await slack.addReaction(
          env.SLACK_BOT_TOKEN,
          channelId,
          ts,
          "thinking_face",
        );
      } catch (e) {
        console.error("reactions failed", e);
      }
    })(),
  );

  // Sheet logging — fire-and-forget. Failures only log; the Slack post is
  // the source of truth, the sheet is a convenience archive. The webhook
  // only runs if both URL and shared secret are configured; the secret is
  // sent in the JSON body (not a URL param) so it doesn't end up in logs.
  if (env.SHEETS_WEBHOOK_URL && env.SHEETS_WEBHOOK_SECRET) {
    const webhookUrl = env.SHEETS_WEBHOOK_URL;
    const webhookSecret = env.SHEETS_WEBHOOK_SECRET;
    ctx.waitUntil(
      (async () => {
        try {
          const info = await slack.usersInfo(env.SLACK_BOT_TOKEN, userId);
          const kuratorName =
            info.user.profile?.display_name ||
            info.user.profile?.real_name ||
            info.user.real_name ||
            info.user.name ||
            userId;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              secret: webhookSecret,
              kind: "entry",
              timestamp: new Date().toISOString(),
              kurator_id: userId,
              kurator_name: kuratorName,
              category,
              title: rawThing,
              author: rawAuthor,
              link,
              why: rawWhy,
              message_ts: ts,
            }),
            redirect: "follow",
          });
        } catch (e) {
          console.error("sheet log failed", e);
        }
      })(),
    );
  }

  // Empty 200 closes the modal.
  return new Response("", { status: 200 });
}

async function handleDelete(
  // deno-lint-ignore no-explicit-any
  payload: any,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const channelId: string | undefined = payload.channel?.id;
  const messageTs: string | undefined = payload.message?.ts;
  const clickerId: string | undefined = payload.user?.id;
  const messageText: string = payload.message?.text ?? "";
  const headerEmoji = env.DIGEST_HEADER_EMOJI || DEFAULT_DIGEST_HEADER_EMOJI;
  const title = env.DIGEST_TITLE || DEFAULT_DIGEST_TITLE;

  // Refuse on digest posts. Those have a separate digest-delete shortcut with
  // stricter authorisation. Without this guard the first <@user> mention inside
  // the leaderboard would be treated as the kurate's owner and that user could
  // delete the whole digest.
  if (messageText.startsWith(headerEmoji)) {
    if (channelId && clickerId) {
      ctx.waitUntil(
        slack
          .postEphemeral(
            env.SLACK_BOT_TOKEN,
            channelId,
            clickerId,
            `This shortcut is for kurate posts. Use the ${title} delete shortcut for the digest.`,
          )
          .catch(() => {}),
      );
    }
    return new Response("", { status: 200 });
  }

  // Owner is the first <@USERID> mention in the post text — kurate posts
  // always lead with the kurator's mention, and user-supplied content is
  // mrkdwn-escaped so it can't sneak a fake mention in.
  const ownerMatch = messageText.match(/<@([UW][A-Z0-9]+)>/);
  const ownerId = ownerMatch?.[1];

  if (!channelId || !messageTs || !clickerId || !ownerId) {
    return new Response("", { status: 200 });
  }

  // Only the original poster may delete. Anyone else clicking gets a quiet
  // ephemeral nope — no public shame.
  if (clickerId !== ownerId) {
    ctx.waitUntil(
      slack
        .postEphemeral(
          env.SLACK_BOT_TOKEN,
          channelId,
          clickerId,
          "Only the original poster can delete this one.",
        )
        .catch((e) => console.error("ephemeral failed", e)),
    );
    return new Response("", { status: 200 });
  }

  try {
    await slack.deleteMessage(env.SLACK_BOT_TOKEN, channelId, messageTs);
  } catch (e) {
    console.error("delete failed", e);
    ctx.waitUntil(
      slack
        .postEphemeral(
          env.SLACK_BOT_TOKEN,
          channelId,
          clickerId,
          "Couldn't delete that. Try again?",
        )
        .catch(() => {}),
    );
    return new Response("", { status: 200 });
  }

  // Clean the sheet row immediately rather than waiting for the next
  // digest reconciliation. Best-effort; failures only log.
  if (env.SHEETS_WEBHOOK_URL && env.SHEETS_WEBHOOK_SECRET) {
    const webhookUrl = env.SHEETS_WEBHOOK_URL;
    const webhookSecret = env.SHEETS_WEBHOOK_SECRET;
    ctx.waitUntil(
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: webhookSecret,
          kind: "delete",
          message_ts: messageTs,
        }),
        redirect: "follow",
      }).catch((e) => console.error("sheet delete failed", e)),
    );
  }

  return new Response("", { status: 200 });
}

async function handleDigestDelete(
  // deno-lint-ignore no-explicit-any
  payload: any,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const channelId: string | undefined = payload.channel?.id;
  const messageTs: string | undefined = payload.message?.ts;
  const clickerId: string | undefined = payload.user?.id;
  const messageText: string = payload.message?.text ?? "";
  const headerEmoji = env.DIGEST_HEADER_EMOJI || DEFAULT_DIGEST_HEADER_EMOJI;
  const title = env.DIGEST_TITLE || DEFAULT_DIGEST_TITLE;

  if (!channelId || !messageTs || !clickerId) {
    return new Response("", { status: 200 });
  }

  // Only allow this on actual digest posts. Cheap content check (digest text
  // always begins with the configured header emoji), which keeps the shortcut
  // from being abused to delete unrelated bot messages.
  if (!messageText.startsWith(headerEmoji)) {
    ctx.waitUntil(
      slack
        .postEphemeral(
          env.SLACK_BOT_TOKEN,
          channelId,
          clickerId,
          `This shortcut only works on ${title} posts.`,
        )
        .catch(() => {}),
    );
    return new Response("", { status: 200 });
  }

  // Authorisation: workspace owner OR the configured app owner. We hit
  // users.info once to check is_owner, falling through to APP_OWNER_USER_ID
  // if that's not set or returns false.
  let allowed = false;
  if (env.APP_OWNER_USER_ID && clickerId === env.APP_OWNER_USER_ID) {
    allowed = true;
  } else {
    try {
      const info = await slack.usersInfo(env.SLACK_BOT_TOKEN, clickerId);
      if (info.user.is_owner === true) allowed = true;
    } catch (e) {
      console.error("users.info failed", e);
    }
  }

  if (!allowed) {
    ctx.waitUntil(
      slack
        .postEphemeral(
          env.SLACK_BOT_TOKEN,
          channelId,
          clickerId,
          `Only the workspace owner or app owner can delete a ${title} post.`,
        )
        .catch(() => {}),
    );
    return new Response("", { status: 200 });
  }

  try {
    await slack.deleteMessage(env.SLACK_BOT_TOKEN, channelId, messageTs);
  } catch (e) {
    console.error("digest delete failed", e);
    ctx.waitUntil(
      slack
        .postEphemeral(
          env.SLACK_BOT_TOKEN,
          channelId,
          clickerId,
          "Couldn't delete that. Try again?",
        )
        .catch(() => {}),
    );
  }

  return new Response("", { status: 200 });
}
