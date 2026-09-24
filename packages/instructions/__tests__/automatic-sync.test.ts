import { describe, expect, it } from "vitest";
import {
	type AutomaticSyncRow,
	shouldStartAutomaticSync,
} from "../src/automatic-sync";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function row(overrides: Partial<AutomaticSyncRow> = {}): AutomaticSyncRow {
	return {
		automatic: true,
		automaticPausedReason: null,
		generation: 3,
		lastEvaluatedCommitSha: null,
		lastEvaluatedGeneration: null,
		suppressedCommitSha: null,
		suppressedGeneration: null,
		...overrides,
	};
}

describe("shouldStartAutomaticSync (spec §6.1, §6.2)", () => {
	it("starts a fresh automatic sync", () => {
		expect(shouldStartAutomaticSync(row(), HEAD)).toEqual({ start: true });
	});

	it("never starts when automatic sync is off, whatever else holds", () => {
		expect(
			shouldStartAutomaticSync(
				row({ automatic: false, automaticPausedReason: "REF_MISSING" }),
				HEAD,
			),
		).toEqual({ start: false, reason: "disabled" });
	});

	it.each([["PERMISSION_REVOKED"], ["REF_MISSING"]])(
		"never starts while paused for %s",
		(reason) => {
			expect(
				shouldStartAutomaticSync(
					row({ automaticPausedReason: reason }),
					HEAD,
				),
			).toEqual({ start: false, reason: "paused" });
		},
	);

	it("skips a head already evaluated under the current generation", () => {
		expect(
			shouldStartAutomaticSync(
				row({
					lastEvaluatedCommitSha: HEAD,
					lastEvaluatedGeneration: 3,
				}),
				HEAD,
			),
		).toEqual({ start: false, reason: "evaluated" });
	});

	it("re-evaluates a head evaluated under an older generation", () => {
		expect(
			shouldStartAutomaticSync(
				row({
					lastEvaluatedCommitSha: HEAD,
					lastEvaluatedGeneration: 2,
				}),
				HEAD,
			),
		).toEqual({ start: true });
	});

	it("skips a head suppressed under the current generation", () => {
		expect(
			shouldStartAutomaticSync(
				row({ suppressedCommitSha: HEAD, suppressedGeneration: 3 }),
				HEAD,
			),
		).toEqual({ start: false, reason: "suppressed" });
	});

	it("retries a head suppressed under an older generation", () => {
		expect(
			shouldStartAutomaticSync(
				row({ suppressedCommitSha: HEAD, suppressedGeneration: 2 }),
				HEAD,
			),
		).toEqual({ start: true });
	});

	it("starts for a head that differs from both cursors", () => {
		expect(
			shouldStartAutomaticSync(
				row({
					lastEvaluatedCommitSha: OTHER,
					lastEvaluatedGeneration: 3,
					suppressedCommitSha: OTHER,
					suppressedGeneration: 3,
				}),
				HEAD,
			),
		).toEqual({ start: true });
	});

	it("reports evaluated ahead of suppressed when both cursors name the head", () => {
		expect(
			shouldStartAutomaticSync(
				row({
					lastEvaluatedCommitSha: HEAD,
					lastEvaluatedGeneration: 3,
					suppressedCommitSha: HEAD,
					suppressedGeneration: 3,
				}),
				HEAD,
			),
		).toEqual({ start: false, reason: "evaluated" });
	});

	it.each([[undefined], [null], [""]])(
		"ignores both cursors without a head (%s)",
		(headSha) => {
			expect(
				shouldStartAutomaticSync(
					row({
						lastEvaluatedCommitSha: HEAD,
						lastEvaluatedGeneration: 3,
						suppressedCommitSha: HEAD,
						suppressedGeneration: 3,
					}),
					headSha,
				),
			).toEqual({ start: true });
		},
	);
});
