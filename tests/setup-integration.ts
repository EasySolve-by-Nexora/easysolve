import { beforeAll } from "vitest";
import { db } from "../lib/db";

// Unproxied auth requests share one throttle key. Start every test file with a
// clean bucket so earlier files cannot exhaust it and cause spurious 429s.
beforeAll(async () => {
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "auth:" } } });
});
