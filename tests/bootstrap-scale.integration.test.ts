import "dotenv/config";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "../lib/db";
import { handleBootstrap } from "../lib/routes/bootstrap";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
let userId = "";
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: {
        email: `bootstrap-${crypto.randomUUID()}@example.test`,
        name: "Bootstrap fixture",
        password: "fixture",
      },
    })
  ).id;
});
afterAll(async () => {
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
async function bootstrap() {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const response = await handleBootstrap({
    request: new Request("http://localhost/api/bootstrap"),
    path: ["bootstrap"],
    body: {},
    url: new URL("http://localhost/api/bootstrap"),
    u,
  } as any);
  return response!.json();
}
it("returns exact usage totals as one row per day instead of one per request", async () => {
  const now = new Date();
  await db.usage.createMany({
    data: Array.from({ length: 6 }, (_, n) => ({
      userId,
      purpose: "fixture",
      model: "m",
      provider: "deepseek",
      input: 10,
      cached: 2,
      reasoning: 1,
      output: 5,
      total: 15 + n,
      createdAt: now,
    })),
  });
  const body = await bootstrap();
  expect(body.usage).toHaveLength(1);
  expect(body.usage[0]).toMatchObject({
    input: 60,
    cached: 12,
    reasoning: 6,
    output: 30,
    total: 15 * 6 + 15,
    requests: 6,
  });
  expect(new Date(body.usage[0].createdAt).getUTCDate()).toBe(now.getUTCDate());
  // The cycle allowance still matches the sum of the rows.
  expect(body.allowance.total).toBe(105);
});
it("caps chat history to the newest 500 messages, oldest first", async () => {
  await db.message.createMany({
    data: Array.from({ length: 510 }, (_, n) => ({
      userId,
      role: "user",
      content: `m${n}`,
      createdAt: new Date(Date.now() - (510 - n) * 1000),
    })),
  });
  const { messages } = await bootstrap();
  expect(messages).toHaveLength(500);
  expect(messages[0].content).toBe("m10");
  expect(messages.at(-1).content).toBe("m509");
});
