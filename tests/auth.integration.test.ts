import "dotenv/config";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { db } from "../lib/db";
import { hash, user as currentUser } from "../lib/security";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const ids: string[] = [];
const ratePrefix = `auth-integration-${crypto.randomUUID()}`;
const setCookie = vi.fn();
let email = "",
  originalHash = "";
const origin = "http://localhost:3000";
async function call(action: string, body: unknown) {
  return api(
    new Request(`${origin}/api/auth/${action}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Forwarded-For": `${ratePrefix}-${crypto.randomUUID()}`,
      },
      body: JSON.stringify(body),
    }),
    ["auth", action],
  );
}
beforeAll(async () => {
  vi.stubEnv("APP_URL", origin);
  vi.stubEnv("TRUST_PROXY", "true");
  // Signup sends a welcome email; never contact the real provider in tests.
  vi.stubEnv("RESEND_API_KEY", "auth-test-resend-key");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  );
  vi.mocked(cookies).mockResolvedValue({ set: setCookie } as any);
  email = `auth-${crypto.randomUUID()}@example.test`;
  originalHash = await bcrypt.hash("eight123", 4);
  ids.push(
    (
      await db.user.create({
        data: { email, name: "Existing login fixture", password: originalHash },
      })
    ).id,
  );
});
afterAll(async () => {
  await db.rateLimit.deleteMany({
    where: { key: { startsWith: `auth:${ratePrefix}` } },
  });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.$disconnect();
});
it("authenticates an existing account with omitted or null signup-only fields without changing its hash", async () => {
  for (const extra of [{}, { name: null, token: null, redirect: null }]) {
    expect(
      (
        await call("login", {
          email: email.toUpperCase(),
          password: "eight123",
          ...extra,
        })
      ).status,
    ).toBe(200);
  }
  expect(setCookie).toHaveBeenCalled();
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: ids[0] } })).password,
  ).toBe(originalHash);
});
it("creates an account when welcome email delivery is available", async () => {
  vi.mocked(fetch).mockClear();
  const signupEmail = `welcome-${crypto.randomUUID()}@example.test`;
  const response = await call("signup", {
    email: signupEmail,
    name: "Welcome fixture",
    password: "fixture-password-123",
  });
  expect(response.status).toBe(200);
  const created = await db.user.findUniqueOrThrow({
    where: { email: signupEmail },
  });
  ids.push(created.id);
  expect(
    await db.job.findUnique({ where: { key: `welcome:${created.id}` } }),
  ).toBeNull();
  expect(fetch).toHaveBeenCalledWith(
    "https://api.resend.com/emails",
    expect.any(Object),
  );
});
it("does not let callers bypass auth throttling with forged forwarded IPs", async () => {
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
  vi.stubEnv("TRUST_PROXY", "false");
  const password = "wrong-password";
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await api(
      new Request(`${origin}/api/auth/login`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Forwarded-For": `forged-${attempt}`,
        },
        body: JSON.stringify({ email, password }),
      }),
      ["auth", "login"],
    );
    expect(response.status).toBe(401);
  }
  const blocked = await api(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Forwarded-For": "another-forged-ip",
      },
      body: JSON.stringify({ email, password }),
    }),
    ["auth", "login"],
  );
  expect(blocked.status).toBe(429);
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
  vi.stubEnv("TRUST_PROXY", "true");
});
it("keeps a valid session across requests, logs out explicitly, and does not delete it on backend failure", async () => {
  expect((await call("login", { email, password: "eight123" })).status).toBe(
    200,
  );
  const cookieValue = setCookie.mock.calls.find(
    (call) => typeof call[1] === "string",
  )?.[1] as string;
  expect(cookieValue).toBeTruthy();
  vi.mocked(cookies).mockResolvedValue({
    get: () => ({ value: cookieValue }),
    set: setCookie,
    delete: vi.fn(),
  } as any);
  expect((await currentUser()).id).toBe(ids[0]);
  const sessionCount = await db.session.count({ where: { userId: ids[0] } });
  setCookie.mockClear();
  const findUser = vi
    .spyOn(db.user, "findUnique")
    .mockRejectedValueOnce(new Error("fixture database unavailable"));
  const failed = await call("login", { email, password: "newpass8" });
  expect(failed.status).toBe(500);
  const requestId = failed.headers.get("x-request-id");
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect((await failed.json()).requestId).toBe(requestId);
  expect(setCookie).not.toHaveBeenCalled();
  findUser.mockRestore();
  const logout = await call("logout", {});
  expect(logout.status).toBe(200);
  expect(await db.session.count({ where: { userId: ids[0] } })).toBeLessThan(
    sessionCount,
  );
});
it("rejects an expired session without changing the cookie", async () => {
  const expiredToken = `expired-${crypto.randomUUID()}`;
  await db.session.create({
    data: {
      id: hash(expiredToken),
      userId: ids[0],
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  const remove = vi.fn();
  vi.mocked(cookies).mockResolvedValue({
    get: () => ({ value: expiredToken }),
    set: setCookie,
    delete: remove,
  } as any);
  const response = await api(new Request(`${origin}/api/bootstrap`), [
    "bootstrap",
  ]);
  expect(response.status).toBe(401);
  expect(remove).not.toHaveBeenCalled();
});
it("rejects missing/null/empty credentials with actionable field errors and no session", async () => {
  const sessions = await db.session.count({ where: { userId: ids[0] } });
  for (const [body, field] of [
    [{ password: "eight123" }, "email"],
    [{ email }, "password"],
    [{ email: null, password: "eight123" }, "email"],
    [{ email, password: null }, "password"],
    [{ email: "", password: "eight123" }, "email"],
    [{ email, password: "" }, "password"],
    [{ email: "invalid-email", password: "eight123" }, "email"],
  ] as const) {
    const response = await call("login", body);
    expect(response.status).toBe(422);
    const result = await response.json();
    expect(result.fieldErrors[field]).toBe(
      field === "password"
        ? "Enter your password."
        : body.email === "invalid-email"
          ? "Enter a valid email address."
          : "Enter your email address.",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /Invalid input|expected string|eight123/,
    );
  }
  expect(await db.session.count({ where: { userId: ids[0] } })).toBe(sessions);
});
it("rejects invalid credentials consistently without revealing account existence", async () => {
  for (const [account, password] of [
    [email, "wrong-password"],
    [`unknown-${crypto.randomUUID()}@example.test`, "eight123"],
    [email, "wrong"],
  ]) {
    const response = await call("login", { email: account, password });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Email or password is incorrect",
    });
  }
});
it("creates a normal account with an eight-character password and supports subsequent login", async () => {
  const signupEmail = `signup-${crypto.randomUUID()}@example.test`;
  expect(
    (
      await call("signup", {
        email: signupEmail,
        name: "Signup fixture",
        password: "short7",
      })
    ).status,
  ).toBe(422);
  expect(
    await db.user.findUnique({ where: { email: signupEmail } }),
  ).toBeNull();
  expect(
    (
      await call("signup", {
        email: signupEmail,
        name: "Signup fixture",
        password: "eight123",
        role: "ADMIN",
      })
    ).status,
  ).toBe(200);
  const account = await db.user.findUniqueOrThrow({
    where: { email: signupEmail },
  });
  ids.push(account.id);
  expect(account.role).toBe("USER");
  expect(await bcrypt.compare("eight123", account.password)).toBe(true);
  expect(
    (await call("login", { email: signupEmail, password: "eight123" })).status,
  ).toBe(200);
});
it("handles missing recovery/reset fields and accepts an eight-character replacement via a one-use reset", async () => {
  const recovery = await call("recover", { email: null });
  expect(recovery.status).toBe(422);
  expect((await recovery.json()).fieldErrors.email).toBe(
    "Enter your email address.",
  );
  const missing = await call("reset", { token: null, password: "eight123" });
  expect(missing.status).toBe(422);
  expect((await missing.json()).fieldErrors.token).toContain(
    "Request a new link",
  );
  const token = `fixture-reset-${crypto.randomUUID()}`;
  await db.reset.create({
    data: {
      id: hash(token),
      userId: ids[0],
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  expect((await call("reset", { token, password: "newpass8" })).status).toBe(
    200,
  );
  expect((await call("login", { email, password: "newpass8" })).status).toBe(
    200,
  );
  expect((await call("reset", { token, password: "newpass8" })).status).toBe(
    422,
  );
});

const withIp = (action: string, body: unknown, ip: string) =>
  api(
    new Request(`${origin}/api/auth/${action}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Forwarded-For": ip,
      },
      body: JSON.stringify(body),
    }),
    ["auth", action],
  );
