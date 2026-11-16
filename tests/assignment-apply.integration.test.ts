import "dotenv/config";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { applyProposal, propose } from "../lib/assignments";
import { HttpError } from "../lib/security";
import { handleContribution } from "../lib/routes/contribution";
import { db } from "../lib/db";
const { gh } = vi.hoisted(() => ({ gh: { request: vi.fn(), pages: vi.fn() } }));
vi.mock("../lib/github", () => ({ github: vi.fn().mockResolvedValue(gh) }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
let userId = "";
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: {
        email: `assignment-${crypto.randomUUID()}@example.test`,
        name: "Assignment fixture",
        password: "fixture",
      },
    })
  ).id;
});
afterAll(async () => {
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
it("rechecks assignments and reports partial failure honestly, retrying only failed entries", async () => {
  const proposal = await db.proposal.create({
    data: {
      userId,
      identityId: "fixture",
      repo: "a/b",
      entries: [
        {
          number: 1,
          title: "First",
          login: "alice",
          existing: 0,
          state: "pending",
        },
        {
          number: 2,
          title: "Second",
          login: "bob",
          existing: 0,
          state: "pending",
        },
      ],
    },
  });
  let applied = false;
  gh.pages.mockResolvedValue([]);
  gh.request.mockImplementation(async (path: string, method?: string) => {
    if (path.endsWith("/1/assignees")) {
      applied = true;
      return { assignees: [{ login: "alice" }] };
    }
    if (path.endsWith("/1"))
      return { state: "open", assignees: applied ? [{ login: "alice" }] : [] };
    if (path.endsWith("/2"))
      return { state: "open", assignees: [{ login: "someone-else" }] };
    throw Error("Unexpected write");
  });
  const result = await applyProposal(userId, proposal.id);
  expect(result.state).toBe("partial");
  expect(result.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ number: 1, state: "applied" }),
      expect.objectContaining({
        number: 2,
        state: "failed",
        error: "Issue is no longer unassigned",
      }),
    ]),
  );
  const writes = gh.request.mock.calls.filter((c) => c[1] === "POST").length;
  await applyProposal(userId, proposal.id);
  expect(gh.request.mock.calls.filter((c) => c[1] === "POST")).toHaveLength(
    writes,
  );
  await expect(applyProposal("different-user", proposal.id)).rejects.toThrow(
    "unavailable",
  );
});

it("claims an application before posting so concurrent retries cannot duplicate comments", async () => {
  const application = await db.application.create({
    data: {
      userId,
      identityId: "fixture",
      repo: "a/b",
      number: 3,
      title: "Apply",
      draft: "I can fix this.",
    },
  });
  let releaseComments!: () => void;
  gh.pages.mockImplementation(
    () => new Promise((resolve) => (releaseComments = () => resolve([]))),
  );
  gh.request.mockImplementation(async (path: string, method?: string) =>
    method === "POST"
      ? { html_url: "https://github.com/a/b/issues/3#issuecomment-1" }
      : { state: "open", assignees: [] },
  );
  const context = {
    request: new Request("http://localhost/api/applications/post", {
      method: "POST",
    }),
    path: ["applications", application.id, "post"],
    body: { draft: "I can fix this." },
    url: new URL("http://localhost/api/applications/post"),
    u: await db.user.findUniqueOrThrow({ where: { id: userId } }),
  } as any;
  const first = handleContribution(context);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = handleContribution(context);
  await expect(second).rejects.toThrow("already in progress");
  releaseComments();
  await first;
  expect(gh.request.mock.calls.filter((c) => c[1] === "POST")).toHaveLength(1);
});

const entry = (over: Record<string, unknown>) => ({
  number: 1,
  title: "Issue",
  login: "Alice",
  existing: 0,
  state: "pending",
  ...over,
});
const proposalFor = (entries: unknown[]) =>
  db.proposal.create({
    data: {
      userId,
      identityId: "fixture",
      repo: "a/b",
      entries: entries as any,
    },
  });

it("treats GitHub logins case-insensitively when applying", async () => {
  const proposal = await proposalFor([entry({ login: "Alice" })]);
  gh.pages.mockResolvedValue([]);
  gh.request.mockReset();
  gh.request.mockImplementation(async (path: string, method?: string) =>
    method === "POST"
      ? { assignees: [{ login: "alice" }] }
      : { state: "open", assignees: [] },
  );
  const result = await applyProposal(userId, proposal.id);
  expect(result.state).toBe("applied");
  expect((result.entries as any[])[0]).toMatchObject({ state: "applied" });
});

it("counts wave proposals like the preview did and lists each login once", async () => {
  // Five non-wave issues already assigned must not block a wave-only assignment.
  const nonWave = Array.from({ length: 5 }, (_, i) => ({
    number: 100 + i,
    labels: [{ name: "bug" }],
  }));
  const proposal = await proposalFor([
    entry({ number: 11, login: "carol", waveOnly: true }),
    entry({ number: 12, login: "carol", waveOnly: true }),
  ]);
  gh.pages.mockReset();
  gh.pages.mockResolvedValue(nonWave);
  gh.request.mockReset();
  gh.request.mockImplementation(async (path: string, method?: string) =>
    method === "POST"
      ? { assignees: [{ login: "carol" }] }
      : { state: "open", assignees: [] },
  );
  const result = await applyProposal(userId, proposal.id);
  expect(result.state).toBe("applied");
  expect(gh.pages).toHaveBeenCalledTimes(1);
});

it("stops at the configured limit using locally tracked counts", async () => {
  const proposal = await proposalFor(
    [21, 22, 23, 24].map((number) => entry({ number, login: "dave" })),
  );
  gh.pages.mockReset();
  gh.pages.mockResolvedValue([]);
  gh.request.mockReset();
  gh.request.mockImplementation(async (path: string, method?: string) =>
    method === "POST"
      ? { assignees: [{ login: "dave" }] }
      : { state: "open", assignees: [] },
  );
  const result = await applyProposal(userId, proposal.id);
  const states = (result.entries as any[]).map((e) => e.state);
  // Default Wave limit is 3 assignments per person.
  expect(states.filter((s) => s === "applied")).toHaveLength(3);
  expect((result.entries as any[])[3].error).toBe("Assignment limit reached");
});

it("keeps a proposal when one username cannot be assigned and reports it", async () => {
  gh.pages.mockReset();
  gh.pages.mockResolvedValue([
    { number: 1, title: "Open", assignees: [], labels: [{ name: "Wave" }] },
  ]);
  gh.request.mockReset();
  gh.request.mockImplementation(async (path: string) => {
    if (path.endsWith("/ghost"))
      throw new HttpError(502, "GitHub 404: request failed");
    return {};
  });
  const proposal = await propose(userId, {
    identityId: "fixture",
    repo: "a/b",
    usernames: ["ghost", "alice"],
    numbers: [],
    labels: "",
    additional: 1,
    waveOnly: true,
  });
  expect(proposal.notAssignable).toEqual(["ghost"]);
  expect((proposal.entries as any[]).map((e) => e.login)).toEqual(["alice"]);
  gh.request.mockImplementation(async () => {
    throw new HttpError(502, "GitHub 404: request failed");
  });
  await expect(
    propose(userId, {
      identityId: "fixture",
      repo: "a/b",
      usernames: ["ghost"],
      numbers: [],
      labels: "",
      additional: 1,
      waveOnly: false,
    }),
  ).rejects.toThrow("does not allow assigning ghost");
});
