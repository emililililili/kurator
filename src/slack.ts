// Minimal Slack Web API wrapper. Form-encoded POST works for every method we
// use; complex args (modal `view`) are JSON-stringified into the form body per
// Slack's spec. Responses are typed per method so callers don't need to cast.

const API = "https://slack.com/api";

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
  ) {
    super(`slack ${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

interface BaseResponse {
  ok: boolean;
  error?: string;
}

async function call<T extends BaseResponse>(
  method: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as T;
  if (!data.ok) throw new SlackApiError(method, data.error ?? "unknown");
  return data;
}

// Shared payload shapes used across handlers.
export interface SlackReaction {
  name: string;
  count: number;
  users?: string[];
}

export interface SlackMessage {
  ts: string;
  text?: string;
  reactions?: SlackReaction[];
  subtype?: string;
  user?: string;
  reply_count?: number;
}

export interface SlackChannel {
  id: string;
  name?: string;
}

interface AuthTestResponse extends BaseResponse {
  user_id: string;
}

interface PostMessageResponse extends BaseResponse {
  ts: string;
  channel: string;
}

interface PermalinkResponse extends BaseResponse {
  permalink: string;
}

interface HistoryResponse extends BaseResponse {
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

interface UsersConversationsResponse extends BaseResponse {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

interface UserInfoResponse extends BaseResponse {
  user: {
    id: string;
    name?: string;
    real_name?: string;
    is_admin?: boolean;
    is_owner?: boolean;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

export const slack = {
  authTest: (token: string) =>
    call<AuthTestResponse>("auth.test", token, {}),

  openView: (token: string, triggerId: string, view: unknown) =>
    call<BaseResponse>("views.open", token, {
      trigger_id: triggerId,
      view: JSON.stringify(view),
    }),

  postMessage: (
    token: string,
    channel: string,
    text: string,
    blocks?: unknown[],
  ) =>
    call<PostMessageResponse>("chat.postMessage", token, {
      channel,
      text,
      unfurl_links: "false",
      unfurl_media: "false",
      ...(blocks ? { blocks: JSON.stringify(blocks) } : {}),
    }),

  deleteMessage: (token: string, channel: string, ts: string) =>
    call<BaseResponse>("chat.delete", token, {
      channel,
      ts,
    }),

  postEphemeral: (
    token: string,
    channel: string,
    user: string,
    text: string,
  ) =>
    call<BaseResponse>("chat.postEphemeral", token, {
      channel,
      user,
      text,
    }),

  addReaction: (token: string, channel: string, ts: string, name: string) =>
    call<BaseResponse>("reactions.add", token, {
      channel,
      timestamp: ts,
      name,
    }),

  history: (token: string, channel: string, oldest: number, cursor?: string) =>
    call<HistoryResponse>("conversations.history", token, {
      channel,
      oldest: String(oldest),
      limit: "200",
      ...(cursor ? { cursor } : {}),
    }),

  permalink: (token: string, channel: string, ts: string) =>
    call<PermalinkResponse>("chat.getPermalink", token, {
      channel,
      message_ts: ts,
    }),

  usersConversations: (token: string, cursor?: string) =>
    call<UsersConversationsResponse>("users.conversations", token, {
      exclude_archived: "true",
      types: "public_channel,private_channel",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    }),

  replies: (token: string, channel: string, ts: string, cursor?: string) =>
    call<HistoryResponse>("conversations.replies", token, {
      channel,
      ts,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    }),

  usersInfo: (token: string, userId: string) =>
    call<UserInfoResponse>("users.info", token, { user: userId }),
};
