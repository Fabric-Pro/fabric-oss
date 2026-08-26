/**
 * Saving a workflow has to keep its Temporal Schedule in step with its status.
 *
 * The interesting direction is *off*. Pausing used to leave the cron running:
 * the sync only fired for PUBLISHED/ACTIVE, so a move to PAUSED skipped it
 * entirely and the schedule kept firing against a workflow whose card said
 * "Paused". Nothing else removes it — unpublish does, but Pause is a different
 * button and goes through `update`.
 *
 * The sync is deliberately not unconditional: autosave posts no status, and a
 * Temporal round trip on every keystroke of a draft would be waste.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { accessMock, updateWorkflowMock, syncScheduleMock } = vi.hoisted(() => ({
	accessMock: vi.fn(),
	updateWorkflowMock: vi.fn(),
	syncScheduleMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasWorkflowAccess: accessMock,
	updateWorkflow: updateWorkflowMock,
}));

vi.mock("@repo/database/prisma/zod", () => ({
	WorkflowBuilderStatusSchema: { optional: () => ({}) },
	WorkflowTriggerTypeSchema: { optional: () => ({}) },
}));

vi.mock("../../lib/sync-workflow-schedule", () => ({
	syncWorkflowSchedule: syncScheduleMock,
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ id: "member-1" }),
}));

vi.mock("../../../../orpc/procedures", () => ({
	Permissions: { WORKSPACE_UPDATE: "workspace:update" },
	requirePermission: () => (next: unknown) => next,
	resolveOrganizationId: (input: string | null | undefined) =>
		input ?? undefined,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					handler: (fn: unknown) => fn,
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { updateWorkflowProcedure } from "../update-workflow";

// biome-ignore lint/suspicious/noExplicitAny: the builder is stubbed to a bare handler above
const update = updateWorkflowProcedure as any;

const ctx = { user: { id: "user-1" }, session: {} };

/** What the update returns — the workflow's state *after* the write. */
function saved(status: string) {
	return {
		id: "wf-1",
		name: "Nightly sync",
		status,
		userId: "user-1",
		organizationId: "org-1",
		projectId: "proj-1",
		nodes: [
			{
				id: "n1",
				type: "trigger",
				data: {
					config: {
						triggerType: "schedule",
						scheduleCron: "0 9 * * *",
					},
				},
			},
		],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	accessMock.mockResolvedValue(true);
	syncScheduleMock.mockResolvedValue({ outcome: "none", reason: "test" });
});

describe("status changes sync the schedule", () => {
	it("takes the schedule down when the workflow is paused", async () => {
		updateWorkflowMock.mockResolvedValue(saved("PAUSED"));

		await update({
			input: { id: "wf-1", status: "PAUSED" },
			context: ctx,
		});

		expect(syncScheduleMock).toHaveBeenCalledWith(
			expect.objectContaining({ workflowId: "wf-1", active: false }),
		);
	});

	it("takes the schedule down when the workflow is archived", async () => {
		updateWorkflowMock.mockResolvedValue(saved("ARCHIVED"));

		await update({
			input: { id: "wf-1", status: "ARCHIVED" },
			context: ctx,
		});

		expect(syncScheduleMock).toHaveBeenCalledWith(
			expect.objectContaining({ active: false }),
		);
	});

	it("brings it back when the workflow is activated", async () => {
		updateWorkflowMock.mockResolvedValue(saved("ACTIVE"));

		await update({
			input: { id: "wf-1", status: "ACTIVE" },
			context: ctx,
		});

		expect(syncScheduleMock).toHaveBeenCalledWith(
			expect.objectContaining({ active: true }),
		);
	});
});

describe("editing a live workflow", () => {
	it("re-syncs the cron without needing a republish", async () => {
		updateWorkflowMock.mockResolvedValue(saved("PUBLISHED"));

		await update({
			input: { id: "wf-1", nodes: saved("PUBLISHED").nodes },
			context: ctx,
		});

		const [args] = syncScheduleMock.mock.calls[0];
		expect(args.active).toBe(true);
		// The saved graph is what the cron is read from.
		expect(args.nodes).toEqual(saved("PUBLISHED").nodes);
	});
});

describe("draft autosave", () => {
	it("does not reach for Temporal on every keystroke", async () => {
		updateWorkflowMock.mockResolvedValue(saved("DRAFT"));

		await update({
			input: { id: "wf-1", nodes: saved("DRAFT").nodes },
			context: ctx,
		});

		expect(syncScheduleMock).not.toHaveBeenCalled();
	});
});
