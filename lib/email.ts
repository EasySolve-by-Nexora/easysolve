const SENDER = "EasySolve <easysolve@nexoratech.works>";

type Email = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

function appUrl() {
  const value = process.env.APP_URL?.replace(/\/$/, "");
  if (!value) throw new Error("APP_URL is required for transactional email");
  return value;
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>\"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

async function sendWithResend(email: Email) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": email.idempotencyKey,
    },
    body: JSON.stringify({
      from: SENDER,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      html: email.html,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`Resend delivery failed (${response.status})`);
}

function emailShell(content: string) {
  const logo = `${appUrl()}/easysolve-logo.svg`;
  return `<!doctype html>
<html><body style="margin:0;background:#f4f2e9;padding:32px 16px;font-family:Arial,sans-serif;color:#191a17">
  <main style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e2d6;border-radius:20px;padding:40px">
    <img src="${logo}" alt="EasySolve" width="180" height="42" style="display:block;width:180px;height:auto;margin:0 0 34px" />
    ${content}
    <p style="margin:36px 0 0;color:#716e66;font-size:13px;line-height:20px">EasySolve by Nexora</p>
  </main>
</body></html>`;
}

export async function sendWelcomeEmail({
  userId,
  email,
  name,
}: {
  userId: string;
  email: string;
  name: string;
}) {
  const firstName = escapeHtml(name.trim() || "there");
  await sendWithResend({
    to: email,
    subject: "Welcome to EasySolve",
    text: `Welcome to EasySolve, ${name.trim() || "there"}. Your workspace is ready.`,
    html: emailShell(`<h1 style="margin:0 0 16px;font-size:30px;line-height:36px">Welcome to EasySolve, ${firstName}.</h1>
      <p style="margin:0;color:#4f4d47;font-size:16px;line-height:25px">Your workspace is ready. Connect a repository, describe the issue, and let EasySolve help you move it forward.</p>`),
    idempotencyKey: `easysolve-welcome-${userId}`,
  });
}

export async function sendPasswordResetEmail({
  email,
  url,
  tokenHash,
}: {
  email: string;
  url: string;
  tokenHash: string;
}) {
  const safeUrl = escapeHtml(url);
  await sendWithResend({
    to: email,
    subject: "Reset your EasySolve password",
    text: `Reset your EasySolve password: ${url}\n\nThis link expires in 30 minutes. If you did not request this, you can safely ignore this email.`,
    html: emailShell(`<h1 style="margin:0 0 16px;font-size:30px;line-height:36px">Reset your password</h1>
      <p style="margin:0 0 26px;color:#4f4d47;font-size:16px;line-height:25px">Use the secure link below to choose a new EasySolve password. It expires in 30 minutes.</p>
      <a href="${safeUrl}" style="display:inline-block;background:#9b8cff;border-radius:999px;color:#191a17;font-weight:700;padding:14px 22px;text-decoration:none">Reset password</a>
      <p style="margin:26px 0 0;color:#716e66;font-size:13px;line-height:20px">If you did not request a password reset, you can safely ignore this email.</p>`),
    idempotencyKey: `easysolve-reset-${tokenHash}`,
  });
}
