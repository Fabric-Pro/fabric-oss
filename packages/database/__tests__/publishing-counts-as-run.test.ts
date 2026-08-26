import { describe, expect, it } from "vitest";
import { publishingTerminalCountsAsRun } from "../src/publishing-cadence";

describe("publishingTerminalCountsAsRun", () => {
	it("counts READY and NO_TOPICS regardless of partial collector failure", () => {
		for (const status of ["READY", "NO_TOPICS"] as const) {
			expect(
				publishingTerminalCountsAsRun({ status, sourceFailures: {} }),
			).toBe(true);
			expect(
				publishingTerminalCountsAsRun({
					status,
					sourceFailures: { releases: "source incomplete" },
				}),
			).toBe(true);
		}
	});

	it("counts a CLEAN INSUFFICIENT_CONTEXT — the workflow writes {} for one, not null", () => {
		expect(
			publishingTerminalCountsAsRun({
				status: "INSUFFICIENT_CONTEXT",
				sourceFailures: {},
			}),
		).toBe(true);
		expect(
			publishingTerminalCountsAsRun({
				status: "INSUFFICIENT_CONTEXT",
				sourceFailures: null,
			}),
		).toBe(true);
	});

	it("does NOT count a DIRTY INSUFFICIENT_CONTEXT — the failed source deserves a retry", () => {
		expect(
			publishingTerminalCountsAsRun({
				status: "INSUFFICIENT_CONTEXT",
				sourceFailures: { pullRequests: "source incomplete" },
			}),
		).toBe(false);
	});
});
