/**
 * Request and judge-stage deadlines of the interactive duplicate checks:
 * the judge stage ends early enough for the request to return what it has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	startJudgeStageDeadline,
	startRequestDeadline,
} from "../duplicate-check-limits";

beforeEach(() => {
	vi.useFakeTimers();
	delete process.env.DUPLICATE_CHECK_TIMEOUT_MS;
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DUPLICATE_CHECK_TIMEOUT_MS;
});

describe("startJudgeStageDeadline", () => {
	it("aborts the judge stage five seconds before the request deadline", () => {
		const request = startRequestDeadline();
		const stage = startJudgeStageDeadline(request);

		vi.advanceTimersByTime(14_999);
		expect(stage.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(stage.signal.aborted).toBe(true);
		expect(request.signal.aborted).toBe(false);
	});

	it("gives the judge stage at least three seconds", () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "4000";
		const stage = startJudgeStageDeadline(startRequestDeadline());

		vi.advanceTimersByTime(2_999);
		expect(stage.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(stage.signal.aborted).toBe(true);
	});

	it("aborts with the request", () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "1000";
		const request = startRequestDeadline();
		const stage = startJudgeStageDeadline(request);

		vi.advanceTimersByTime(1_000);

		expect(request.signal.aborted).toBe(true);
		expect(stage.signal.aborted).toBe(true);
	});

	it("does not abort once cleared", () => {
		const request = startRequestDeadline();
		const stage = startJudgeStageDeadline(request);

		stage.clear();
		vi.advanceTimersByTime(15_000);

		expect(stage.signal.aborted).toBe(false);
	});
});
