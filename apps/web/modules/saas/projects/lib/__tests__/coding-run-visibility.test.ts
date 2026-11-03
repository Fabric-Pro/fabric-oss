import { describe, expect, it } from "vitest";
import {
	hasActiveCodingRunOnStory,
	isCodingRunActive,
} from "../coding-run-visibility";

describe("coding-run-visibility", () => {
	it("treats active lifecycle statuses as active and terminal statuses as inactive", () => {
		for (const status of [
			"QUEUED",
			"STARTING",
			"RUNNING",
			"AWAITING_REVIEW",
			"PR_OPENED",
			"DEMO_READY",
		]) {
			expect(isCodingRunActive({ status })).toBe(true);
		}
		for (const status of [
			"COMPLETED",
			"FAILED",
			"CANCELLED",
			"TERMINATED_STALE",
		]) {
			expect(isCodingRunActive({ status })).toBe(false);
		}
		expect(isCodingRunActive(null)).toBe(false);
		expect(isCodingRunActive(undefined)).toBe(false);
	});

	it("detects active runs at either story level or task level", () => {
		expect(
			hasActiveCodingRunOnStory({
				latestCodingRun: { status: "RUNNING" },
				tasks: [],
			}),
		).toBe(true);
		expect(
			hasActiveCodingRunOnStory({
				latestCodingRun: { status: "FAILED" },
				tasks: [{ latestCodingRun: { status: "PR_OPENED" } }],
			}),
		).toBe(true);
		expect(
			hasActiveCodingRunOnStory({
				latestCodingRun: { status: "FAILED" },
				tasks: [{ latestCodingRun: { status: "COMPLETED" } }],
			}),
		).toBe(false);
	});
});
