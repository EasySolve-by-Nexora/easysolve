import "dotenv/config";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "../lib/db";
import { chooseGithubAccounts } from "../lib/github-accounts";
import { handleAccount } from "../lib/routes/account";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
let userId = "";
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: {
        email: `disconnect-${crypto.randomUUID()}@example.test`,
        name: "Disconnect fixture",
        password: "fixture",
      },
    })
  ).id;
});
afterAll(async () => {
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
it("wipes the stored credential on disconnect and requires a new token to re-enable", async () => {
  const identity = await db.identity.create({
    data: { userId, login: "leaving", token: "encrypted-fixture-token" },
  });
  const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const response = await handleAccount({
    request: new Request("http://localhost/api/identities/x", {
      method: "DELETE",
    }),
    path: ["identities", identity.id],
    body: {},
    url: new URL("http://localhost/api/identities/x"),
    u,
  } as any);
  expect(response?.status).toBe(200);
  expect(
    await db.identity.findUniqueOrThrow({ where: { id: identity.id } }),
  ).toMatchObject({ status: "disconnected", active: false, token: "" });
  await expect(
    chooseGithubAccounts(userId, [identity.id]),
  ).rejects.toMatchObject({ status: 409 });
});
