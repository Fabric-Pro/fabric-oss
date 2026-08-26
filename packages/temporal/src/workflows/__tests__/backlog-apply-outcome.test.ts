import { describe, expect, it } from "vitest";
import {
	computeAppliedProposalIndexes,
	isPmTicketMissingError,
} from "../backlog-apply-outcome";

describe("isPmTicketMissingError", () => {
	it("is true for the classified PmNotFoundError (regardless of message)", () => {
		expect(isPmTicketMissingError("PmNotFoundError", "anything")).toBe(
			true,
		);
		expect(isPmTicketMissingError("PmNotFoundError", null)).toBe(true);
	});

	it("falls back to the not-found message pattern only when the class is generic/absent", () => {
		// unwrapPmSyncError can lose the class to a deeper generic "Error" frame.
		expect(
			isPmTicketMissingError(
				"Error",
				'PM ticket fetch failed for 1536 via fizzy_get_card: Resource not found: {"status":404,"error":"Not Found"}',
			),
		).toBe(true);
		expect(isPmTicketMissingError("UnknownError", "does not exist")).toBe(
			true,
		);
		expect(isPmTicketMissingError(null, "could not be found")).toBe(true);
		expect(isPmTicketMissingError(undefined, "card 404")).toBe(true);
	});

	it("never mistakes a specifically-classified failure for a missing ticket", () => {
		// Even if the message happens to contain "not found", a precise class wins.
		expect(
			isPmTicketMissingError("PmAuthError", "token not found / 404"),
		).toBe(false);
		expect(isPmTicketMissingError("PmCreateError", "404")).toBe(false);
		expect(isPmTicketMissingError("PmUpdateError", "not found")).toBe(
			false,
		);
	});

	it("is false for a generic class without a not-found message", () => {
		expect(isPmTicketMissingError("Error", "rate limited")).toBe(false);
		expect(isPmTicketMissingError(null, "timeout")).toBe(false);
		expect(isPmTicketMissingError("Error", null)).toBe(false);
	});
});

describe("computeAppliedProposalIndexes", () => {
	const base = {
		approvedChangeIndexes: [10, 11, 12],
		pmSucceededPositions: new Set<number>(),
		pmNotNeededPositions: new Set<number>(),
		pmTicketMissingPositions: new Set<number>(),
	};

	it("counts every Fabric-succeeded position when PM sync is not requested", () => {
		expect(
			computeAppliedProposalIndexes({
				...base,
				fabricSucceededPositions: [0, 2],
				syncToPM: false,
			}),
		).toEqual([10, 12]);
	});

	it("with PM sync on, counts synced + not-needed, drops genuine PM failures", () => {
		// position 0 synced, position 1 didn't need PM, position 2 failed sync.
		expect(
			computeAppliedProposalIndexes({
				...base,
				fabricSucceededPositions: [0, 1, 2],
				syncToPM: true,
				pmSucceededPositions: new Set([0]),
				pmNotNeededPositions: new Set([1]),
			}),
		).toEqual([10, 11]);
	});

	it("counts a PM-ticket-missing position as applied (the fix)", () => {
		// position 0's Fabric update applied but its PM ticket was deleted (404).
		expect(
			computeAppliedProposalIndexes({
				...base,
				fabricSucceededPositions: [0],
				syncToPM: true,
				pmTicketMissingPositions: new Set([0]),
			}),
		).toEqual([10]);
	});

	it("counts a PM-conflict position as applied (conflict ≠ failure)", () => {
		// position 0's Fabric update applied but its PM push hit a content
		// CONFLICT (drift). It's flagged for Review Center resolution, not failed,
		// so it must be recorded as applied — otherwise a retry re-runs it and
		// re-conflicts forever.
		expect(
			computeAppliedProposalIndexes({
				...base,
				fabricSucceededPositions: [0],
				syncToPM: true,
				pmConflictPositions: new Set([0]),
			}),
		).toEqual([10]);
	});

	it("mixes synced, conflict, and missing as applied while dropping a genuine PM failure", () => {
		// 0 synced, 1 conflict (applied+flagged), 2 missing ticket (applied+
		// flagged); position 3 has no PM resolution flag → genuine failure, dropped.
		expect(
			computeAppliedProposalIndexes({
				...base,
				approvedChangeIndexes: [10, 11, 12, 13],
				fabricSucceededPositions: [0, 1, 2, 3],
				syncToPM: true,
				pmSucceededPositions: new Set([0]),
				pmConflictPositions: new Set([1]),
				pmTicketMissingPositions: new Set([2]),
			}),
		).toEqual([10, 11, 12]);
	});

	it("ignores a conflict flag on a position whose Fabric apply did not succeed", () => {
		// Only Fabric-succeeded positions are eligible; a conflict flag alone
		// never invents an applied index.
		expect(
			computeAppliedProposalIndexes({
				...base,
				fabricSucceededPositions: [0],
				syncToPM: true,
				pmConflictPositions: new Set([1]),
			}),
		).toEqual([]);
	});

	it("ignores positions with no mapped proposal index", () => {
		expect(
			computeAppliedProposalIndexes({
				...base,
				approvedChangeIndexes: [10],
				fabricSucceededPositions: [0, 5],
				syncToPM: false,
			}),
		).toEqual([10]);
	});
});
