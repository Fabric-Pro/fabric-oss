/**
 * Unit tests for `backlogPendingProposalProcedure`.
 *
 * The procedure mirrors reject: load the proposal, verify it belongs to the
 * project, then compare-and-set it to BACKLOG. Covered surfaces:
 *   - Happy path: PENDING proposal → markPendingProposalBacklog → success.
 *   - NOT_FOUND when the proposal is missing or belongs to another project.
 *   - CONFLICT when the compare-and-set matches 0 rows (the proposal was
 *     already actioned / is no longer PENDING).
 *   - Passes the reviewer id through to the query.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getProposal: vi.fn(),
		markBacklog: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getPendingBacklogProposal: mocks.getProposal,
	markPendingProposalBacklog: mocks.markBacklog,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["backlog"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../backlog-pending-proposal");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	mocks.getProposal.mockReset();
	mocks.markBacklog.mockReset();
});

describe("backlogPendingProposalProcedure", () => {
	it("moves a PENDING proposal to Backlog and returns success", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "prop-1",
			projectId: "project-1",
			status: "PENDING",
		});
		mocks.markBacklog.mockResolvedValue({ updated: true });

		const result = (await handlers.backlog({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				proposalId: "prop-1",
			},
			context: ctx,
		})) as { success: boolean };

		expect(result).toEqual({ success: true });
		expect(mocks.markBacklog).toHaveBeenCalledWith({
			proposalId: "prop-1",
			reviewedBy: "user-1",
		});
	});

	it("throws NOT_FOUND when the proposal does not exist", async () => {
		mocks.getProposal.mockResolvedValue(null);

		await expect(
			handlers.backlog({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					proposalId: "missing",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.markBacklog).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the proposal belongs to another project", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "prop-1",
			projectId: "other-project",
			status: "PENDING",
		});

		await expect(
			handlers.backlog({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					proposalId: "prop-1",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.markBacklog).not.toHaveBeenCalled();
	});

	it("throws CONFLICT when the compare-and-set matches 0 rows", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "prop-1",
			projectId: "project-1",
			status: "PENDING",
		});
		mocks.markBacklog.mockResolvedValue({ updated: false });

		await expect(
			handlers.backlog({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					proposalId: "prop-1",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
	});
});
