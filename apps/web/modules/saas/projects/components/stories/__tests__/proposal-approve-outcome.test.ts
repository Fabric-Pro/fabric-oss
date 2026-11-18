import { describe, expect, it } from "vitest";
import {
	approveClosesDetail,
	approveOutcomeToast,
	PROPOSAL_CONFLICT_MESSAGE,
	proposalConflictMessage,
} from "../proposal-approve-outcome";

const WHOLE = { source: "SLACK_CHANNEL" };

const ITEM = {
	source: "SLACK_CHANNEL",
	changeIndex: 0,
	itemTitle: "Alpha item",
};

describe("approveOutcomeToast — one item", () => {
	it("keeps the proposal in review while other items wait", () => {
		expect(
			approveOutcomeToast(
				{ status: "pending", remainingChangeCount: 1 },
				ITEM,
			),
		).toEqual({
			variant: "success",
			title: "Approved “Alpha item”",
			description: "The other items stay in review.",
		});
	});

	it("offers the created ticket once the last item is applied", () => {
		expect(
			approveOutcomeToast(
				{
					status: "applied",
					remainingChangeCount: 0,
					createdStoryIds: ["story-alpha"],
				},
				{ ...ITEM, lastItem: true },
			),
		).toEqual({
			variant: "success",
			title: "Approved “Alpha item”",
			description: "That was the last item in this proposal.",
			ticketId: "story-alpha",
		});
	});

	it("offers the matched ticket when the last item was already on the roadmap", () => {
		expect(
			approveOutcomeToast(
				{
					status: "applied",
					skipped: [
						{
							changeIndex: 0,
							existingIdentifier: "F-12",
							existingId: "story-existing",
							title: "Alpha item",
						},
					],
				},
				ITEM,
			),
		).toMatchObject({
			title: "“Alpha item” is already on the roadmap",
			ticketId: "story-existing",
		});
	});

	it("offers the updated ticket when the last item was an update handed to a workflow", () => {
		expect(
			approveOutcomeToast(
				{ status: "dispatched" },
				{ ...ITEM, lastItem: true, targetStoryId: "story-target" },
			),
		).toEqual({
			variant: "success",
			title: "Approved “Alpha item”",
			description:
				"Applying in the background — the ticket appears on the roadmap when it is ready.",
			ticketId: "story-target",
		});
	});

	it("offers no ticket while the proposal stays open", () => {
		expect(
			approveOutcomeToast(
				{ status: "dispatched" },
				{ ...ITEM, lastItem: false, targetStoryId: "story-target" },
			).ticketId,
		).toBeUndefined();
	});

	it("names the item that could not be applied", () => {
		expect(
			approveOutcomeToast({ status: "failed", errors: ["Boom"] }, ITEM),
		).toEqual({
			variant: "error",
			title: "Couldn't apply “Alpha item”",
			description: "Boom",
		});
	});
});

describe("approveOutcomeToast — the whole proposal", () => {
	it("says an update workflow applies it in the background", () => {
		expect(approveOutcomeToast({ status: "dispatched" }, WHOLE)).toEqual({
			variant: "success",
			title: "Proposal approved",
			description:
				"Applying in the background — items appear on the roadmap as they are created.",
		});
	});

	it("counts the items still waiting for review", () => {
		expect(
			approveOutcomeToast(
				{ status: "pending", remainingChangeCount: 2 },
				WHOLE,
			),
		).toEqual({
			variant: "success",
			title: "Selected items approved",
			description: "2 items still waiting for review.",
		});
	});

	it("lists what was already on the roadmap", () => {
		expect(
			approveOutcomeToast(
				{
					status: "applied",
					createdStoryIds: ["story-new"],
					skipped: [
						{
							changeIndex: 1,
							existingIdentifier: "F-12",
							existingId: "story-existing",
							title: "Export",
						},
					],
				},
				WHOLE,
			),
		).toEqual({
			variant: "success",
			title: "Proposal approved — some items already on the roadmap",
			description: "1 already existed: F-12 (Export)",
		});
	});
});

describe("approveClosesDetail", () => {
	it.each([
		["applied", true],
		["failed", true],
		["pending", false],
		["dispatched", false],
	] as const)(
		"closes a whole-proposal approve that is %s: %s",
		(status, closes) => {
			expect(approveClosesDetail({ status }, WHOLE)).toBe(closes);
		},
	);

	it.each([
		["applied", false, true],
		["dispatched", true, true],
		["dispatched", false, false],
		["pending", false, false],
		["failed", true, false],
	] as const)(
		"closes on a single item that is %s (last item: %s): %s",
		(status, lastItem, closes) => {
			expect(approveClosesDetail({ status }, { ...ITEM, lastItem })).toBe(
				closes,
			);
		},
	);
});

describe("proposalConflictMessage", () => {
	it("keeps the server's words when the proposal changed after it was opened", () => {
		const changed =
			"This proposal changed after you opened it. Reopen it to review the latest version.";
		expect(
			proposalConflictMessage(
				Object.assign(new Error(changed), { code: "CONFLICT" }),
			),
		).toBe(changed);
	});

	it("explains any other conflict as another reviewer acting first", () => {
		expect(
			proposalConflictMessage(
				Object.assign(new Error("Conflict"), { code: "CONFLICT" }),
			),
		).toBe(PROPOSAL_CONFLICT_MESSAGE);
		expect(
			proposalConflictMessage(
				new Error(
					"This proposal has already been approved or rejected.",
				),
			),
		).toBe(PROPOSAL_CONFLICT_MESSAGE);
	});

	it("is null for an error that is not a conflict", () => {
		expect(
			proposalConflictMessage(
				Object.assign(new Error("Not in this project"), {
					code: "BAD_REQUEST",
				}),
			),
		).toBeNull();
		expect(proposalConflictMessage("CONFLICT")).toBeNull();
	});
});
