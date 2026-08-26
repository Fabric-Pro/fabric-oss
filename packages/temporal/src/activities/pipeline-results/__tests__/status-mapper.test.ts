import { describe, expect, it } from "vitest";
import { mapRawStatusToTestResult } from "../status-mapper";

describe("mapRawStatusToTestResult", () => {
	it("maps pass-like tokens to PASSED (case/whitespace-insensitive)", () => {
		for (const t of ["passed", "PASS", " Success ", "succeeded", "ok"]) {
			expect(mapRawStatusToTestResult(t)).toBe("PASSED");
		}
	});

	it("maps fail-like tokens to FAILED", () => {
		for (const t of ["failed", "Failure", "error", "errored", "broken"]) {
			expect(mapRawStatusToTestResult(t)).toBe("FAILED");
		}
	});

	it("maps not-run-like tokens (incl. empty) to NOT_RUN", () => {
		for (const t of ["notExecuted", "not_run", "pending", "queued", ""]) {
			expect(mapRawStatusToTestResult(t)).toBe("NOT_RUN");
		}
	});

	it("maps a deliberate skip to SKIPPED, in every spelling runners use", () => {
		// These used to collapse into BLOCKED, which reads as
		// "needs attention" — wrong for a test the suite was told not to run.
		for (const t of [
			"skipped",
			"Skipped",
			"skip",
			"ignored",
			"notApplicable",
			"not_applicable",
			"disabled",
		]) {
			expect(mapRawStatusToTestResult(t)).toBe("SKIPPED");
		}
	});

	it("maps attempted-but-unfinished and unknown tokens to BLOCKED", () => {
		// Still never silently PASSED: an outcome we cannot read is "needs
		// attention", not green. The distinction from SKIPPED is intent — these
		// were attempted and did not finish.
		for (const t of [
			"aborted",
			"cancelled",
			"inconclusive",
			"timedOut",
			"something-we-have-never-seen",
		]) {
			expect(mapRawStatusToTestResult(t)).toBe("BLOCKED");
		}
	});

	it("keeps a skip distinct from never-having-run", () => {
		// The two were conflated in the counts: skippedCount tallied NOT_RUN
		// while genuine skips hid in otherCount.
		expect(mapRawStatusToTestResult("skipped")).not.toBe(
			mapRawStatusToTestResult("queued"),
		);
		expect(mapRawStatusToTestResult("queued")).toBe("NOT_RUN");
	});
});
