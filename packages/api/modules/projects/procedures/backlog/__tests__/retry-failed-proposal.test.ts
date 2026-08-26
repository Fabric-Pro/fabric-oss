/**
 * Unit tests for `retryFailedProposalProcedure`.
 *
 * Covered surfaces:
 *   - Happy path queues a workflow with the filtered change payload.
 *   - Missing proposal → NOT_FOUND; non-FAILED → CONFLICT.
 *   - Foreign tenant (org mismatch / user mismatch) → FORBIDDEN.
 *   - Project mismatch → FORBIDDEN.
 *   - Full-dedup short-circuit: every remaining change resolves via the
 *     dedup guard → no workflow start + status flipped to APPLIED.
 *   - Partial dedup: workflow only receives the non-colliding changes.
 *
 * Boundaries mocked: `@repo/database` helpers, `@repo/temporal`, the
 * oRPC procedure chain.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getPendingBacklogProposal: vi.fn(),
		buildBacklogDedupGuard: vi.fn(),
		inferDedupFamily: vi.fn(),
		markPendingProposalApplied: vi.fn(),
		projectFindFirst: vi.fn(),
		proposalUpdate: vi.fn(),
		getTemporalClient: vi.fn(),
		workflowStart: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.projectFindFirst },
		pendingBacklogProposal: { update: mocks.proposalUpdate },
	},
	getPendingBacklogProposal: mocks.getPendingBacklogProposal,
	buildBacklogDedupGuard: mocks.buildBacklogDedupGuard,
	inferDedupFamily: mocks.inferDedupFamily,
	markPendingProposalApplied: mocks.markPendingProposalApplied,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["retry"];
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

await import("../retry-failed-proposal");

const ctx = { user: { id: "user-1" }, session: {} };

const baseProposal = {
	id: "proposal-1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	// This retry path serves FAILED proposals of ANY source. The default
	// here is the general AI Update sidebar — epics stay first-class.
	source: "AI_UPDATE_SIDEBAR" as const,
	status: "FAILED" as const,
	applyWorkflowId: "wf-prev",
	appliedChangeIndexes: [] as number[],
	proposal: {
		changes: [
			{
				type: "feature",
				action: "create",
				title: { to: "New feature" },
				kindOverride: null,
			},
			{
				type: "feature",
				action: "create",
				title: { to: "Existing duplicate" },
				kindOverride: null,
			},
		],
	},
	sourceMetadata: {
		syncToPM: false,
		pmConfig: null,
		conversationId: null,
	},
	errorClass: "PmAuthError",
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		if (typeof m === "function" && "mockReset" in m) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.projectFindFirst.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
		projectManagementContainerName: null,
	});
	mocks.proposalUpdate.mockResolvedValue({ id: "proposal-1" });
	mocks.inferDedupFamily.mockReturnValue("FEATURE");
	mocks.buildBacklogDedupGuard.mockResolvedValue({
		findCollision: () => null,
		recordCreated: () => undefined,
	});
	mocks.workflowStart.mockResolvedValue({
		workflowId: "wf-new",
		firstExecutionRunId: "run-new",
	});
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart },
	});
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
});

describe("retryFailedProposalProcedure — happy path", () => {
	it("loads the proposal, builds a workflow, and returns the new workflow id", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);

		const result = (await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as { workflowId: string | null; dedupCollisionCount: number };

		expect(result.workflowId).toBe("wf-new");
		expect(result.dedupCollisionCount).toBe(0);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("flips status to PENDING (atomic) before starting the workflow", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);

		await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});

		expect(mocks.proposalUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PENDING",
					errorClass: null,
					errorMessage: null,
					failedAt: null,
				}),
			}),
		);
	});
});

describe("retryFailedProposalProcedure — guard rejections", () => {
	it("throws NOT_FOUND when the proposal does not exist", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(null);
		await expect(
			handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "missing",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
	});

	it("throws CONFLICT when status !== FAILED", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			status: "PENDING",
		});
		await expect(
			handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("throws FORBIDDEN when the proposal lives in a different project", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			projectId: "other-project",
		});
		await expect(
			handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("throws FORBIDDEN on cross-tenant access (org mismatch)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			organizationId: "org-B",
		});
		await expect(
			handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		// Sanity: dedup guard never ran on a foreign row
		expect(mocks.buildBacklogDedupGuard).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN on cross-tenant access (user mismatch)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			userId: "other-user",
		});
		await expect(
			handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("retryFailedProposalProcedure — dedup-guard", () => {
	it("full-dedup short-circuit: marks APPLIED, skips workflow, returns workflowId=null", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);
		// Every change collides — guard returns a hit for both titles.
		mocks.buildBacklogDedupGuard.mockResolvedValue({
			findCollision: () => ({
				existingIdentifier: "F-1",
				existingId: "story-existing",
			}),
			recordCreated: () => undefined,
		});

		const result = (await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as { workflowId: string | null; dedupCollisionCount: number };

		expect(result.workflowId).toBeNull();
		expect(result.dedupCollisionCount).toBe(2);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		// Atomic APPLIED flip — single update with APPLIED.
		expect(mocks.proposalUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "APPLIED" }),
			}),
		);
	});

	it("partial dedup: only the non-colliding change is sent to the workflow", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);
		// First title doesn't collide, second does.
		const callIndex = { value: 0 };
		mocks.buildBacklogDedupGuard.mockResolvedValue({
			findCollision: () => {
				const isCollision = callIndex.value === 1;
				callIndex.value += 1;
				return isCollision
					? {
							existingIdentifier: "F-2",
							existingId: "story-existing",
						}
					: null;
			},
			recordCreated: () => undefined,
		});

		const result = (await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as { workflowId: string | null; dedupCollisionCount: number };

		expect(result.dedupCollisionCount).toBe(1);
		expect(result.workflowId).toBe("wf-new");

		const startArgs = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{
				approvedChanges: Array<{ title: { to: string } }>;
				approvedChangeIndexes: number[];
			}>;
		};
		const payload = startArgs.args[0];
		expect(payload?.approvedChanges).toHaveLength(1);
		expect(payload?.approvedChanges[0]?.title.to).toBe("New feature");
		expect(payload?.approvedChangeIndexes).toEqual([0]);
	});

	it("skips changes whose index is already in appliedChangeIndexes", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			appliedChangeIndexes: [0], // first already applied
		});

		const result = (await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as { workflowId: string | null };

		expect(result.workflowId).toBe("wf-new");
		const startArgs = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{
				approvedChanges: Array<{ title: { to: string } }>;
				approvedChangeIndexes: number[];
			}>;
		};
		const payload = startArgs.args[0];
		// Only the second change is sent — the first was pre-applied.
		expect(payload?.approvedChanges).toHaveLength(1);
		expect(payload?.approvedChangeIndexes).toEqual([1]);
	});
});

describe("retryFailedProposalProcedure — workflow-start failure", () => {
	it("reverts row to FAILED and surfaces INTERNAL_SERVER_ERROR", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);
		mocks.workflowStart.mockRejectedValue(new Error("temporal hiccup"));

		await expect(
			handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

		// Two updates: first PENDING flip, then the FAILED revert.
		const updateCalls = mocks.proposalUpdate.mock.calls;
		const lastStatus = (
			updateCalls[updateCalls.length - 1]?.[0] as {
				data: { status: string };
			}
		).data.status;
		expect(lastStatus).toBe("FAILED");
	});
});

describe("retryFailedProposalProcedure — forbidEpics gated on proposal.source (Codex round 6)", () => {
	function startArgForbidEpics(): boolean | undefined {
		const startArgs = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{ forbidEpics?: boolean }>;
		};
		return startArgs.args[0]?.forbidEpics;
	}

	it.each(["TEAMS_CHANNEL", "TEAMS_CHAT", "SLACK_CHANNEL"] as const)(
		"%s FAILED proposal retried → workflow started with forbidEpics: true",
		async (source) => {
			mocks.getPendingBacklogProposal.mockResolvedValue({
				...baseProposal,
				source,
			});

			await handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			});

			expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
			expect(startArgForbidEpics()).toBe(true);
		},
	);

	it("AI_UPDATE_SIDEBAR FAILED proposal retried → forbidEpics: false (general epics preserved)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			source: "AI_UPDATE_SIDEBAR",
		});

		await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(startArgForbidEpics()).toBe(false);
	});
});
