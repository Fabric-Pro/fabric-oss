import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../code-indexing";

/**
 * `runWithConcurrency` drives the bounded-parallel embedding of code files.
 * Embedding is the dominant cost of code indexing (one provider round-trip per
 * file), so this pool is what turns an hours-long sequential run into a
 * several-fold-faster one — while staying under provider rate limits.
 */
describe("runWithConcurrency", () => {
	it("processes every item exactly once", async () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		const seen: number[] = [];
		await runWithConcurrency(items, 5, async (i) => {
			seen.push(i);
		});
		expect(seen.sort((a, b) => a - b)).toEqual(items);
	});

	it("runs in parallel but never exceeds the concurrency limit", async () => {
		const items = Array.from({ length: 30 }, (_, i) => i);
		let inFlight = 0;
		let maxInFlight = 0;
		await runWithConcurrency(items, 4, async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight--;
		});
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent
	});

	it("stops pulling new items once shouldStop() is true (fail-fast)", async () => {
		const items = Array.from({ length: 50 }, (_, i) => i);
		const processed: number[] = [];
		let stop = false;
		await runWithConcurrency(
			items,
			2,
			async (i) => {
				processed.push(i);
				if (processed.length >= 4) {
					stop = true;
				}
				await new Promise((r) => setTimeout(r, 1));
			},
			() => stop,
		);
		expect(processed.length).toBeGreaterThanOrEqual(4);
		expect(processed.length).toBeLessThan(items.length);
	});

	it("handles an empty item list without invoking the task", async () => {
		let called = 0;
		await runWithConcurrency([], 5, async () => {
			called++;
		});
		expect(called).toBe(0);
	});
});
