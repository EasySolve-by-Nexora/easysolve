import { hash, HttpError, rateLimit } from "./security";

// Authentication throttling uses two independent keys so neither can be used to
// deny service to everyone:
//   - the trusted client IP, and
//   - a hashed, normalized account (email) key. Raw emails are never stored in
//     rate-limit keys.
// Forwarded headers are client-controlled unless a reverse proxy strips them and
// writes the real client IP, so production requires TRUST_PROXY=true. Outside
// production a shared development key is used as a local safeguard only.

function envLimit(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

export function trustedClientIp(request: Request) {
  const production = process.env.NODE_ENV === "production";
  if (process.env.TRUST_PROXY === "true") {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (ip) return ip.slice(0, 64);
    if (production) {
      console.error(
        "TRUST_PROXY is enabled but the request has no X-Forwarded-For header",
      );
      throw new HttpError(
        503,
        "Authentication is temporarily unavailable. Contact your operator.",
      );
    }
    return "dev-shared";
  }
  if (production) {
    console.error(
      "Authentication refused: set TRUST_PROXY=true behind a reverse proxy that replaces X-Forwarded-For with the client IP",
    );
    throw new HttpError(
      503,
      "Authentication is temporarily unavailable. Contact your operator.",
    );
  }
  return "dev-shared";
}

// Returns null when the body carries no usable email; the IP limit still applies.
export function accountKey(email: unknown) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase().slice(0, 254);
  return normalized ? hash(`account:${normalized}`) : null;
}

export async function throttleAuth(
  request: Request,
  scope: "login" | "recover",
  email: unknown,
) {
  const ip = trustedClientIp(request);
  const account = accountKey(email);
  if (scope === "recover") {
    await rateLimit(
      `recover:ip:${ip}`,
      envLimit("RECOVERY_IP_LIMIT_PER_MINUTE", 5),
      60,
    );
    if (account)
      await rateLimit(
        `recover:acct:${account}`,
        envLimit("RECOVERY_ACCOUNT_LIMIT_PER_HOUR", 3),
        3600,
      );
    return;
  }
  await rateLimit(
    `auth:ip:${ip}`,
    envLimit("AUTH_IP_LIMIT_PER_MINUTE", 10),
    60,
  );
  if (account)
    await rateLimit(
      `auth:acct:${account}`,
      envLimit("AUTH_ACCOUNT_LIMIT_PER_15_MINUTES", 10),
      900,
    );
}
