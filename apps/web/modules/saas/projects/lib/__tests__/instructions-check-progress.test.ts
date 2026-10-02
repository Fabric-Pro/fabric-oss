import { describe, expect, it } from "vitest";
import {
	checkPhaseMessageKey,
	checkProgressMessageKey,
	snapshotCheckProgress,
} from "../instructions-check-progress";

describe("snapshotCheckProgress", () => {
	it("reads the phase and the files decided out of the files to decide", () => {
		expect(
			snapshotCheckProgress({
				status: "VALIDATING",
				progressPhase: "CHECKING",
				progressDone: 12,
				progressTotal: 40,
			}),
		).toEqual({ phase: "CHECKING", done: 12, total: 40 });
	});

	it("reads the deferred scan of a version that is already published", () => {
		expect(
			snapshotCheckProgress({
				status: "READY",
				deferredScanStatus: "PENDING",
				progressPhase: "SCANNING",
				progressDone: 1,
				progressTotal: 3,
			}),
		).toEqual({ phase: "SCANNING", done: 1, total: 3 });
	});

	it("says nothing for a row nobody is checking", () => {
		for (const status of ["RECEIVING", "FAILED", "REJECTED", "READY"]) {
			expect(
				snapshotCheckProgress({
					status,
					progressPhase: "CHECKING",
					progressDone: 1,
					progressTotal: 2,
				}),
			).toBeNull();
		}
	});

	it("says nothing when a field is unset, so the caller keeps its plain copy", () => {
		expect(snapshotCheckProgress({ status: "VALIDATING" })).toBeNull();
		expect(
			snapshotCheckProgress({
				status: "VALIDATING",
				progressPhase: "CHECKING",
				progressDone: null,
				progressTotal: 5,
			}),
		).toBeNull();
	});

	it("says nothing for a count that does not add up", () => {
		for (const [done, total] of [
			[6, 5],
			[-1, 5],
			[1.5, 5],
		] as const) {
			expect(
				snapshotCheckProgress({
					status: "VALIDATING",
					progressPhase: "SAVING",
					progressDone: done,
					progressTotal: total,
				}),
			).toBeNull();
		}
	});

	it("accepts a pass over no files at all", () => {
		expect(
			snapshotCheckProgress({
				status: "VALIDATING",
				progressPhase: "CHECKING",
				progressDone: 0,
				progressTotal: 0,
			}),
		).toEqual({ phase: "CHECKING", done: 0, total: 0 });
	});
});

describe("check progress message keys", () => {
	it("maps every phase to a line with a count and to a name without one", () => {
		expect(checkProgressMessageKey("CHECKING")).toBe("checkingFiles");
		expect(checkProgressMessageKey("SAVING")).toBe("savingFiles");
		expect(checkProgressMessageKey("SCANNING")).toBe("scanningFiles");
		expect(checkPhaseMessageKey("CHECKING")).toBe("checkingPhase");
		expect(checkPhaseMessageKey("SAVING")).toBe("savingPhase");
		expect(checkPhaseMessageKey("SCANNING")).toBe("scanningPhase");
	});
});
