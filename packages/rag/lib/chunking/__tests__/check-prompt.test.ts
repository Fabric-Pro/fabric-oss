import { describe, expect, it } from "vitest";
import { chunkingCheckPrompt } from "../check-prompt";

const now = new Date("2026-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function check(
	lastCheck: Parameters<typeof chunkingCheckPrompt>[0]["lastCheck"],
	current: { sources: number; addedSince: number; embeddingModel?: string },
) {
	return chunkingCheckPrompt({
		now,
		lastCheck,
		current: { embeddingModel: "model-a", ...current },
	})?.reason;
}

describe("chunkingCheckPrompt", () => {
	it("offers a first check only once there is enough content", () => {
		expect(check(null, { sources: 5, addedSince: 5 })).toBeUndefined();
		expect(check(null, { sources: 40, addedSince: 40 })).toBe(
			"never-checked",
		);
	});

	it("offers a check when the embedding model changed", () => {
		expect(
			check(
				{ at: daysAgo(2), sources: 100, embeddingModel: "model-a" },
				{ sources: 100, addedSince: 0, embeddingModel: "model-b" },
			),
		).toBe("model-changed");
	});

	it("offers a check when the content grew or shrank by half", () => {
		const last = {
			at: daysAgo(10),
			sources: 100,
			embeddingModel: "model-a",
		};
		expect(check(last, { sources: 160, addedSince: 60 })).toBe(
			"content-changed",
		);
		expect(check(last, { sources: 40, addedSince: 0 })).toBe(
			"content-changed",
		);
		expect(check(last, { sources: 130, addedSince: 30 })).toBeUndefined();
	});

	it("offers a check after 200 new sources however large the project is", () => {
		expect(
			check(
				{ at: daysAgo(10), sources: 2000, embeddingModel: "model-a" },
				{ sources: 2200, addedSince: 200 },
			),
		).toBe("content-changed");
	});

	it("after 90 days, a smaller change is enough, but no change is not", () => {
		const last = {
			at: daysAgo(120),
			sources: 100,
			embeddingModel: "model-a",
		};
		expect(check(last, { sources: 125, addedSince: 25 })).toBe("stale");
		expect(check(last, { sources: 105, addedSince: 5 })).toBeUndefined();
	});

	it("works with a check that kept no snapshot", () => {
		const last = { at: daysAgo(10), sources: null, embeddingModel: null };
		expect(check(last, { sources: 100, addedSince: 60 })).toBe(
			"content-changed",
		);
		expect(check(last, { sources: 100, addedSince: 10 })).toBeUndefined();
	});
});
