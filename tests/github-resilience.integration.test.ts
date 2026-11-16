import "dotenv/config";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "../lib/db";
import {
  GitHub,
  reviewPullRequest,
  reviewQueue,
  syncIssues,
  syncRepositoryStats,
} from "../lib/github";
import { encrypt } from "../lib/security";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
let userId = "",
  identityId = "";
const json = (value: unknown, status = 200) => Response.json(value, { status });
function route(handler: (url: URL) => Response | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      return (
        handler(url) ?? json({ message: "unexpected " + url.pathname }, 500)
      );
    }),
  );
}
beforeAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.GITHUB_MIN_INTERVAL_MS = "100";
  userId = (
    await db.user.create({
      data: {
        email: `resilience-${crypto.randomUUID()}@example.test`,
        name: "Resilience fixture",
        password: "test-only",
      },
    })
  ).id;
  identityId = (
    await db.identity.create({
      data: {
        userId,
        login: "fixture-user",
        token: encrypt("provider-fixture-token"),
      },
    })
  ).id;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

it("keeps syncing when one old issue is gone, frees issues after a closed PR, and revives reopened issues", async () => {
  const mk = (repo: string, number: number, status: string) =>
    db.issue.create({
      data: {
        userId,
        identityId,
        repo,
        number,
        title: `Fixture ${repo}#${number}`,
        url: `https://github.com/${repo}/issues/${number}`,
        assignees: ["fixture-user"],
        status,
      },
    });
  const gone = await mk("gone/repo", 1, "ready");
  const reopened = await mk("a/b", 2, "done");
  const stuck = await mk("c/d", 3, "in_progress");
  const run = await db.run.create({
    data: {
      userId,
      identityId,
      repo: "c/d",
      issueIds: [stuck.id],
      title: "Closed PR run",
      branch: `closed-${crypto.randomUUID()}`,
      status: "published",
      prNumber: 9,
    },
  });
  await db.solveClaim.create({
    data: { userId, issueId: stuck.id, runId: run.id, status: "reserved" },
  });
  route((url) => {
    if (url.pathname === "/issues")
      return json([
        {
          repository: { full_name: "a/b" },
          number: 2,
          title: "Reopened",
          body: "",
          labels: [],
          assignees: [{ login: "fixture-user" }],
          html_url: "https://github.com/a/b/issues/2",
          state: "open",
        },
      ]);
    if (url.pathname === "/search/issues") return json({ items: [] });
    if (url.pathname === "/repos/gone/repo/issues/1")
      return json({ message: "Not Found" }, 404);
    if (url.pathname === "/repos/c/d/pulls/9")
      return json({ merged: false, state: "closed" });
    // Issue 3 (c/d) is still assigned but absent from the feeds above.
    if (url.pathname === "/repos/c/d/issues/3")
      return json({ state: "open", assignees: [{ login: "fixture-user" }] });
  });
  await expect(syncIssues(userId, identityId)).resolves.toBeDefined();
  expect(
    await db.issue.findUniqueOrThrow({ where: { id: gone.id } }),
  ).toMatchObject({ status: "unavailable", assignees: [] });
  expect(
    (await db.issue.findUniqueOrThrow({ where: { id: reopened.id } })).status,
  ).toBe("ready");
  expect(
    (await db.issue.findUniqueOrThrow({ where: { id: stuck.id } })).status,
  ).toBe("ready");
  expect(
    await db.run.findUniqueOrThrow({ where: { id: run.id } }),
  ).toMatchObject({ status: "cancelled" });
  expect(
    (await db.solveClaim.findFirstOrThrow({ where: { runId: run.id } })).status,
  ).toBe("released");
  expect(
    (await db.identity.findUniqueOrThrow({ where: { id: identityId } })).status,
  ).toBe("connected");
});

