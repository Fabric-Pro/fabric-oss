/**
 * Per-item state of an inbox proposal. The server says which items are
 * resolved and why; the client maps each reason to its label and ticket.
 */

import { describe, expect, it } from "vitest";
import {
	changeCountLabel,
	deriveProposalItemState,
} from "../proposal-item-state";

describe("deriveProposalItemState", () => {
	it("locks exactly the server's resolved items, with their tickets", () => {
		const state = deriveProposalItemState({
			resolvedItems: [
				{ changeIndex: 0, reason: "applied" },
				{ changeIndex: 2, reason: "applied" },
				{ changeIndex: 3, reason: "rejected" },
			],
			createdChangeIndexes: [0, 2],
			applications: [
				{
					changeIndex: 0,
					createdEntityId: "story-a",
					action: "create",
				},
				{
					changeIndex: 2,
					createdEntityId: "story-c",
					action: "update",
				},
			],
			appliedReason: "applied",
		});
		expect([...state.lockedReasons.keys()].sort()).toEqual([0, 2, 3]);
		expect(state.lockedReasons.get(0)).toBe("applied");
		expect(state.lockedReasons.get(2)).toBe("applied");
		expect(state.lockedReasons.get(3)).toBe("rejected");
		expect(state.lockedReasons.has(1)).toBe(false);
		expect(state.lockedTargets.get(0)).toBe("story-a");
		expect(state.lockedTargets.get(2)).toBe("story-c");
		expect(state.lockedTargets.has(3)).toBe(false);
		expect(state.appliedCount).toBe(2);
	});

	it("reads a rejected item restored from the Rejected list as restored, with its ticket", () => {
		const state = deriveProposalItemState({
			resolvedItems: [
				{ changeIndex: 0, reason: "rejected" },
				{ changeIndex: 1, reason: "rejected" },
			],
			createdChangeIndexes: [],
			appliedReason: "applied",
			restoredItems: [{ changeIndex: 1, storyId: "story-restored" }],
		});
		expect(state.lockedReasons.get(0)).toBe("rejected");
		expect(state.lockedReasons.get(1)).toBe("restored");
		expect(state.lockedTargets.get(1)).toBe("story-restored");
		expect(state.lockedTargets.has(0)).toBe(false);
	});

	it("reads an applied item that created nothing as already on the Roadmap", () => {
		const state = deriveProposalItemState({
			resolvedItems: [
				{ changeIndex: 0, reason: "applied" },
				{ changeIndex: 1, reason: "applied" },
			],
			createdChangeIndexes: [0],
			appliedReason: "accepted",
			skippedTargets: new Map([[1, "story-existing"]]),
		});
		expect(state.lockedReasons.get(0)).toBe("accepted");
		expect(state.lockedReasons.get(1)).toBe("already-on-roadmap");
		expect(state.lockedTargets.get(1)).toBe("story-existing");
		expect(state.appliedCount).toBe(1);
		expect(state.alreadyOnRoadmapCount).toBe(1);
	});

	it("reads a duplicate-resolved item as already on the Roadmap, linked to its match", () => {
		const state = deriveProposalItemState({
			resolvedItems: [
				{ changeIndex: 1, reason: "duplicate" },
				{ changeIndex: 2, reason: "duplicate" },
			],
			createdChangeIndexes: [],
			duplicateResolutions: [
				{ changeIndex: 1, existingEntityId: "story-existing" },
				{ changeIndex: 2, existingEntityId: null },
			],
			appliedReason: "applied",
		});
		expect(state.lockedReasons.get(1)).toBe("already-on-roadmap");
		expect(state.lockedReasons.get(2)).toBe("already-on-roadmap");
		expect(state.lockedTargets.get(1)).toBe("story-existing");
		expect(state.lockedTargets.has(2)).toBe(false);
		expect(state.alreadyOnRoadmapCount).toBe(2);
	});

	it("links no ticket to an item that is still open", () => {
		const state = deriveProposalItemState({
			resolvedItems: [],
			createdChangeIndexes: [],
			appliedReason: "applied",
			skippedTargets: new Map([[0, "story-x"]]),
		});
		expect(state.lockedReasons.size).toBe(0);
		expect(state.lockedTargets.size).toBe(0);
	});
});

describe("changeCountLabel", () => {
	it("shows what still waits for a decision, as the server counts it", () => {
		expect(changeCountLabel({ changeCount: 3, remainingCount: 1 })).toBe(
			"1 of 3 changes left",
		);
	});

	it("keeps the plain count while nothing is resolved", () => {
		expect(changeCountLabel({ changeCount: 1, remainingCount: 1 })).toBe(
			"1 change",
		);
		expect(changeCountLabel({ changeCount: 2, remainingCount: 2 })).toBe(
			"2 changes",
		);
	});
});
