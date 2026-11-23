import { describe, expect, it } from "vitest";
import type { ResolvedProposalItem } from "../proposal-item-state";
import { failureClassToCopy } from "./failure-class-copy";

const proposal = (
	changeCount: number,
	resolvedItems: ResolvedProposalItem[] = [],
) => ({ changeCount, resolvedItems });

const applied = (changeIndex: number): ResolvedProposalItem => ({
	changeIndex,
	reason: "applied",
});

describe("failureClassToCopy", () => {
	it("names a deleted update target instead of the generic headline", () => {
		expect(failureClassToCopy("TargetMissing", proposal(2))).toBe(
			"The ticket this proposal updates no longer exists. Move the update to Rejected, or dismiss the proposal.",
		);
	});

	it("says how much of a timed-out apply landed", () => {
		expect(
			failureClassToCopy(
				"TimeoutFailure",
				proposal(4, [applied(1), applied(2)]),
			),
		).toBe(
			"Applying took too long: 2 of 4 changes were applied. Retry to apply the remaining 2.",
		);
	});

	it("leaves items moved to Rejected or resolved as duplicates out of a timed-out apply's count", () => {
		expect(
			failureClassToCopy(
				"TimeoutFailure",
				proposal(5, [
					applied(0),
					{ changeIndex: 1, reason: "rejected" },
					{ changeIndex: 2, reason: "duplicate" },
				]),
			),
		).toBe(
			"Applying took too long: 1 of 3 changes were applied. Retry to apply the remaining 2.",
		);
	});

	it("says a timed-out apply applied nothing when nothing landed", () => {
		expect(failureClassToCopy("TimeoutFailure", proposal(3))).toBe(
			"Applying took too long and stopped before any change was applied. Retry to apply them.",
		);
	});

	it("does not ask for the remaining changes when every change was applied", () => {
		expect(
			failureClassToCopy(
				"TimeoutFailure",
				proposal(2, [applied(0), applied(1)]),
			),
		).toBe(
			"Applying took too long after every change was applied. Retry to finish the apply.",
		);
	});

	it("reads the stale-apply watchdog's class as a timeout too", () => {
		expect(failureClassToCopy("TimedOut", proposal(2, [applied(0)]))).toBe(
			"Applying took too long: 1 of 2 changes were applied. Retry to apply the remaining 1.",
		);
	});

	it("falls back to the generic headline for an unknown or missing class", () => {
		expect(failureClassToCopy("SomethingNew", proposal(2))).toBe(
			"Couldn't sync this proposal. Show details.",
		);
		expect(failureClassToCopy(null, proposal(2))).toBe(
			"Couldn't sync this proposal. Show details.",
		);
	});
});
