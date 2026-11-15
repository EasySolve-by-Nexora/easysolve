import { afterEach, expect, it, vi } from "vitest";
import { sendPasswordResetEmail, sendWelcomeEmail } from "../lib/email";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("sends branded welcome email through the EasySolve Resend sender", async () => {
  vi.stubEnv("APP_URL", "https://easysolve.example");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  await sendWelcomeEmail({
    userId: "user-1",
    email: "new@example.test",
    name: "Avery",
  });

  expect(fetcher).toHaveBeenCalledWith(
    "https://api.resend.com/emails",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer test-key",
        "Idempotency-Key": "easysolve-welcome-user-1",
      }),
    }),
  );
  const message = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(message.from).toBe("EasySolve <easysolve@nexoratech.works>");
  expect(message.html).toContain(
    "https://easysolve.example/easysolve-logo.svg",
  );
  expect(message.html).toContain("Welcome to EasySolve, Avery.");
});

it("sends password reset links through the same branded sender", async () => {
  vi.stubEnv("APP_URL", "https://easysolve.example");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  await sendPasswordResetEmail({
    email: "member@example.test",
    url: "https://easysolve.example/?reset=one-time-token",
    tokenHash: "hashed-token",
  });

  const message = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(message.subject).toBe("Reset your EasySolve password");
  expect(message.html).toContain(
    "https://easysolve.example/?reset=one-time-token",
  );
  expect(message.html).toContain("easysolve-logo.svg");
});
