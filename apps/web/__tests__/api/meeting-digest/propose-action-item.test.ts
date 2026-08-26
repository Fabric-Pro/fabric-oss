import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findFirstActionItem,
	findFirstProposal,
	findUniqueContext,
	createPendingBacklogProposal,
	hasAccess,
} = vi.hoisted(() => ({
	findFirstActionItem: vi.fn(),
	findFirstProposal: vi.fn(),
	findUniqueContext: vi.fn(),
	createPendingBacklogProposal: vi.fn(),
	hasAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		createPendingBacklogProposal,
		hasProjectAccess: hasAccess,
		db: {
			...actual.db,
			projectMeetingActionItem: { findFirst: findFirstActionItem },
			pendingBacklogProposal: { findFirst: findFirstProposal },
			projectContext: { findUnique: findUniqueContext },
		},
	};
});

// Capture the procedure's `.handler(fn)` so the FORBIDDEN access guard can be
// exercised without a full oRPC context. Mirrors the binding stub in
// `resolve-conflict.test.ts`.
const procedureHandlers = vi.hoisted(
	() =>
		({}) as {
			propose?: (a: {
				input: Record<string, unknown>;
				context: Record<string, unknown>;
			}) => Promise<unknown>;
		},
);

vi.mock("../../../../../packages/api/orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (
			fn: (a: {
				input: Record<string, unknown>;
				context: Record<string, unknown>;
			}) => Promise<unknown>,
		) => {
			procedureHandlers.propose = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

import {
	buildActionItemProposal,
	proposeActionItemTicket,
} from "@repo/api/modules/projects/procedures/meeting-digest/propose-action-item";

describe("buildActionItemProposal", () => {
	it("wraps the item text in the analyzer's one-change schema", () => {
		expect(buildActionItemProposal("Fix the chart")).toEqual({
			summary:
				'Ticket proposed from meeting action item: "Fix the chart"',
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: "Fix the chart" },
				},
			],
		});
	});
});

describe("proposeActionItemTicket", () => {
	beforeEach(() => vi.clearAllMocks());

	const item = {
		id: "a1",
		text: "Fix the chart",
		transcript: {
			id: "t1",
			contextId: "ctx1",
			meetingId: "m1",
			transcriptId: "tr1",
			linkedMeetingId: "lm1",
			meetingSubject: "Sprint Sync",
			meetingDate: new Date("2026-01-01T00:00:00.000Z"),
		},
	};

	it("returns already-proposed when a PENDING proposal carries this actionItemId", async () => {
		findFirstActionItem.mockResolvedValue(item);
		findFirstProposal.mockResolvedValue({ id: "prop1" });

		const res = await proposeActionItemTicket({
			projectId: "p1",
			actionItemId: "a1",
			userId: "u1",
			organizationId: null,
		});

		expect(res).toEqual({
			status: "already-proposed",
			proposalId: "prop1",
		});
		expect(findFirstProposal).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				status: "PENDING",
				sourceMetadata: { path: ["actionItemId"], equals: "a1" },
			},
			select: { id: true },
		});
		expect(createPendingBacklogProposal).not.toHaveBeenCalled();
	});

	it("creates a one-change proposal and returns proposed", async () => {
		findFirstActionItem.mockResolvedValue(item);
		findFirstProposal.mockResolvedValue(null);
		findUniqueContext.mockResolvedValue({
			content: "Discussed the chart bug.",
		});
		createPendingBacklogProposal.mockResolvedValue({ id: "prop2" });

		const res = await proposeActionItemTicket({
			projectId: "p1",
			actionItemId: "a1",
			userId: "u1",
			organizationId: "org1",
		});

		expect(res).toEqual({ status: "proposed", proposalId: "prop2" });
		// Tenancy: the item lookup MUST be scoped through the transcript's
		// project — removing this scoping would let a cross-project caller
		// file proposals from another project's action items.
		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
		expect(createPendingBacklogProposal).toHaveBeenCalledWith({
			projectId: "p1",
			source: "MONITORED_MEETING",
			proposal: {
				summary:
					'Ticket proposed from meeting action item: "Fix the chart"',
				changes: [
					{
						type: "feature",
						action: "create",
						title: { to: "Fix the chart" },
					},
				],
			},
			summary:
				'Ticket proposed from meeting action item: "Fix the chart"',
			changeCount: 1,
			sourceMetadata: {
				actionItemId: "a1",
				transcriptRecordId: "t1",
				meetingId: "m1",
				transcriptId: "tr1",
				linkedMeetingId: "lm1",
				meetingSubject: "Sprint Sync",
				meetingDate: "2026-01-01T00:00:00.000Z",
				contextId: "ctx1",
				transcript: "Discussed the chart bug.",
				attachments: [],
				attachmentWarnings: [],
			},
			userId: "u1",
			organizationId: "org1",
		});
	});

	it("NOT_FOUND when the action item is not in this project", async () => {
		findFirstActionItem.mockResolvedValue(null);

		await expect(
			proposeActionItemTicket({
				projectId: "p1",
				actionItemId: "a1",
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
		expect(findFirstProposal).not.toHaveBeenCalled();
		expect(createPendingBacklogProposal).not.toHaveBeenCalled();
	});
});

describe("proposeActionItemProcedure", () => {
	beforeEach(() => vi.clearAllMocks());

	it("FORBIDDEN when the user has no access to the project", async () => {
		hasAccess.mockResolvedValue(false);

		await expect(
			procedureHandlers.propose?.({
				input: {
					projectId: "p1",
					organizationId: "org1",
					actionItemId: "a1",
				},
				context: { user: { id: "u1" }, session: {} },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(hasAccess).toHaveBeenCalledWith("p1", "u1", "org1");
		expect(findFirstActionItem).not.toHaveBeenCalled();
		expect(createPendingBacklogProposal).not.toHaveBeenCalled();
	});

	it("delegates to proposeActionItemTicket when access is granted", async () => {
		hasAccess.mockResolvedValue(true);
		findFirstActionItem.mockResolvedValue(null);

		await expect(
			procedureHandlers.propose?.({
				input: {
					projectId: "p1",
					organizationId: null,
					actionItemId: "a1",
				},
				context: { user: { id: "u1" }, session: {} },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Reached the scoped lookup — access check passed through.
		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
	});
});
