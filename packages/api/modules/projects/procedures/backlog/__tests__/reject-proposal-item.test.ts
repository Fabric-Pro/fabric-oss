/**
 * "Move to Rejected" for one item of a Proposal Inbox proposal: edit
 * permission on the project is required, the proposal must belong to the
 * project, and each outcome of the compare-and-set move maps to its own
 * response.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, uses, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
	mocks: {
		canEdit: vi.fn(),
		getProposal: vi.fn(),
		move: vi.fn(),
		note: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	canEditProject: mocks.canEdit,
	getPendingBacklogProposal: mocks.getProposal,
	movePendingProposalItemToBacklog: mocks.move,
}));

vi.mock("../rejected-update-note", () => ({
	noteRejectedProposalUpdate: mocks.note,
}));

vi.mock("../proposal-approval-guards", () => ({
	PROPOSAL_ALREADY_ACTIONED_MESSAGE: "already actioned",
	PROPOSAL_CHANGED_MESSAGE: "proposal changed",
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.rejectItem = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: (permission: string) => {
			uses.push({ requireProjectPermission: permission });
			return (c: unknown) => c;
		},
	};
});

await import("../reject-proposal-item");

const proposal = {
	id: "prop-1",
	projectId: "project-1",
	organizationId: "org-1",
	status: "PENDING",
	proposal: { changes: [] },
};

const call = (input: Record<string, unknown> = {}) =>
	handlers.rejectItem({
		input: {
			projectId: "project-1",
			organizationId: "org-1",
			proposalId: "prop-1",
			changeIndex: 1,
			...input,
		},
		context: {
			user: { id: "user-1", name: "Example Reviewer" },
			session: {},
		},
	});

async function errorFrom(promise: unknown) {
	try {
		await promise;
	} catch (error) {
		return error as { code?: string; message?: string };
	}
	throw new Error("expected the handler to throw");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.canEdit.mockResolvedValue(true);
	mocks.getProposal.mockResolvedValue(proposal);
	mocks.move.mockResolvedValue({ outcome: "moved" });
	mocks.note.mockResolvedValue(undefined);
});

describe("rejectProposalItemProcedure", () => {
	it("requires the project update permission", () => {
		expect(uses).toContainEqual({
			requireProjectPermission: "project:update",
		});
	});

	it("refuses a caller who cannot edit the project before reading anything", async () => {
		mocks.canEdit.mockResolvedValue(false);

		const error = await errorFrom(call());

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.canEdit).toHaveBeenCalledWith("project-1", "user-1");
		expect(mocks.getProposal).not.toHaveBeenCalled();
		expect(mocks.move).not.toHaveBeenCalled();
	});

	it("reports a proposal of another project as not found", async () => {
		mocks.getProposal.mockResolvedValue({
			...proposal,
			projectId: "other-project",
		});

		const error = await errorFrom(call());

		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.move).not.toHaveBeenCalled();
	});

	it("moves the item as the caller and returns the split row", async () => {
		mocks.move.mockResolvedValue({
			outcome: "split",
			splitProposalId: "prop-2",
		});

		await expect(call()).resolves.toEqual({
			success: true,
			updated: true,
			splitProposalId: "prop-2",
		});
		expect(mocks.move).toHaveBeenCalledWith({
			proposalId: "prop-1",
			changeIndex: 1,
			reviewedBy: "user-1",
		});
		expect(mocks.note).not.toHaveBeenCalled();
	});

	it("notes a fully rejected update on its ticket only when asked", async () => {
		await expect(call({ noteRejectedUpdate: true })).resolves.toEqual({
			success: true,
			updated: true,
		});

		expect(mocks.note).toHaveBeenCalledWith({
			proposal,
			changeIndex: 1,
			tenantFilter: { organizationId: "org-1", userId: "user-1" },
			reviewerName: "Example Reviewer",
		});
	});

	it("takes the note's organization from the proposal, not the input", async () => {
		await call({
			organizationId: "example-org-2",
			noteRejectedUpdate: true,
		});

		expect(mocks.note).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: { organizationId: "org-1", userId: "user-1" },
			}),
		);
	});

	it("reports an item another reviewer resolved as already actioned", async () => {
		mocks.move.mockResolvedValue({ outcome: "already_resolved" });

		const error = await errorFrom(call({ noteRejectedUpdate: true }));

		expect(error).toMatchObject({
			code: "CONFLICT",
			message: "already actioned",
		});
		expect(mocks.note).not.toHaveBeenCalled();
	});

	it("reports a proposal that changed under the reviewer as changed", async () => {
		mocks.move.mockResolvedValue({ outcome: "proposal_changed" });

		const error = await errorFrom(call());

		expect(error).toMatchObject({
			code: "CONFLICT",
			message: "proposal changed",
		});
	});

	it("rejects an index the proposal no longer has", async () => {
		mocks.move.mockResolvedValue({ outcome: "invalid_index" });

		const error = await errorFrom(call());

		expect(error.code).toBe("BAD_REQUEST");
	});
});
