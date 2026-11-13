/**
 * The keepalive a research run's stream uses: at most one write a minute,
 * never one stacked on a write still in flight, and a failure that is only
 * logged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { activityLogger } from "../activity-logger";
import {
	RESEARCH_PROGRESS_WRITE_INTERVAL_MS,
	ResearchProgressKeepalive,
} from "../research-progress-keepalive";

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ResearchProgressKeepalive", () => {
	it("writes on a tick only once a full interval has passed", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const keepalive = new ResearchProgressKeepalive(write, {
			documentId: "doc-1",
		});

		await vi.advanceTimersByTimeAsync(
			RESEARCH_PROGRESS_WRITE_INTERVAL_MS - 1,
		);
		keepalive.tick();
		expect(write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		keepalive.tick();
		keepalive.tick();
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("never stacks a write on one still in flight", async () => {
		let finish: () => void = () => {};
		const write = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const keepalive = new ResearchProgressKeepalive(write, {
			documentId: "doc-1",
		});

		keepalive.writeNow();
		await vi.advanceTimersByTimeAsync(
			2 * RESEARCH_PROGRESS_WRITE_INTERVAL_MS,
		);
		keepalive.tick();
		keepalive.writeNow();
		expect(write).toHaveBeenCalledTimes(1);

		finish();
		await vi.advanceTimersByTimeAsync(0);
		keepalive.writeNow();
		expect(write).toHaveBeenCalledTimes(2);
	});

	it("logs a failed write with its ids and does not throw", async () => {
		const write = vi.fn().mockRejectedValue(new Error("connection reset"));
		const keepalive = new ResearchProgressKeepalive(write, {
			documentId: "doc-1",
		});

		expect(() => keepalive.writeNow()).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);

		expect(activityLogger.warn).toHaveBeenCalledWith(
			"Could not record a research run's progress; generation continues",
			{ documentId: "doc-1", error: "connection reset" },
		);
		// The failed write is over, so the next one may go.
		keepalive.writeNow();
		expect(write).toHaveBeenCalledTimes(2);
	});
});
