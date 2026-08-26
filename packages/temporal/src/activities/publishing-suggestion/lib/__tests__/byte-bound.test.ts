import { describe, expect, it } from "vitest";
import {
	boundContextToBudget,
	byteBoundItems,
	PER_SOURCE_MAX_BYTES,
	TOTAL_CONTEXT_MAX_BYTES,
} from "../byte-bound";

/** A string of roughly `n` ASCII bytes. */
function bigString(n: number): string {
	return "x".repeat(n);
}

describe("byteBoundItems", () => {
	it("leaves a small items array unchanged", () => {
		const items = [{ id: "1", title: "a" }];
		const result = byteBoundItems(items);

		expect(result.trimmed).toBe(false);
		expect(result.items).toEqual(items);
	});

	// H3 (a): an oversized individual value — a multi-KB string field on a single
	// item — is truncated so the serialized result fits, but the item itself is
	// RETAINED (not dropped to zero).
	it("truncates an oversized field on a single item rather than dropping it", () => {
		const items = [
			{
				id: "doc-1",
				title: "Design doc",
				summary: bigString(PER_SOURCE_MAX_BYTES * 2),
			},
		];

		const result = byteBoundItems(items);

		expect(result.trimmed).toBe(true);
		expect(result.items).toHaveLength(1); // retained, not dropped
		expect(result.items[0]?.id).toBe("doc-1"); // short fields preserved
		expect(
			Buffer.byteLength(JSON.stringify(result.items), "utf8"),
		).toBeLessThanOrEqual(PER_SOURCE_MAX_BYTES);
	});

	// H3 (b): an aggregate over budget — many large items — is capped so the
	// serialized array fits, while at least one item survives.
	it("caps an array of many large items so the aggregate fits, keeping at least one", () => {
		const items = Array.from({ length: 500 }, (_, i) => ({
			id: `item-${i}`,
			body: bigString(2000),
		}));

		const result = byteBoundItems(items);

		expect(result.trimmed).toBe(true);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.length).toBeLessThan(items.length);
		expect(
			Buffer.byteLength(JSON.stringify(result.items), "utf8"),
		).toBeLessThanOrEqual(PER_SOURCE_MAX_BYTES);
	});
});

// Codex round-2 N1: each of the 5 collectors is byte-bounded individually
// (PER_SOURCE_MAX_BYTES ≈ 300KB), but nothing bounded the AGGREGATE context
// handed to the summarizer prompt — a busy project with all 5 sources near
// their per-source cap could still assemble a ~1.5MB prompt.
describe("boundContextToBudget", () => {
	it("leaves a small context unchanged", () => {
		const context = {
			stories: [{ id: "story-1", title: "Onboarding" }],
			pullRequests: [{ repoFullName: "acme/web", prNumber: 4 }],
		};

		const result = boundContextToBudget(context);

		expect(result.trimmed).toBe(false);
		expect(result.context).toEqual(context);
	});

	it("bounds a context with all 5 sources each near the per-source cap to the total budget, keeping at least one item per source", () => {
		// Each source individually is under PER_SOURCE_MAX_BYTES (as a real
		// collector would return), but 5 of them together are ~1.5MB — well
		// over TOTAL_CONTEXT_MAX_BYTES.
		const makeItems = (prefix: string) =>
			Array.from({ length: 150 }, (_, i) => ({
				id: `${prefix}-${i}`,
				body: bigString(2000),
			}));

		const context = {
			stories: makeItems("story"),
			documents: makeItems("doc"),
			transcripts: makeItems("transcript"),
			pullRequests: makeItems("pr"),
			releases: makeItems("release"),
		};
		const originalBytes = Buffer.byteLength(
			JSON.stringify(context),
			"utf8",
		);
		expect(originalBytes).toBeGreaterThan(1_000_000); // sanity: ~1.5MB aggregate

		const result = boundContextToBudget(context);

		expect(result.trimmed).toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(result.context), "utf8"),
		).toBeLessThanOrEqual(TOTAL_CONTEXT_MAX_BYTES);
		// At least one item survives per source — the guard must not zero out
		// a source entirely (that would silently erase provenance for a whole
		// category rather than degrading gracefully).
		for (const key of Object.keys(context)) {
			const items = (result.context as Record<string, unknown[]>)[key];
			expect(Array.isArray(items)).toBe(true);
			expect((items as unknown[]).length).toBeGreaterThan(0);
		}
	});
});
