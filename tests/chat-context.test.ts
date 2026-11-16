import { describe, expect, it } from "vitest";
import { boundedChatContext } from "../lib/chat-context";

const issue = (n: number, bodyBytes: number) => ({
  id: `i${n}`,
  title: `Issue ${n}`,
  body: "x".repeat(bodyBytes),
});
describe("chat context", () => {
  it("keeps small contexts untouched", () => {
    const data = {
      issues: [issue(1, 10), issue(2, 10)],
      runs: [],
      repos: [],
      history: [{ role: "user", content: "hi" }],
    };
    expect(boundedChatContext(data)).toBe(JSON.stringify(data));
  });
  it("stays under the provider input budget with many large issues, keeping the most recent first", () => {
    const issues = Array.from({ length: 50 }, (_, n) => issue(n, 2000));
    const text = boundedChatContext({
      issues,
      runs: [],
      repos: [],
      history: [],
    });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(90000);
    const kept = JSON.parse(text).issues;
    expect(kept.length).toBeGreaterThanOrEqual(5);
    expect(kept[0].id).toBe("i0");
  });
  it("then trims old messages, never below the latest two", () => {
    const history = Array.from({ length: 16 }, (_, n) => ({
      role: "user",
      content: `m${n}-` + "y".repeat(30000),
    }));
    const text = boundedChatContext({
      issues: [],
      runs: [],
      repos: [],
      history,
    });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(90000);
    const kept = JSON.parse(text).history;
    expect(kept.at(-1).content.startsWith("m15-")).toBe(true);
    expect(kept.length).toBeGreaterThanOrEqual(2);
  });
});
