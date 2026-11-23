import { describe, expect, it } from "vitest";
import {
	approveClosesDetail,
	approvedChangesText,
	approveHeldBackToast,
	approveOutcomeToast,
	approveRefusalTitle,
	heldBackToast,
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
			title: "Couldn't approve “Alpha item”",
			description: "Boom",
		});
	});
});

describe("approve refusal headings", () => {
	it("uses one wording for an item and for the whole proposal", () => {
		expect(approveRefusalTitle("Alpha item")).toBe(
			"Couldn't approve “Alpha item”",
		);
		expect(approveRefusalTitle(null)).toBe("Couldn't approve proposal");
		expect(
			approveOutcomeToast({ status: "failed", errors: ["Boom"] }, WHOLE)
				.title,
		).toBe("Couldn't approve proposal");
	});
});

describe("heldBackToast", () => {
	const refusal =
		"“Alpha item” can't update F-2: it is not a work item in this project. Pick another target or create a new ticket.";

	it("names each held-back item and says it stays in review", () => {
		expect(heldBackToast([refusal])).toEqual({
			variant: "error",
			title: "Couldn't approve 1 item",
			description: `${refusal}\nIt stays in review.`,
		});
		expect(heldBackToast([refusal, refusal])).toMatchObject({
			title: "Couldn't approve 2 items",
			description: `${refusal}\n${refusal}\nThey stay in review.`,
		});
	});

	it("shows nothing when no item was held back", () => {
		expect(heldBackToast(undefined)).toBeNull();
		expect(heldBackToast([])).toBeNull();
	});

	// A live check showed the two held-back items twice, in two stacked
	// toasts: the failed approve's and the held-back one.
	it("names each held-back item once when the failed approve's errors already name it", () => {
		const other =
			"“Beta item” can't update F-3: it is not a work item in this project. Pick another target or create a new ticket.";
		const result = {
			status: "failed" as const,
			errors: [refusal, other],
			heldBack: [refusal, other],
		};

		expect(approveHeldBackToast(result)).toBeNull();
		expect(approveOutcomeToast(result, WHOLE)).toEqual({
			variant: "error",
			title: "Couldn't approve proposal",
			description: `${refusal}\n${other}\nThey stay in review.`,
		});
	});

	it("still names the held-back items a failed approve's errors do not", () => {
		const result = {
			status: "failed" as const,
			errors: [
				"No item could be applied. The proposal is back in review.",
			],
			heldBack: [refusal],
		};

		expect(approveHeldBackToast(result)).toEqual(heldBackToast([refusal]));
		expect(approveOutcomeToast(result, WHOLE).description).toBe(
			"No item could be applied. The proposal is back in review.",
		);
	});

	it("names the items held back beside an approve that applied the rest", () => {
		expect(
			approveHeldBackToast({ status: "dispatched", heldBack: [refusal] }),
		).toEqual(heldBackToast([refusal]));
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

describe("approvedChangesText", () => {
	it("counts only the changes that apply, and names how many are held back", () => {
		expect(approvedChangesText(5, 5, 2)).toEqual({
			approved: "Approved 3 of 5 proposed changes",
			heldBack:
				"2 held back: their target ticket is not in this project.",
		});
		expect(approvedChangesText(2, 5, 1).heldBack).toBe(
			"1 held back: its target ticket is not in this project.",
		);
	});

	it("says nothing about held-back changes when none is", () => {
		expect(approvedChangesText(4, 5, 0)).toEqual({
			approved: "Approved 4 of 5 proposed changes",
			heldBack: null,
		});
	});
});
