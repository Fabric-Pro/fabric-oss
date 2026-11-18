import { expect, it, vi } from "vitest";

vi.mock("../client", () => ({ db: {} }));

import { slugifyKnowledgeKey } from "./knowledge";

it("normalizes hostile topic keys promptly", () => {
	const start = performance.now();
	expect(slugifyKnowledgeKey(`a${"-".repeat(50000)}.`)).toBe(
		`a${"-".repeat(79)}`,
	);
	expect(slugifyKnowledgeKey(" US developer journey ")).toBe(
		"us-developer-journey",
	);
	expect(performance.now() - start).toBeLessThan(500);
});
