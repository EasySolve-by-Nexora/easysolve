import "dotenv/config";
import { cookies } from "next/headers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { db } from "../lib/db";
import { hash } from "../lib/security";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const origin = "http://localhost:3000";
const ids: string[] = [];
let adminId = "",
  userId = "",
  identityId = "",
  token = "";
async function as(id: string | null) {
  token = "";
  if (!id) return;
  token = `identity-test-${crypto.randomUUID()}`;
  await db.session.create({
    data: {
      id: hash(token),
      userId: id,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
}
const remove = (reason = "Operator requested removal") =>
  api(
    new Request(
      `${origin}/api/admin/users/${userId}/identities/${identityId}/delete`,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      },
    ),
    ["admin", "users", userId, "identities", identityId, "delete"],
  );
const run = (status: string) =>
  db.run.create({
    data: {
      userId,
      identityId,
      repo: "a/b",
      issueIds: [],
      title: `Run ${status}`,
      branch: `identity-${crypto.randomUUID()}`,
      status,
    },
  });
beforeAll(async () => {
  vi.stubEnv("APP_URL", origin);
  vi.mocked(cookies).mockImplementation(
    async () =>
      ({
        get: () => (token ? { value: token } : undefined),
        set: vi.fn(),
        delete: vi.fn(),
      }) as any,
  );
  const mk = async (role: "ADMIN" | "USER") =>
    (
      await db.user.create({
        data: {
          email: `identity-${crypto.randomUUID()}@example.test`,
          name: "Identity fixture",
          password: "fixture",
          role,
        },
      })
    ).id;
  adminId = await mk("ADMIN");
  userId = await mk("USER");
  ids.push(adminId, userId);
  identityId = (
    await db.identity.create({
      data: { userId, login: "removable", token: "encrypted-fixture" },
    })
  ).id;
});
afterAll(async () => {
  await db.adminAudit.deleteMany({ where: { actorId: adminId } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  vi.unstubAllEnvs();
  await db.$disconnect();
});

it("is administrator-only", async () => {
  await as(null);
  expect((await remove()).status).toBe(401);
  await as(userId);
  expect((await remove()).status).toBe(403);
  expect(await db.identity.count({ where: { id: identityId } })).toBe(1);
});

it("requires a reason and refuses while work is active or unsettled", async () => {
  await as(adminId);
  expect((await remove("no")).status).toBe(422);
  for (const status of ["queued", "running", "awaiting_review", "published"]) {
    const blocking = await run(status);
    const response = await remove();
    expect(response.status, status).toBe(409);
    await db.run.delete({ where: { id: blocking.id } });
  }
  expect(await db.identity.count({ where: { id: identityId } })).toBe(1);
});

it("deletes the credential, frees the slot and writes an audit record", async () => {
  await db.run.deleteMany({ where: { userId } });
  await as(adminId);
  expect((await remove("Wrong account connected")).status).toBe(200);
  expect(await db.identity.count({ where: { userId } })).toBe(0);
  const audit = await db.adminAudit.findFirstOrThrow({
    where: { actorId: adminId, action: "identity.delete" },
  });
  expect(audit).toMatchObject({
    targetId: userId,
    reason: "Wrong account connected",
    newValues: { deleted: true },
  });
  expect(JSON.stringify(audit)).not.toContain("encrypted-fixture");
});
