// Verifies Slack request signatures (HMAC-SHA256) using Web Crypto.
// https://api.slack.com/authentication/verifying-requests-from-slack

// Constant-time string comparison. Returns false on length mismatch (length
// is not itself sensitive — both sides are fixed-format strings here). Use
// for any secret comparison to avoid leaking via response-time timing.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifySlackSignature(
  request: Request,
  body: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  // Reject replays older than 5 minutes.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString),
  );
  const expected =
    "v0=" +
    [...new Uint8Array(sigBuffer)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return timingSafeEqual(expected, signature);
}