const rateKeys = async (prefix: string) =>
  (await db.rateLimit.findMany({ where: { key: { startsWith: prefix } } })).map(
    (r) => r.key,
  );
it("limits one account across many trusted IPs without storing the raw email", async () => {
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
  const target = `Victim-${crypto.randomUUID()}@Example.test`;
  for (let attempt = 0; attempt < 10; attempt++)
    expect(
      (
        await withIp(
          "login",
          { email: target, password: "x" },
          `198.51.100.${attempt}`,
        )
      ).status,
    ).toBe(401);
  // Same account, brand-new IP, different letter case: still limited.
  expect(
    (
      await withIp(
        "login",
        { email: target.toLowerCase(), password: "x" },
        "203.0.113.200",
      )
    ).status,
  ).toBe(429);
  // A different account from a fresh IP is unaffected, so there is no global lock.
  expect(
    (
      await withIp(
        "login",
        { email: `other-${crypto.randomUUID()}@example.test`, password: "x" },
        "203.0.113.201",
      )
    ).status,
  ).toBe(401);
  const keys = (await rateKeys("auth:")).join(" ");
  expect(keys).not.toContain("victim");
  expect(keys).not.toContain("@");
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
});
it("limits one trusted IP across many accounts", async () => {
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
  for (let attempt = 0; attempt < 10; attempt++)
    expect(
      (
        await withIp(
          "login",
          {
            email: `ip-${attempt}-${crypto.randomUUID()}@example.test`,
            password: "x",
          },
          "192.0.2.50",
        )
      ).status,
    ).toBe(401);
  expect(
    (
      await withIp(
        "login",
        { email: `ip-x-${crypto.randomUUID()}@example.test`, password: "x" },
        "192.0.2.50",
      )
    ).status,
  ).toBe(429);
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
});
it("refuses authentication in production unless a trusted proxy is configured", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TRUST_PROXY", "");
  expect(
    (await withIp("login", { email, password: "x" }, "192.0.2.60")).status,
  ).toBe(503);
  vi.stubEnv("TRUST_PROXY", "true");
  // Trusted proxy mode without a client IP header is a proxy misconfiguration.
  const noHeader = await api(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "x" }),
    }),
    ["auth", "login"],
  );
  expect(noHeader.status).toBe(503);
  expect(
    (await withIp("login", { email, password: "x" }, "192.0.2.61")).status,
  ).toBe(401);
  vi.stubEnv("NODE_ENV", "test");
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
});
it("returns the same recovery response for unknown, known and undeliverable accounts with per-IP and per-email limits", async () => {
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "recover:" } } });
  const original = process.env.RECOVERY_WEBHOOK_URL;
  delete process.env.RECOVERY_WEBHOOK_URL; // delivery unconfigured
  const known = await withIp("recover", { email }, "192.0.2.70");
  const unknown = await withIp(
    "recover",
    { email: `nobody-${crypto.randomUUID()}@example.test` },
    "192.0.2.71",
  );
  expect(known.status).toBe(200);
  expect(unknown.status).toBe(200);
  expect(await known.json()).toEqual(await unknown.json());
  // Per-email limit (3/hour) applies regardless of the source IP.
  const target = `limited-${crypto.randomUUID()}@example.test`;
  for (let attempt = 0; attempt < 3; attempt++)
    expect(
      (await withIp("recover", { email: target }, `192.0.2.${100 + attempt}`))
        .status,
    ).toBe(200);
  expect(
    (await withIp("recover", { email: target }, "192.0.2.200")).status,
  ).toBe(429);
  // No single global recovery bucket: many different accounts and IPs still work.
  for (let attempt = 0; attempt < 8; attempt++)
    expect(
      (
        await withIp(
          "recover",
          { email: `many-${attempt}-${crypto.randomUUID()}@example.test` },
          `198.18.0.${attempt}`,
        )
      ).status,
    ).toBe(200);
  expect((await rateKeys("recover:")).join(" ")).not.toContain("@");
  if (original) process.env.RECOVERY_WEBHOOK_URL = original;
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "recover:" } } });
});
