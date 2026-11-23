/**
 * Request deadline of the interactive duplicate checks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRequestDeadline } from "../duplicate-check-limits";

beforeEach(() => {
	vi.useFakeTimers();
	delete process.env.DUPLICATE_CHECK_TIMEOUT_MS;
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DUPLICATE_CHECK_TIMEOUT_MS;
});

describe("startRequestDeadline", () => {
	it("aborts once the configured timeout passes", () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "1000";
		const request = startRequestDeadline();

		vi.advanceTimersByTime(999);
		expect(request.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(request.signal.aborted).toBe(true);
	});

	it("does not abort once cleared", () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "1000";
		const request = startRequestDeadline();

		request.clear();
		vi.advanceTimersByTime(5_000);

		expect(request.signal.aborted).toBe(false);
	});
});
