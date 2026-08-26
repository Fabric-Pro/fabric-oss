import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTimeout } from "../mcp-call-timeout";

describe("runWithTimeout", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("resolves to onTimeout() when work never settles, and clears the timer", async () => {
		const never = new Promise<string>(() => {});
		const p = runWithTimeout(never, 1000, () => "TIMEOUT");
		await vi.advanceTimersByTimeAsync(1000);
		await expect(p).resolves.toBe("TIMEOUT");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("passes work's value through when it settles first, and clears the timer", async () => {
		const p = runWithTimeout(Promise.resolve("OK"), 1000, () => "TIMEOUT");
		await expect(p).resolves.toBe("OK");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not throw when work rejects AFTER the timeout already won", async () => {
		let reject: (e: unknown) => void = () => {};
		const work = new Promise<string>((_, r) => {
			reject = r;
		});
		const p = runWithTimeout(work, 1000, () => "TIMEOUT");
		await vi.advanceTimersByTimeAsync(1000);
		await expect(p).resolves.toBe("TIMEOUT");
		reject(new Error("late failure")); // must NOT surface as unhandled rejection
		await Promise.resolve();
	});
});
