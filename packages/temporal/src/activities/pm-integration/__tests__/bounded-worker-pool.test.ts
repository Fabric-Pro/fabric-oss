import { describe, expect, it } from "vitest";
import { runBoundedWorkerPool } from "../bounded-worker-pool";

describe("runBoundedWorkerPool", () => {
	it("runs every task and skips nothing when there is no budget", async () => {
		const calls: number[] = [];
		const { skipped } = await runBoundedWorkerPool({
			total: 10,
			concurrency: 3,
			task: async (i) => {
				calls.push(i);
			},
		});
		expect(calls.sort((a, b) => a - b)).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
		]);
		expect(skipped).toEqual([]);
	});

	it("never exceeds `concurrency` in-flight tasks", async () => {
		let inFlight = 0;
		let max = 0;
		await runBoundedWorkerPool({
			total: 12,
			concurrency: 3,
			task: async () => {
				inFlight++;
				max = Math.max(max, inFlight);
				await Promise.resolve();
				inFlight--;
			},
		});
		expect(max).toBe(3);
	});

	it("stops pulling once the deadline is reached and returns the un-attempted tail", async () => {
		let clock = 0;
		const now = () => clock;
		const calls: number[] = [];
		const { skipped } = await runBoundedWorkerPool({
			total: 100,
			concurrency: 1,
			deadlineAt: 50,
			now,
			task: async (i) => {
				clock += 10;
				calls.push(i);
			},
		});
		expect(calls).toEqual([0, 1, 2, 3, 4]);
		expect(skipped.length).toBe(95);
		expect(skipped[0]).toBe(5);
		expect(skipped[skipped.length - 1]).toBe(99);
	});
});
