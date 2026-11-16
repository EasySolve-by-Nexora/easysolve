import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "../db";
import { throttleAuth } from "../auth-throttle";
import { sendPasswordResetEmail, sendWelcomeEmail } from "../email";
import { hash, HttpError, session } from "../security";
import type { RouteContext } from "./types";
import {
  loginSchema,
  signupSchema,
  recoverySchema,
  resetSchema,
  parseAuthInput,
} from "../auth-input";
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status });

export async function handleAuth({
  request,
  path,
  body,
  url,
}: Omit<RouteContext, "u">) {
  const route = path.join("/");
  const method = request.method;
  if (route === "auth/signup" || route === "auth/login") {
    await throttleAuth(request, "login", body?.email);
    if (route === "auth/signup") {
      const input = parseAuthInput(signupSchema, body);
      if (await db.user.findUnique({ where: { email: input.email } }))
        throw new HttpError(409, "An account with this email already exists");
      const u = await db.user.create({
        data: {
          email: input.email,
          name: input.name ?? input.email.split("@")[0],
          password: await bcrypt.hash(input.password, 12),
        },
      });
      // Delivery is deliberately best-effort: an email-provider outage must
      // never prevent a new account from being created or signed in.
      await sendWelcomeEmail({
        userId: u.id,
        email: u.email,
        name: u.name,
      }).catch((error) =>
        console.error("Welcome email delivery failed", {
          userId: u.id,
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );
      await session(u.id);
      return json({ ok: true });
    }
    const input = parseAuthInput(loginSchema, body);
    const u = await db.user.findUnique({ where: { email: input.email } });
    if (!u || !(await bcrypt.compare(input.password, u.password)))
      throw new HttpError(401, "Email or password is incorrect");
    if (u.suspendedAt)
      throw new HttpError(
        403,
        "This account is suspended. Contact the operator.",
      );
    await session(u.id);
    return json({ ok: true });
  }
  if (route === "auth/recover") {
    await throttleAuth(request, "recover", body?.email);
    const { email } = parseAuthInput(recoverySchema, body);
    const generic = json({
      message: "If this account exists, a recovery link has been sent.",
    });
    const u = await db.user.findUnique({ where: { email } });
    // The response never depends on whether the account exists or whether
    // delivery worked, so this endpoint cannot be used to enumerate accounts.
    // Operators see delivery problems in server logs instead.
    if (!u) return generic;
    let resetId: string | undefined;
    try {
      if (!process.env.APP_URL) throw new Error("APP_URL is not configured");
      const token = randomBytes(32).toString("base64url");
      resetId = hash(token);
      await db.reset.create({
        data: {
          id: resetId,
          userId: u.id,
          expiresAt: new Date(Date.now() + 1800000),
        },
      });
      const resetUrl = `${process.env.APP_URL}/?reset=${token}`;
      if (process.env.RESEND_API_KEY) {
        await sendPasswordResetEmail({
          email: u.email,
          url: resetUrl,
          tokenHash: resetId,
        });
      } else if (process.env.RECOVERY_WEBHOOK_URL) {
        const sent = await fetch(process.env.RECOVERY_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.RECOVERY_WEBHOOK_SECRET ?? ""}`,
          },
          body: JSON.stringify({ email: u.email, url: resetUrl }),
          signal: AbortSignal.timeout(10000),
        });
        if (!sent.ok)
          throw new Error(`Recovery webhook returned ${sent.status}`);
      } else {
        throw new Error("No account recovery email provider is configured");
      }
    } catch (error) {
      if (resetId)
        await db.reset
          .delete({ where: { id: resetId } })
          .catch(() => undefined);
      console.error("Account recovery delivery failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    return generic;
  }
  if (route === "auth/reset") {
    await throttleAuth(request, "recover", undefined);
    const input = parseAuthInput(resetSchema, body);
    const password = await bcrypt.hash(input.password, 12);
    await db.$transaction(async (tx) => {
      const r = await tx.reset.findFirst({
        where: { id: hash(input.token), expiresAt: { gt: new Date() } },
      });
      if (!r) throw new HttpError(422, "Recovery link expired");
      // Redeeming one link revokes every outstanding recovery link for the user.
      await tx.reset.deleteMany({ where: { userId: r.userId } });
      await tx.user.update({ where: { id: r.userId }, data: { password } });
      await tx.session.deleteMany({ where: { userId: r.userId } });
    });
    return json({ ok: true });
  }
  return undefined;
}
