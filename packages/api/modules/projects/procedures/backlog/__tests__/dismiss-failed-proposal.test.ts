/**
 * Unit tests for `dismissFailedProposalProcedure`.
 *
 * Covered surfaces:
 *   - Happy path: PmSyncLog row written + proposal row deleted in a single
 *     transaction; returns { success: true, syncLogId }.
 *   - Non-FAILED status → CONFLICT, no transaction work.
 *   - Foreign tenant → FORBIDDEN.
 *   - Transaction atomicity: if the PmSyncLog write fails mid-transaction,
 *     the proposal row is NOT deleted (the $transaction callback rejects).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getPendingBacklogProposal: vi.fn(),
		dbTransaction: vi.fn(),
		pmSyncLogCreate: vi.fn(),
		pendingBacklogProposalDelete: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		$transaction: (...args: unknown[]) => mocks.dbTransaction(...args),
	},
	getPendingBacklogProposal: mocks.getPendingBacklogProposal,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["dismiss"];
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

await import("../dismiss-failed-proposal");

const ctx = { user: { id: "user-1" }, session: {} };

const baseProposal = {
	id: "proposal-1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	status: "FAILED" as const,
	applyWorkflowId: "wf-prev",
	errorClass: "PmAuthError",
	errorMessage: "Auth failed",
	applyError: "PmAuthError: 401 ...",
	summary: "1 proposed change(s) from AI Update",
	proposal: {
		changes: [
			{
				type: "feature",
				action: "create",
				title: { to: "Failed proposal title" },
			},
		],
	},
	sourceMetadata: {
		pmConfig: { mcpConfigId: "mcp-xyz", containerId: "container-1" },
	},
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		if (typeof m === "function" && "mockReset" in m) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.pmSyncLogCreate.mockResolvedValue({ id: "log-new-1" });
	mocks.pendingBacklogProposalDelete.mockResolvedValue({});
	mocks.dbTransaction.mockImplementation(
		async (
			callback: (tx: {
				pmSyncLog: { create: typeof mocks.pmSyncLogCreate };
				pendingBacklogProposal: {
					delete: typeof mocks.pendingBacklogProposalDelete;
				};
			}) => unknown,
		) =>
			callback({
				pmSyncLog: { create: mocks.pmSyncLogCreate },
				pendingBacklogProposal: {
					delete: mocks.pendingBacklogProposalDelete,
				},
			}),
	);
});

describe("dismissFailedProposalProcedure — happy path", () => {
	it("writes PmSyncLog and deletes the proposal in one transaction", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);

		const result = (await handlers.dismiss({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as { success: boolean; syncLogId: string };

		expect(result).toEqual({ success: true, syncLogId: "log-new-1" });
		expect(mocks.pmSyncLogCreate).toHaveBeenCalledTimes(1);
		expect(mocks.pendingBacklogProposalDelete).toHaveBeenCalledTimes(1);
		// Single $transaction call — never two separate writes.
		expect(mocks.dbTransaction).toHaveBeenCalledTimes(1);
	});

	it("populates PmSyncLog with FAILURE status + errorPayload snapshot", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);

		await handlers.dismiss({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});

		expect(mocks.pmSyncLogCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				status: "FAILURE",
				direction: "push",
				entityType: "STORY",
				correlationId: "wf-prev",
				actorUserId: "user-1",
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
				pmTool: "mcp-xyz",
				errorPayload: expect.objectContaining({
					errorClass: "PmAuthError",
					applyError: "PmAuthError: 401 ...",
				}),
			}),
		});
	});

	it("snapshots the first change title (best-effort) when sourceMetadata exists", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);

		await handlers.dismiss({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});

		const createArgs = mocks.pmSyncLogCreate.mock.calls[0]?.[0] as {
			data: { title: string };
		};
		expect(createArgs.data.title).toBe("Failed proposal title");
	});

	it("falls back to pmTool='none' when no pmConfig is on the metadata", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			sourceMetadata: {},
		});

		await handlers.dismiss({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});

		const createArgs = mocks.pmSyncLogCreate.mock.calls[0]?.[0] as {
			data: { pmTool: string };
		};
		expect(createArgs.data.pmTool).toBe("none");
	});
});

describe("dismissFailedProposalProcedure — guard rejections", () => {
	it("throws CONFLICT when status !== FAILED", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			status: "APPLIED",
		});

		await expect(
			handlers.dismiss({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.dbTransaction).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN on cross-tenant (organization mismatch)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			organizationId: "org-B",
		});

		await expect(
			handlers.dismiss({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.dbTransaction).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN on cross-tenant (user mismatch)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			userId: "other-user",
		});

		await expect(
			handlers.dismiss({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("throws NOT_FOUND when the proposal does not exist", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(null);

		await expect(
			handlers.dismiss({
				input: {
					projectId: "project-1",
					proposalId: "missing",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("dismissFailedProposalProcedure — atomicity", () => {
	it("rejects without deleting the proposal when the PmSyncLog write fails", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);
		mocks.pmSyncLogCreate.mockRejectedValue(
			new Error("constraint violation"),
		);

		await expect(
			handlers.dismiss({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toThrow(/constraint violation/);

		// pendingBacklogProposal.delete is gated behind the create — the
		// callback rejects before reaching it.
		expect(mocks.pendingBacklogProposalDelete).not.toHaveBeenCalled();
	});
});
