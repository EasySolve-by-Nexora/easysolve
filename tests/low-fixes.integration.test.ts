import "dotenv/config";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chatAction } from "../lib/chat";
import { db } from "../lib/db";
import { handleRepositories } from "../lib/routes/repositories";
const { gh } = vi.hoisted(() => ({ gh: { request: vi.fn(), pages: vi.fn() } }));
vi.mock("../lib/github", () => ({ github: vi.fn().mockResolvedValue(gh) }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
let userId = "";
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: {
        email: `low-${crypto.randomUUID()}@example.test`,
        name: "Low fixture",
        password: "fixture",
      },
    })
  ).id;
});
afterAll(async () => {
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
const importIssue = async (repo: string) =>
  handleRepositories({
    request: new Request("http://localhost/api/issues/import", {
      method: "POST",
    }),
    path: ["issues", "import"],
    body: { identityId: "fixture", repo, number: 5 },
    url: new URL("http://localhost/api/issues/import"),
    u: await db.user.findUniqueOrThrow({ where: { id: userId } }),
  } as any);

it("imports an issue under GitHub's canonical repository name and refreshes it on re-import", async () => {
  gh.request.mockReset();
  gh.request.mockResolvedValue({
    number: 5,
    title: "First title",
    body: "Body",
    labels: [{ name: "Wave" }],
    assignees: [{ login: "me" }],
    html_url: "https://github.com/Stellar/Soroban-Docs/issues/5",
    repository_url: "https://api.github.com/repos/Stellar/Soroban-Docs",
    state: "open",
  });
  await importIssue("stellar/soroban-docs");
  gh.request.mockResolvedValue({
    number: 5,
    title: "Renamed",
    body: "New body",
    labels: [],
    assignees: [],
    html_url: "https://github.com/Stellar/Soroban-Docs/issues/5",
    repository_url: "https://api.github.com/repos/Stellar/Soroban-Docs",
    state: "open",
  });
  await importIssue("STELLAR/SOROBAN-DOCS");
  const rows = await db.issue.findMany({ where: { userId } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    repo: "Stellar/Soroban-Docs",
    title: "Renamed",
    body: "New body",
    assignees: [],
  });
});

it("refuses to prepare a PR without a concrete run id instead of matching any run", async () => {
  await db.run.create({
    data: {
      userId,
      identityId: "fixture",
      repo: "a/b",
      issueIds: [],
      title: "Waiting",
      branch: `low-${crypto.randomUUID()}`,
      status: "awaiting_review",
    },
  });
  const message = await db.message.create({
    data: {
      userId,
      role: "assistant",
      content: "Prepare?",
      activity: [{ type: "confirmation", action: "prepare_pr", ids: [] }],
    },
  });
  await expect(chatAction(userId, message.id)).rejects.toMatchObject({
    status: 422,
  });
});
