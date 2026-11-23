/**
 * An approve through the backlog apply door keeps the items it held back,
 * so the inbox names each item and its reason, also when nothing applied
 * and a resubmitted proposal went back to review.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestProposalApproval } from "../proposal-inbox-client";

const h = vi.hoisted(() => ({ applyChanges: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { backlog: { applyChanges: h.applyChanges } } },
}));

const HELD_BACK = [
	"“Ticket that was removed” can't update 9998: it is not a work item in this project. Pick another target or create a new ticket.",
];

const request = {
	projectId: "example-project",
	organizationId: "example-org",
	pmConfig: undefined,
	proposalId: "proposal-1",
	source: "SCOPE_DOCUMENT",
	approvedChanges: [],
	syncToPM: false,
};

describe("requestProposalApproval through the backlog apply door", () => {
	beforeEach(() => {
		h.applyChanges.mockReset();
	});

	it("names the held-back items when nothing applied", async () => {
		const message =
			"No item could be applied. The proposal is back in review.";
		h.applyChanges.mockResolvedValue({
			workflowId: null,
			message,
			proposalId: "proposal-1",
			heldBack: HELD_BACK,
		});

		await expect(requestProposalApproval(request)).resolves.toEqual({
			status: "failed",
			errors: [message],
			heldBack: HELD_BACK,
		});
	});

	it("names the held-back items beside a dispatched apply", async () => {
		h.applyChanges.mockResolvedValue({
			workflowId: "workflow-1",
			message: "Applying",
			proposalId: "proposal-1",
			heldBack: HELD_BACK,
		});

		await expect(requestProposalApproval(request)).resolves.toEqual({
			status: "dispatched",
			heldBack: HELD_BACK,
		});
	});
});
