import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The generated Zod barrel must be committed as the output of the patching
// pipeline (`pnpm --filter @repo/database generate`), never as raw
// `prisma generate` output. Raw output references Prisma.Decimal without
// importing it — every suite importing the barrel then dies at import time
// with "ReferenceError: Prisma is not defined" — and leaves BigInt defaults
// as string literals. This has broken master twice; the assertions below make
// the raw form fail fast in the barrel's own package.
describe("generated zod barrel", () => {
	const barrel = readFileSync(
		join(__dirname, "../prisma/zod/index.ts"),
		"utf8",
	);

	it("contains no unpatched Prisma.Decimal instanceof sites", () => {
		expect(barrel).not.toContain("z.instanceof(Prisma.Decimal");
	});

	it("imports cleanly", async () => {
		const mod = await import("../prisma/zod/index.js");
		expect(Object.keys(mod).length).toBeGreaterThan(0);
	});
});