it("still fails the sync on rate limits instead of hiding them", async () => {
  await db.issue.deleteMany({ where: { userId } });
  await db.issue.create({
    data: {
      userId,
      identityId,
      repo: "limited/repo",
      number: 1,
      title: "Limited",
      url: "https://github.com/limited/repo/issues/1",
      assignees: ["fixture-user"],
    },
  });
  route((url) => {
    if (url.pathname === "/issues") return json([]);
    if (url.pathname === "/search/issues") return json({ items: [] });
    if (url.pathname.startsWith("/repos/limited/"))
      return json({ message: "rate limit" }, 429);
  });
  await expect(syncIssues(userId, identityId)).rejects.toMatchObject({
    status: 429,
  });
  await db.githubThrottle.deleteMany({
    where: { key: `github:user:${userId}` },
  });
});

const sha = "f".repeat(40);
const pull = {
  number: 1,
  title: "PR",
  html_url: "https://github.com/a/b/pull/1",
  head: { sha },
  user: { login: "author" },
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  additions: 1,
  deletions: 1,
  updated_at: "2026-11-16T00:00:00Z",
};
const checkRun = (conclusion: string) => ({
  status: "completed",
  conclusion,
});
function prRoutes(lastRun: string) {
  return (url: URL) => {
    if (url.pathname === "/repos/a/b/pulls/1") return json(pull);
    if (url.pathname === "/repos/a/b/pulls/1/reviews")
      return json([
        { state: "APPROVED", commit_id: sha, user: { login: "reviewer" } },
      ]);
    if (url.pathname === `/repos/a/b/commits/${sha}/check-runs`) {
      const page = Number(url.searchParams.get("page") ?? 1);
      return json({
        total_count: 101,
        check_runs:
          page === 1
            ? Array.from({ length: 100 }, () => checkRun("success"))
            : [checkRun(lastRun)],
      });
    }
    if (url.pathname === `/repos/a/b/commits/${sha}/status`)
      return json({ state: "success", total_count: 1 });
  };
}
it("sees a failing check run beyond GitHub's first page of 30/100", async () => {
  route(prRoutes("failure"));
  const failing = await reviewPullRequest(new GitHub("t"), "a/b", "id", 1);
  expect(failing.checks).toBe("failure");
  expect(failing.category).toBe("ci_failing");
  route(prRoutes("success"));
  const passing = await reviewPullRequest(new GitHub("t"), "a/b", "id", 1);
  expect(passing.category).toBe("ready");
});

it("keeps the review queue working when one repository's identity was removed", async () => {
  const healthy = await db.repository.create({
    data: { userId, identityId, fullName: "ok/repo" },
  });
  const orphan = await db.repository.create({
    data: { userId, identityId: "removed-identity", fullName: "orphan/repo" },
  });
  route((url) => {
    if (url.pathname === "/repos/ok/repo/pulls") return json([]);
  });
  await expect(reviewQueue(userId)).resolves.toEqual([]);
  await db.repository.deleteMany({
    where: { id: { in: [healthy.id, orphan.id] } },
  });
});

it("computes repository stats from search counts, not capped pagination", async () => {
  const repository = await db.repository.create({
    data: { userId, identityId, fullName: "big/repo" },
  });
  const urls: string[] = [];
  route((url) => {
    urls.push(url.pathname + url.search);
    if (url.pathname === "/repos/big/repo")
      return json({ permissions: { maintain: true } });
    if (url.pathname === "/search/issues") {
      const q = url.searchParams.get("q") ?? "";
      const total_count = q.includes("no:assignee")
        ? 4000
        : q.includes("is:issue")
          ? 5000
          : q.includes("is:merged")
            ? 12000
            : 300;
      return json({ total_count, items: [] });
    }
    if (url.pathname === "/repos/big/repo/pulls")
      return json([
        {
          title: "Recent",
          number: 1,
          user: { login: "x" },
          state: "closed",
          merged_at: "2026-11-15T00:00:00Z",
          html_url: "https://github.com/big/repo/pull/1",
        },
      ]);
    if (url.pathname === "/repos/big/repo/contributors") return json([]);
  });
  const saved = await syncRepositoryStats(userId, repository.id);
  expect(saved.stats).toMatchObject({
    openIssues: 5000,
    assignedIssues: 1000,
    openPRs: 300,
    mergedPRs: 12000,
  });
  expect(urls.some((u) => /[?&]page=/.test(u))).toBe(false);
  await db.repository.delete({ where: { id: repository.id } });
});
