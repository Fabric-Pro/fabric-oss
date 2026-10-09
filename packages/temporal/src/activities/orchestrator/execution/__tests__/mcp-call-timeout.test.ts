import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MCP_TOOL_TIMEOUT_MS,
	effectiveMcpToolTimeoutMs,
	FIRST_PARTY_MCP_TOOL_TIMEOUT_MS,
	runWithTimeout,
} from "../mcp-call-timeout";

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

// Fizzy #2770 D8: Fabric's own tools may run a model step on a ChatGPT plan
// that takes longer than the ceiling meant for a hung external server.
describe("effectiveMcpToolTimeoutMs", () => {
	it("raises the ceiling for Fabric's own tools only", () => {
		expect(
			effectiveMcpToolTimeoutMs(DEFAULT_MCP_TOOL_TIMEOUT_MS, true),
		).toBe(FIRST_PARTY_MCP_TOOL_TIMEOUT_MS);
		expect(
			effectiveMcpToolTimeoutMs(DEFAULT_MCP_TOOL_TIMEOUT_MS, false),
		).toBe(DEFAULT_MCP_TOOL_TIMEOUT_MS);
	});

	it("never lowers a longer ceiling, and adds none where none was asked", () => {
		expect(effectiveMcpToolTimeoutMs(240_000, true)).toBe(240_000);
		expect(effectiveMcpToolTimeoutMs(undefined, true)).toBeUndefined();
	});

	it("stays under the 5-minute activity timeout", () => {
		expect(FIRST_PARTY_MCP_TOOL_TIMEOUT_MS).toBeLessThan(5 * 60_000);
	});
});
