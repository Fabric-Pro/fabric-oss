import { describe, expect, it } from "vitest";
import { forEachPrefetched } from "../ordered-prefetch";

/** A promise whose settlement the test decides. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("forEachPrefetched", () => {
	it("consumes in input order even when later loads finish first", async () => {
		const gates = [0, 1, 2, 3].map(() => deferred<string>());
		const consumed: string[] = [];
		const run = forEachPrefetched(
			[0, 1, 2, 3],
			4,
			(i) => gates[i]?.promise ?? Promise.reject(new Error("no gate")),
			(value) => {
				consumed.push(value);
			},
		);
		gates[3]?.resolve("d");
		gates[2]?.resolve("c");
		gates[1]?.resolve("b");
		await tick();
		expect(consumed).toEqual([]);
		gates[0]?.resolve("a");
		await run;
		expect(consumed).toEqual(["a", "b", "c", "d"]);
	});

	it("reports how many items are fully consumed, in order, after each consume", async () => {
		const events: string[] = [];
		await forEachPrefetched(
			["a", "b", "c"],
			3,
			async (item) => item,
			async (item) => {
				await tick();
				events.push(`consume ${item}`);
			},
			(consumed) => {
				events.push(`consumed ${consumed}`);
			},
		);
		expect(events).toEqual([
			"consume a",
			"consumed 1",
			"consume b",
			"consumed 2",
			"consume c",
			"consumed 3",
		]);
	});

	it("never reports an item whose consume threw", async () => {
		const reported: number[] = [];
		await expect(
			forEachPrefetched(
				[1, 2, 3],
				3,
				async (n) => n,
				(n) => {
					if (n === 2) {
						throw new Error("boom");
					}
				},
				(consumed) => {
					reported.push(consumed);
				},
			),
		).rejects.toThrow("boom");
		expect(reported).toEqual([1]);
	});

	it("never holds more than `limit` loaded or loading items at once", async () => {
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 50 }, (_, i) => i);
		await forEachPrefetched(
			items,
			8,
			async (i) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, (i * 7) % 5));
				return i;
			},
			async () => {
				await tick();
				inFlight--;
			},
		);
		expect(peak).toBe(8);
		expect(inFlight).toBe(0);
	});

	it("overlaps loads instead of running them one at a time", async () => {
		let concurrent = 0;
		let peak = 0;
		await forEachPrefetched(
			Array.from({ length: 20 }, (_, i) => i),
			8,
			async (i) => {
				concurrent++;
				peak = Math.max(peak, concurrent);
				await new Promise((r) => setTimeout(r, 2));
				concurrent--;
				return i;
			},
			() => undefined,
		);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(8);
	});

	it("on a load error stops starting loads, settles the started ones, then throws that error", async () => {
		const started: number[] = [];
		const settled: number[] = [];
		const consumed: number[] = [];
		const failure = new Error("download failed");
		const run = forEachPrefetched(
			Array.from({ length: 20 }, (_, i) => i),
			3,
			async (i) => {
				started.push(i);
				await new Promise((r) => setTimeout(r, i === 1 ? 1 : 5));
				settled.push(i);
				if (i === 1) {
					throw failure;
				}
				return i;
			},
			(i) => {
				consumed.push(i);
			},
		);
		await expect(run).rejects.toBe(failure);
		expect(consumed).toEqual([0]);
		expect(Math.max(...started)).toBeLessThan(5);
		expect([...settled].sort((a, b) => a - b)).toEqual(
			[...started].sort((a, b) => a - b),
		);
	});

	it("on a consume error settles the started loads, then throws that error", async () => {
		const started: number[] = [];
		const settled: number[] = [];
		const failure = new Error("write failed");
		const run = forEachPrefetched(
			Array.from({ length: 20 }, (_, i) => i),
			4,
			async (i) => {
				started.push(i);
				await tick();
				settled.push(i);
				return i;
			},
			(i) => {
				if (i === 2) {
					throw failure;
				}
			},
		);
		await expect(run).rejects.toBe(failure);
		expect(Math.max(...started)).toBeLessThan(7);
		expect(settled.length).toBe(started.length);
	});

	it("throws the first error in input order when two loads fail", async () => {
		const first = new Error("first");
		const second = new Error("second");
		const run = forEachPrefetched(
			[0, 1, 2],
			3,
			async (i) => {
				await new Promise((r) => setTimeout(r, i === 2 ? 0 : 3));
				if (i === 1) {
					throw first;
				}
				if (i === 2) {
					throw second;
				}
				return i;
			},
			() => undefined,
		);
		await expect(run).rejects.toBe(first);
	});

	it("runs nothing for an empty list and treats a limit below one as one", async () => {
		const calls: number[] = [];
		await forEachPrefetched(
			[],
			8,
			async (i: number) => i,
			(i) => {
				calls.push(i);
			},
		);
		expect(calls).toEqual([]);

		let peak = 0;
		let open = 0;
		await forEachPrefetched(
			[0, 1, 2],
			0,
			async (i) => {
				open++;
				peak = Math.max(peak, open);
				await tick();
				return i;
			},
			() => {
				open--;
			},
		);
		expect(peak).toBe(1);
	});
});
