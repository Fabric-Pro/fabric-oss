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
		recordProposalDuplicateResolution: vi.fn(),
		buildBacklogDedupGuard: vi.fn(),
		inferDedupFamily: vi.fn(),
		markPendingProposalApplied: vi.fn(),
		markProposalApplyDispatched: vi.fn(),
		projectFindFirst: vi.fn(),
		proposalUpdate: vi.fn(),
		getTemporalClient: vi.fn(),
		workflowStart: vi.fn(),
		returnFailedProposalToReview: vi.fn(),
		getPendingProposalReview: vi.fn(),
		getAppliedChangeIndexes: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getPendingProposalReview: mocks.getPendingProposalReview,
	recordProposalDuplicateResolution: mocks.recordProposalDuplicateResolution,
	getAppliedChangeIndexes: mocks.getAppliedChangeIndexes,
	db: {
		project: { findFirst: mocks.projectFindFirst },
		pendingBacklogProposal: {
			update: mocks.proposalUpdate,
			updateMany: mocks.proposalUpdate,
		},
	},
	getPendingBacklogProposal: mocks.getPendingBacklogProposal,
	buildBacklogDedupGuard: mocks.buildBacklogDedupGuard,
	inferDedupFamily: mocks.inferDedupFamily,
	markPendingProposalApplied: mocks.markPendingProposalApplied,
	markProposalApplyDispatched: mocks.markProposalApplyDispatched,
	returnFailedProposalToReview: mocks.returnFailedProposalToReview,
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
	mocks.proposalUpdate.mockResolvedValue({ count: 1 });
	mocks.getAppliedChangeIndexes.mockResolvedValue(new Set());
	mocks.returnFailedProposalToReview.mockResolvedValue(true);
	mocks.markProposalApplyDispatched.mockResolvedValue(1);
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

	it("claims APPLYING atomically before starting the workflow", async () => {
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
					status: "APPLYING",
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
		expect(mocks.recordProposalDuplicateResolution).toHaveBeenCalledTimes(
			2,
		);
		expect(mocks.recordProposalDuplicateResolution).toHaveBeenCalledWith(
			expect.objectContaining({
				proposalId: "proposal-1",
				existingEntityId: "story-existing",
			}),
		);
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
		expect(payload).toMatchObject({ userId: "user-1", planEligible: true });
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

		// Two updates: first APPLYING claim, then the FAILED revert.
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
			mocks.getPendingProposalReview.mockResolvedValue({
				syncToPM: false,
				entries: baseProposal.proposal.changes.map(
					(change, changeIndex) => ({
						change,
						changeIndex,
						selected: true,
					}),
				),
			});
			mocks.getPendingBacklogProposal.mockResolvedValue({
				...baseProposal,
				applyReviewId: "example-review",
				applyReviewWorkflowId: baseProposal.applyWorkflowId,
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

describe("retryFailedProposalProcedure — ROADMAP_RECOMMENDATION batch", () => {
	it("returns the batch to review instead of replaying its stored changes", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			source: "ROADMAP_RECOMMENDATION",
		});
		mocks.returnFailedProposalToReview.mockResolvedValue(true);

		const result = (await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as { workflowId: string | null; message: string };

		expect(result.workflowId).toBeNull();
		expect(result.message).toMatch(/Returned to review/);
		expect(mocks.returnFailedProposalToReview).toHaveBeenCalledWith(
			"proposal-1",
			{ applyWorkflowId: "wf-prev", applyReviewId: null },
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.buildBacklogDedupGuard).not.toHaveBeenCalled();
	});

	it("throws CONFLICT when another caller already moved the row", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...baseProposal,
			source: "ROADMAP_RECOMMENDATION",
		});
		mocks.returnFailedProposalToReview.mockResolvedValue(false);

		await expect(
			handlers.retry({
				input: {
					projectId: "project-1",
					proposalId: "proposal-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("workflow start failure messages", () => {
	it.each([
		[
			Object.assign(
				new Error(
					"Invalid `prisma.story.update()` invocation in /app/x.ts: connection pool timeout",
				),
				{ name: "PrismaClientKnownRequestError", code: "P2024" },
			),
			"database error P2024",
		],
		[new Error("boom"), "boom"],
	])(
		"redacts database errors and preserves other failures: %s",
		async (error, expected) => {
			mocks.getPendingBacklogProposal.mockResolvedValue(baseProposal);
			mocks.workflowStart.mockRejectedValueOnce(error);
			await expect
				.soft(
					handlers.retry({
						input: {
							projectId: "project-1",
							proposalId: "proposal-1",
							organizationId: "org-1",
						},
						context: ctx,
					}),
				)
				.rejects.toMatchObject({ message: expected });
			expect.soft(mocks.proposalUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: "FAILED",
						applyError: expected,
					}),
				}),
			);
		},
	);
});

describe("bound review replay", () => {
	it("replays only two selected entries with edits and review PM choices", async () => {
		const row = { ...baseProposal };
		const changes = [0, 1, 2].map((i) => ({
			type: "feature",
			action: "create",
			title: { to: `Original ${i}` },
		}));
		const bound = {
			...row,
			proposal: { changes },
			applyReviewId: "example-review",
			applyReviewWorkflowId: row.applyWorkflowId,
			sourceMetadata: { syncToPM: true },
		};
		mocks.getPendingBacklogProposal.mockResolvedValue(bound);
		const edited = { ...changes[0], title: { to: "Edited by reviewer" } };
		mocks.projectFindFirst.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementContainerName: "Current container",
		});
		mocks.getPendingProposalReview.mockResolvedValue({
			syncToPM: false,
			pmConfig: {
				mcpConfigId: "example-config",
				containerId: "example-container",
			},
			entries: [
				{
					selected: true,
					changeIndex: 0,
					change: edited,
					pmSyncOverride: null,
				},
				{ selected: false, changeIndex: 1, change: null },
				{
					selected: true,
					changeIndex: 2,
					change: changes[2],
					pmSyncOverride: { skip: true },
				},
			],
		});
		await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});
		const args = mocks.workflowStart.mock.calls[0]?.[1].args[0];
		expect(args).toMatchObject({
			approvedChanges: [edited, changes[2]],
			approvedChangeIndexes: [0, 2],
			syncToPM: false,
			pmSyncOverrides: { 1: { skip: true } },
			pmConfig: {
				mcpConfigId: "example-config",
				containerId: "example-container",
				containerName: "Current container",
			},
		});
		expect(mocks.proposalUpdate.mock.calls[0]?.[0]).toMatchObject({
			where: {
				applyWorkflowId: row.applyWorkflowId,
				applyReviewId: "example-review",
			},
			data: { applyReviewWorkflowId: expect.any(String) },
		});
	});
	it("does not start when the attempt changes before the CAS", async () => {
		const row = { ...baseProposal };
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...row,
			applyReviewId: "example-review",
			applyReviewWorkflowId: row.applyWorkflowId,
		});
		mocks.getPendingProposalReview.mockResolvedValue({
			syncToPM: false,
			entries: [
				{
					selected: true,
					changeIndex: 0,
					change: row.proposal.changes[0],
				},
			],
		});
		mocks.proposalUpdate.mockImplementation(
			async ({ where }: { where: { applyWorkflowId?: string } }) => ({
				count: where.applyWorkflowId === row.applyWorkflowId ? 0 : 1,
			}),
		);
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
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
	it.each([
		"TEAMS_CHANNEL",
		"SLACK_CHANNEL",
		"MONITORED_MEETING",
		"SCOPE_DOCUMENT",
	])("returns legacy %s rows to review", async (source) => {
		const row = { ...baseProposal };
		mocks.getPendingBacklogProposal.mockResolvedValue({ ...row, source });
		await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});
		expect(mocks.returnFailedProposalToReview).toHaveBeenCalledWith(
			row.id,
			{ applyWorkflowId: row.applyWorkflowId, applyReviewId: null },
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
	it("returns a stale review binding to review", async () => {
		const row = { ...baseProposal };
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...row,
			source: "TEAMS_CHANNEL",
			applyReviewId: "example-review",
			applyReviewWorkflowId: "old-code-attempt",
		});
		await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});
		expect(mocks.returnFailedProposalToReview).toHaveBeenCalledWith(
			row.id,
			{
				applyWorkflowId: row.applyWorkflowId,
				applyReviewId: "example-review",
			},
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

it("filters the application table union mirror and rekeys the surviving review override", async () => {
	const row = baseProposal;
	const changes = [0, 1, 2, 3].map((i) => ({
		type: "feature",
		action: "create",
		title: { to: `Selected ${i}` },
	}));
	mocks.getPendingBacklogProposal.mockResolvedValue({
		...row,
		applyReviewId: "example-review",
		applyReviewWorkflowId: row.applyWorkflowId,
		appliedChangeIndexes: [1],
	});
	mocks.getAppliedChangeIndexes.mockResolvedValue(new Set([0]));
	mocks.getPendingProposalReview.mockResolvedValue({
		syncToPM: false,
		entries: changes.map((change, changeIndex) => ({
			change,
			changeIndex,
			selected: true,
			pmSyncOverride: { skip: true },
		})),
	});
	mocks.buildBacklogDedupGuard.mockResolvedValue({
		findCollision: (_family: string, title: string) =>
			title === "Selected 2" ? { id: "example-existing" } : null,
	});
	await handlers.retry({
		input: {
			projectId: "project-1",
			proposalId: "proposal-1",
			organizationId: "org-1",
		},
		context: ctx,
	});
	expect(mocks.workflowStart.mock.calls[0]?.[1].args[0]).toMatchObject({
		approvedChanges: [changes[3]],
		approvedChangeIndexes: [3],
		pmSyncOverrides: { 0: { skip: true } },
	});
});
it("full dedup considers only selected review entries and fences its terminal write", async () => {
	const row = baseProposal;
	mocks.getPendingBacklogProposal.mockResolvedValue({
		...row,
		applyReviewId: "example-review",
		applyReviewWorkflowId: row.applyWorkflowId,
	});
	mocks.getPendingProposalReview.mockResolvedValue({
		syncToPM: false,
		entries: [
			{ change: row.proposal.changes[0], changeIndex: 0, selected: true },
		],
	});
	mocks.buildBacklogDedupGuard.mockResolvedValue({
		findCollision: () => ({ id: "example-existing" }),
	});
	await handlers.retry({
		input: {
			projectId: "project-1",
			proposalId: "proposal-1",
			organizationId: "org-1",
		},
		context: ctx,
	});
	expect(mocks.workflowStart).not.toHaveBeenCalled();
	expect(mocks.proposalUpdate.mock.calls[0]?.[0]).toMatchObject({
		where: {
			applyWorkflowId: row.applyWorkflowId,
			applyReviewId: "example-review",
		},
		data: { status: "APPLIED" },
	});
});

it("refuses a selected review entry without an index", async () => {
	const row = baseProposal;
	mocks.getPendingBacklogProposal.mockResolvedValue({
		...row,
		applyReviewId: "example-review",
		applyReviewWorkflowId: row.applyWorkflowId,
	});
	mocks.getPendingProposalReview.mockResolvedValue({
		syncToPM: false,
		entries: [
			{
				selected: true,
				changeIndex: null,
				change: row.proposal.changes[0],
			},
		],
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
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(mocks.workflowStart).not.toHaveBeenCalled();
	expect(mocks.proposalUpdate).not.toHaveBeenCalled();
});

describe("binding states across source groups", () => {
	it.each(
		[
			"AI_UPDATE_SIDEBAR",
			"TEAMS_CHANNEL",
			"ROADMAP_RECOMMENDATION",
		].flatMap((source) =>
			["unset", "valid", "stale"].map((binding) => ({ source, binding })),
		),
	)("$source with $binding binding", async ({ source, binding }) => {
		const row = { ...baseProposal };
		const reviewId = binding === "unset" ? null : "example-review";
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...row,
			source,
			applyReviewId: reviewId,
			applyReviewWorkflowId:
				binding === "valid"
					? row.applyWorkflowId
					: binding === "stale"
						? "example-other-attempt"
						: null,
		});
		mocks.getPendingProposalReview.mockResolvedValue({
			syncToPM: false,
			entries: [
				{
					selected: true,
					changeIndex: 0,
					change: row.proposal.changes[0],
				},
			],
		});
		await handlers.retry({
			input: {
				projectId: "project-1",
				proposalId: "proposal-1",
				organizationId: "org-1",
			},
			context: ctx,
		});
		const replay =
			source !== "ROADMAP_RECOMMENDATION" &&
			(binding === "valid" ||
				(binding === "unset" && source === "AI_UPDATE_SIDEBAR"));
		if (replay) {
			expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
			expect(mocks.returnFailedProposalToReview).not.toHaveBeenCalled();
		} else {
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expect(mocks.returnFailedProposalToReview).toHaveBeenCalledWith(
				row.id,
				{
					applyWorkflowId: row.applyWorkflowId,
					applyReviewId: reviewId,
				},
			);
		}
	});
});

function prepareRoundOneRetry(mode: "full" | "partial" | "invalid") {
	const row = baseProposal;
	const changes = [0, 1].map((i) => ({
		action: "create",
		type: "feature",
		title: { to: `Example retry ${i}` },
	}));
	const bound = {
		...row,
		applyReviewId: "example-review",
		applyReviewWorkflowId: row.applyWorkflowId,
	};

	mocks.getPendingBacklogProposal.mockResolvedValue(bound);
	mocks.getPendingProposalReview.mockResolvedValue({
		syncToPM: false,
		entries: changes.map((change, i) => ({
			selected: true,
			changeIndex: mode === "invalid" && i === 1 ? null : i,
			change,
		})),
	});
	mocks.buildBacklogDedupGuard.mockResolvedValue({
		findCollision: (_family: string, title: string) =>
			mode === "full" || title.endsWith("0")
				? { existingId: "example-existing", existingIdentifier: "EX-1" }
				: null,
		recordCreated: () => {},
	});
}
const runRoundOneRetry = () =>
	handlers.retry({
		input: {
			projectId: "project-1",
			organizationId: "org-1",
			proposalId: "proposal-1",
		},
		context: ctx,
	});
it.each(["full", "partial"] as const)(
	"a losing %s dedup claim writes no duplicate outcome",
	async (mode) => {
		prepareRoundOneRetry(mode);
		mocks.proposalUpdate.mockResolvedValue({ count: 0 });
		await expect(runRoundOneRetry()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.recordProposalDuplicateResolution).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	},
);
it("a late invalid review entry writes no duplicate outcome", async () => {
	prepareRoundOneRetry("invalid");
	await expect(runRoundOneRetry()).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
	expect(mocks.recordProposalDuplicateResolution).not.toHaveBeenCalled();
	expect(mocks.proposalUpdate).not.toHaveBeenCalled();
});
it.each(["full", "partial"] as const)(
	"a failed ledger write preserves the winning %s retry",
	async (mode) => {
		prepareRoundOneRetry(mode);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failure = new Error("Example private retry content");
		mocks.recordProposalDuplicateResolution.mockRejectedValue(failure);
		try {
			const result = (await runRoundOneRetry()) as {
				workflowId: string | null;
				dedupCollisionCount: number;
			};
			expect(result.workflowId).toBe(mode === "full" ? null : "wf-new");
			expect(result.dedupCollisionCount).toBe(mode === "full" ? 2 : 1);
			expect(mocks.proposalUpdate.mock.calls[0]?.[0].data.status).toBe(
				mode === "full" ? "APPLIED" : "APPLYING",
			);
			expect(mocks.workflowStart).toHaveBeenCalledTimes(
				mode === "full" ? 0 : 1,
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("record"),
				{ proposalId: "proposal-1", changeIndex: 0 },
			);
			expect(JSON.stringify(warn.mock.calls)).not.toContain(
				failure.message,
			);
		} finally {
			warn.mockRestore();
		}
	},
);

it("a missing project after collision detection writes no duplicate outcome", async () => {
	prepareRoundOneRetry("partial");
	mocks.projectFindFirst.mockResolvedValue(null);
	await expect(runRoundOneRetry()).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	expect(mocks.recordProposalDuplicateResolution).not.toHaveBeenCalled();
	expect(mocks.proposalUpdate).not.toHaveBeenCalled();
});
