import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COMMIT_REREAD_TIMEOUT_MS,
	rereadInstructionCommit,
} from "../instruction-commit-reread";

describe("rereading a committed instruction change", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("defers and starts every reread in parallel, then clears the shared deadline", async () => {
		let finishFirst = () => {};
		let finishSecond = () => {};
		const first = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve;
				}),
		);
		const second = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishSecond = resolve;
				}),
		);
		const finished = vi.fn();
		const reread = rereadInstructionCommit([first, second]).then(
			(result) => {
				finished(result);
				return result;
			},
		);
		expect(first).not.toHaveBeenCalled();
		expect(second).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		finishFirst();
		await vi.advanceTimersByTimeAsync(0);
		expect(finished).not.toHaveBeenCalled();
		finishSecond();
		await expect(reread).resolves.toBe("success");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains a synchronous throw without preventing another callback", async () => {
		const other = vi.fn();
		const reread = rereadInstructionCommit([
			() => {
				throw new Error("Synthetic synchronous reread failure");
			},
			other,
		]);
		await expect(reread).resolves.toBe("rejected");
		expect(other).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains an asynchronous rejection and clears its deadline", async () => {
		await expect(
			rereadInstructionCommit([
				() => Promise.reject(new Error("Synthetic reread failure")),
			]),
		).resolves.toBe("rejected");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("waits at most ten seconds and consumes a late rejection after timeout", async () => {
		let failLate = (_error: Error) => {};
		const finished = vi.fn();
		const reread = rereadInstructionCommit([
			() =>
				new Promise<void>((_resolve, reject) => {
					failLate = reject;
				}),
		]).then((result) => {
			finished(result);
			return result;
		});
		expect(COMMIT_REREAD_TIMEOUT_MS).toBe(10_000);
		await vi.advanceTimersByTimeAsync(COMMIT_REREAD_TIMEOUT_MS - 1);
		expect(finished).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(reread).resolves.toBe("timeout");
		expect(vi.getTimerCount()).toBe(0);
		failLate(new Error("Synthetic late reread failure"));
		await vi.advanceTimersByTimeAsync(0);
		expect(finished).toHaveBeenCalledExactlyOnceWith("timeout");
	});

	it("keeps the other reread's shared deadline when one callback rejects", async () => {
		const finished = vi.fn();
		const reread = rereadInstructionCommit([
			() => Promise.reject(new Error("Synthetic reread failure")),
			() => new Promise<void>(() => undefined),
		]).then((result) => {
			finished(result);
			return result;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(finished).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(COMMIT_REREAD_TIMEOUT_MS);
		await expect(reread).resolves.toBe("timeout");
		expect(vi.getTimerCount()).toBe(0);
	});
});
