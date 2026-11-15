import { beforeAll } from "vitest";
import { db } from "../lib/db";

// Auth requests without a forwarded IP share one development key. Start every test file with a
// clean bucket so earlier files cannot exhaust it and cause spurious 429s.
beforeAll(async () => {
  await db.rateLimit.deleteMany({
    where: {
      OR: [{ key: { startsWith: "auth:" } }, { key: { startsWith: "recover:" } }],
    },
  });
});
