/**
 * Unit tests for `getPendingProposalProcedure`: the project check, and the
 * additive per-item outcomes: `applications` and `createdChangeIndexes` read
 * from the application table — which, unlike the `appliedChangeIndexes`
 * mirror, never counts a duplicate skip — and `rejectedChangeIndexes`.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getProposal: vi.fn(),
		listProposalApplications: vi.fn(),
		listProposalDuplicateResolutions: vi.fn(),
		readRejectedChangeIndexes: vi.fn(),
		listRestoredProposalItems: vi.fn(),
		getLinkedTeamsChatGraphId: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("../../../../../../database/prisma/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => {
	const changes = await import(
		"../../../../../../database/prisma/queries/projects/proposal-changes"
	);
	const itemState = await import(
		"../../../../../../database/prisma/queries/projects/pending-proposal-item-state"
	);
	return {
		computeProposalItemState: itemState.computeProposalItemState,
		getPendingBacklogProposal: mocks.getProposal,
		listProposalApplications: mocks.listProposalApplications,
		listProposalDuplicateResolutions:
			mocks.listProposalDuplicateResolutions,
		proposalRevision: changes.proposalRevision,
		readRejectedChangeIndexes: mocks.readRejectedChangeIndexes,
		listRestoredProposalItems: mocks.listRestoredProposalItems,
		readStoredProposalChanges: changes.readStoredProposalChanges,
		targetChangedSinceProposal: changes.targetChangedSinceProposal,
		getLinkedTeamsChatGraphId: mocks.getLinkedTeamsChatGraphId,
	};
});

import { proposalRevision } from "../../../../../../database/prisma/queries/projects/proposal-changes";

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.get = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../get-pending-proposal");

const input = {
	projectId: "project-1",
	organizationId: null,
	proposalId: "proposal-1",
};

function callGet() {
	const handler = handlers.get;
	if (!handler) {
		throw new Error("get handler was not captured");
	}
	return handler({ input });
}

beforeEach(() => {
	mocks.getProposal.mockReset();
	mocks.listProposalApplications.mockReset();
	mocks.listProposalDuplicateResolutions.mockReset();
	mocks.listProposalDuplicateResolutions.mockResolvedValue([]);
	mocks.readRejectedChangeIndexes.mockReset();
	mocks.readRejectedChangeIndexes.mockReturnValue([]);
	mocks.listRestoredProposalItems.mockReset();
	mocks.listRestoredProposalItems.mockResolvedValue([]);
	mocks.getLinkedTeamsChatGraphId.mockReset();
});

describe("getPendingProposalProcedure", () => {
	it("returns the row plus the created indexes, sorted, apart from the mirror", async () => {
		const proposal = { changes: [] };
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-1",
			changeCount: 4,
			proposal,
			appliedChangeIndexes: [3, 0, 2],
		});
		// The query returns application rows ordered by change index.
		const applications = [
			{ changeIndex: 0, createdEntityId: "story-1", action: "create" },
			{ changeIndex: 3, createdEntityId: null, action: "update" },
		];
		mocks.listProposalApplications.mockResolvedValue(applications);

		const result = await callGet();

		expect(mocks.listProposalApplications).toHaveBeenCalledWith(
			"proposal-1",
		);
		expect(result).toEqual({
			id: "proposal-1",
			projectId: "project-1",
			changeCount: 4,
			proposal,
			appliedChangeIndexes: [3, 0, 2],
			applications,
			createdChangeIndexes: [0, 3],
			duplicateResolutions: [],
			duplicateChangeIndexes: [],
			rejectedChangeIndexes: [],
			resolvedItems: [
				{ changeIndex: 0, reason: "applied" },
				{ changeIndex: 2, reason: "applied" },
				{ changeIndex: 3, reason: "applied" },
			],
			remainingCount: 1,
			proposalRevision: proposalRevision(proposal),
			targetChangedSinceProposalIndexes: [],
			heldBackUpdateIndexes: [],
			updateTargetBodies: [],
			restoredItems: [],
			teamsChatSourceLink: null,
		});
	});

	it("returns the items resolved as duplicates, with the existing ticket", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-1",
			changeCount: 2,
			appliedChangeIndexes: [],
		});
		mocks.listProposalApplications.mockResolvedValue([]);
		const duplicateResolutions = [
			{ changeIndex: 1, existingEntityId: "story-existing" },
		];
		mocks.listProposalDuplicateResolutions.mockResolvedValue(
			duplicateResolutions,
		);

		const result = await callGet();

		expect(mocks.listProposalDuplicateResolutions).toHaveBeenCalledWith(
			"proposal-1",
		);
		expect(result).toMatchObject({
			duplicateResolutions,
			duplicateChangeIndexes: [1],
		});
	});

	it("returns the items moved to Rejected one at a time", async () => {
		const sourceMetadata = { rejectedChangeIndexes: [1] };
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-1",
			sourceMetadata,
			appliedChangeIndexes: [],
		});
		mocks.listProposalApplications.mockResolvedValue([]);
		mocks.readRejectedChangeIndexes.mockReturnValue([1]);

		const result = await callGet();

		expect(mocks.readRejectedChangeIndexes).toHaveBeenCalledWith(
			sourceMetadata,
		);
		expect(result).toMatchObject({ rejectedChangeIndexes: [1] });
	});

	it("deep-links a Teams chat proposal to its root message through its linked chat, in the same project", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-1",
			source: "TEAMS_CHAT",
			sourceMetadata: {
				linkedChatId: "linked-chat-1",
				threadRootId: "1726000000000",
			},
			appliedChangeIndexes: [],
		});
		mocks.listProposalApplications.mockResolvedValue([]);
		mocks.getLinkedTeamsChatGraphId.mockResolvedValue(
			"19:example-chat@thread.v2",
		);

		const result = await callGet();

		expect(mocks.getLinkedTeamsChatGraphId).toHaveBeenCalledWith(
			"project-1",
			"linked-chat-1",
		);
		expect(result).toMatchObject({
			teamsChatSourceLink:
				"https://teams.microsoft.com/l/message/19:example-chat@thread.v2/1726000000000?context=%7B%22contextType%22%3A%22chat%22%7D",
		});
	});

	it.each([
		["the chat is no longer linked", null],
		["the chat id is not one Graph issues", "19:example/../../elsewhere"],
	])("builds no link when %s", async (_label, graphChatId) => {
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-1",
			source: "TEAMS_CHAT",
			sourceMetadata: {
				linkedChatId: "linked-chat-1",
				threadRootId: "1726000000000",
			},
			appliedChangeIndexes: [],
		});
		mocks.listProposalApplications.mockResolvedValue([]);
		mocks.getLinkedTeamsChatGraphId.mockResolvedValue(graphChatId);

		const result = await callGet();

		expect(result).toMatchObject({ teamsChatSourceLink: null });
	});

	it.each([
		[
			"a channel proposal",
			"TEAMS_CHANNEL",
			{ linkedChatId: "linked-chat-1", threadRootId: "1726000000000" },
		],
		["a chat proposal without a linked chat", "TEAMS_CHAT", {}],
		["a chat proposal with no metadata", "TEAMS_CHAT", null],
		[
			"a chat proposal with a non-numeric root message id",
			"TEAMS_CHAT",
			{ linkedChatId: "linked-chat-1", threadRootId: "../elsewhere" },
		],
	])(
		"returns no link for %s, without a lookup",
		async (_label, source, sourceMetadata) => {
			mocks.getProposal.mockResolvedValue({
				id: "proposal-1",
				projectId: "project-1",
				source,
				sourceMetadata,
				appliedChangeIndexes: [],
			});
			mocks.listProposalApplications.mockResolvedValue([]);

			const result = await callGet();

			expect(mocks.getLinkedTeamsChatGraphId).not.toHaveBeenCalled();
			expect(result).toMatchObject({ teamsChatSourceLink: null });
		},
	);

	it("is NOT_FOUND for another project's proposal, without reading its applications", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-2",
			appliedChangeIndexes: [],
		});

		await expect(callGet()).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.listProposalApplications).not.toHaveBeenCalled();
	});

	it("is NOT_FOUND for a missing proposal", async () => {
		mocks.getProposal.mockResolvedValue(null);

		await expect(callGet()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
