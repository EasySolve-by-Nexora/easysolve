import { describe, expect, it } from "vitest";
import { agentLimits, assertWithinAgentLimits } from "../lib/agent-limits";
import {
  hasPassingValidation,
  isMeaningfulValidation,
} from "../lib/agent-validation";
import { waitForActivity } from "../lib/worker-loop";

describe("waitForActivity", () => {
  it("wakes on the poll interval while a long job is still running", async () => {
    const neverFinishes = new Promise<void>(() => {});
    const started = Date.now();
    await waitForActivity(new Set([neverFinishes]), 30);
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("wakes immediately when a job finishes", async () => {
    const started = Date.now();
    await waitForActivity(new Set([Promise.resolve()]), 5000);
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("behaves as a plain sleep with no active jobs", async () => {
    const started = Date.now();
    await waitForActivity(new Set(), 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe("agent limits", () => {
  it("applies safe defaults and clamps configuration", () => {
    expect(agentLimits({})).toEqual({ maxSteps: 40, maxMs: 1500000 });
    expect(
      agentLimits({ AGENT_MAX_STEPS: "100000", AGENT_MAX_SECONDS: "1" }),
    ).toEqual({ maxSteps: 200, maxMs: 60000 });
    expect(agentLimits({ AGENT_MAX_STEPS: "nonsense" }).maxSteps).toBe(40);
  });
  it("stops at the step ceiling", () => {
    const limits = { maxSteps: 3, maxMs: 60000 };
    expect(() =>
      assertWithinAgentLimits({ steps: 2, startedAt: 0, now: 1 }, limits),
    ).not.toThrow();
    expect(() =>
      assertWithinAgentLimits({ steps: 3, startedAt: 0, now: 1 }, limits),
    ).toThrow(/step limit/);
  });
  it("stops at the wall-clock ceiling", () => {
    const limits = { maxSteps: 50, maxMs: 60000 };
    expect(() =>
      assertWithinAgentLimits({ steps: 1, startedAt: 0, now: 60000 }, limits),
    ).not.toThrow();
    expect(() =>
      assertWithinAgentLimits({ steps: 1, startedAt: 0, now: 60001 }, limits),
    ).toThrow(/time limit/);
  });
});

describe("validation guard", () => {
  it.each([
    "npm test",
    "npm run lint",
    "CI=true npm run test",
    "node --test sum.test.cjs",
    "cd app && pytest -q",
    "go test ./...",
    "cargo test",
    "npx vitest run",
    "python3 -m unittest",
    "./run_tests.sh",
  ])("accepts a real validation command: %s", (command) =>
    expect(isMeaningfulValidation(command)).toBe(true),
  );
  it.each([
    "echo tests pass",
    "printf 'test'",
    "true # test",
    "npm test || true",
    "npm test; exit 0",
    "ls tests",
    "cat test.txt",
    "grep -r test .",
  ])("rejects a command that cannot prove anything: %s", (command) =>
    expect(isMeaningfulValidation(command)).toBe(false),
  );

  const block = (command: string, exitCode: number) =>
    `$ ${command}\n${JSON.stringify({ exitCode, stdout: "", stderr: "" })}\n\n`;
  it("requires the last real validation to have passed", () => {
    expect(hasPassingValidation(block("npm test", 0))).toBe(true);
    expect(hasPassingValidation("")).toBe(false);
    expect(hasPassingValidation(block("echo test", 0))).toBe(false);
    // A later failure cannot be masked by an earlier pass.
    expect(
      hasPassingValidation(block("npm test", 0) + block("npm run lint", 1)),
    ).toBe(false);
    // Unrelated passing commands afterwards do not count either way.
    expect(hasPassingValidation(block("npm test", 1) + block("ls", 0))).toBe(
      false,
    );
    expect(hasPassingValidation(block("npm test", 0) + block("ls", 0))).toBe(
      true,
    );
  });
});
