/**
 * Unit tests for `retryAllFailedProposalsProcedure`.
 *
 * Covered surfaces:
 *   - Happy path: retries N failed proposals sequentially, returns mixed
 *     `results[]` aggregation.
 *   - Bound enforcement at 50 → RESOURCE_EXHAUSTED.
 *   - Mixed outcomes (queued / dedup_only_applied / error) all surface in
 *     the response.
 *   - Tenant XOR: rows not owned by the calling user are silently dropped
 *     from the retry set (defense-in-depth — list query is project-scoped).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		listFailedProposals: vi.fn(),
		getPendingBacklogProposal: vi.fn(),
		recordProposalDuplicateResolution: vi.fn(),
		buildBacklogDedupGuard: vi.fn(),
		inferDedupFamily: vi.fn(),
		markPendingProposalApplied: vi.fn(),
		markProposalApplyDispatched: vi.fn(),
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
	listFailedProposals: mocks.listFailedProposals,
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
	const importedHandlerKeys = ["retryAll"];
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

await import("../retry-all-failed-proposals");

const ctx = { user: { id: "user-1" }, session: {} };

function rowFor(
	id: string,
	opts: Partial<{
		userId: string;
		organizationId: string;
		source:
			| "TEAMS_CHANNEL"
			| "TEAMS_CHAT"
			| "SLACK_CHANNEL"
			| "AI_UPDATE_SIDEBAR";
	}> = {},
) {
	return {
		id,
		projectId: "project-1",
		organizationId: opts.organizationId ?? "org-1",
		userId: opts.userId ?? "user-1",
		// FAILED proposals of ANY source flow through retry-all; the flag is
		// gated PER proposal on its source.
		source: opts.source ?? "AI_UPDATE_SIDEBAR",
		status: "FAILED" as const,
		applyWorkflowId: `wf-prev-${id}`,
		appliedChangeIndexes: [] as number[],
		proposal: {
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: `Title for ${id}` },
					kindOverride: null,
				},
			],
		},
		sourceMetadata: {
			syncToPM: false,
			pmConfig: null,
			conversationId: null,
		},
	};
}

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
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
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
});

describe("retryAllFailedProposalsProcedure — happy path", () => {
	it("retries every failed proposal sequentially and returns one result per row", async () => {
		const rows = [rowFor("p1"), rowFor("p2"), rowFor("p3")];
		mocks.listFailedProposals.mockResolvedValue(rows);
		mocks.getPendingBacklogProposal.mockImplementation((id: string) =>
			rows.find((r) => r.id === id),
		);

		const result = (await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as {
			retriedCount: number;
			results: Array<{ proposalId: string; status: string }>;
		};

		expect(result.retriedCount).toBe(3);
		expect(result.results.map((r) => r.proposalId)).toEqual([
			"p1",
			"p2",
			"p3",
		]);
		expect(result.results.every((r) => r.status === "queued")).toBe(true);
	});
});

describe("retryAllFailedProposalsProcedure — bound enforcement", () => {
	it("rejects more than 50 failed rows with RESOURCE_EXHAUSTED", async () => {
		const rows = Array.from({ length: 51 }, (_, i) => rowFor(`p${i}`));
		mocks.listFailedProposals.mockResolvedValue(rows);

		await expect(
			handlers.retryAll({
				input: { projectId: "project-1", organizationId: "org-1" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
	});

	it("accepts exactly 50 failed rows", async () => {
		const rows = Array.from({ length: 50 }, (_, i) => rowFor(`p${i}`));
		mocks.listFailedProposals.mockResolvedValue(rows);
		mocks.getPendingBacklogProposal.mockImplementation((id: string) =>
			rows.find((r) => r.id === id),
		);

		const result = (await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as { retriedCount: number };
		expect(result.retriedCount).toBe(50);
	});
});

describe("retryAllFailedProposalsProcedure — mixed-result aggregation", () => {
	it("returns a queued result, a dedup_only_applied result, and an error result", async () => {
		const queuedRow = rowFor("queued-row");
		const dedupRow = rowFor("dedup-row");
		const errorRow = rowFor("error-row");
		const rows = [queuedRow, dedupRow, errorRow];
		mocks.listFailedProposals.mockResolvedValue(rows);
		mocks.getPendingBacklogProposal.mockImplementation((id: string) =>
			rows.find((r) => r.id === id),
		);

		// Dedup guard differentiates by row id via call sequence — row 2
		// (dedup-row) collides on its single change.
		let buildCall = 0;
		mocks.buildBacklogDedupGuard.mockImplementation(async () => {
			const call = buildCall++;
			if (call === 1) {
				return {
					findCollision: () => ({
						existingIdentifier: "F-1",
						existingId: "story-existing",
					}),
					recordCreated: () => undefined,
				};
			}
			return {
				findCollision: () => null,
				recordCreated: () => undefined,
			};
		});

		// Workflow start succeeds first, fails second time.
		let startCall = 0;
		mocks.workflowStart.mockImplementation(async () => {
			const call = startCall++;
			if (call === 0) {
				return { workflowId: "wf-1", firstExecutionRunId: "run-1" };
			}
			throw new Error("simulated temporal start failure");
		});

		const result = (await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as {
			retriedCount: number;
			results: Array<{
				proposalId: string;
				status: "queued" | "dedup_only_applied" | "error";
			}>;
		};

		expect(
			result.results.find((r) => r.proposalId === "queued-row")?.status,
		).toBe("queued");
		expect(
			result.results.find((r) => r.proposalId === "dedup-row")?.status,
		).toBe("dedup_only_applied");
		expect(
			result.results.find((r) => r.proposalId === "error-row")?.status,
		).toBe("error");
		// retriedCount excludes the error row.
		expect(result.retriedCount).toBe(2);
		expect(mocks.recordProposalDuplicateResolution).toHaveBeenCalledWith(
			expect.objectContaining({ existingEntityId: "story-existing" }),
		);
	});
});

describe("retryAllFailedProposalsProcedure — tenant XOR defense", () => {
	it("drops rows whose userId does not match the calling user", async () => {
		const ownRow = rowFor("own");
		const foreignRow = rowFor("foreign", { userId: "other-user" });
		mocks.listFailedProposals.mockResolvedValue([ownRow, foreignRow]);
		mocks.getPendingBacklogProposal.mockImplementation((id: string) => {
			if (id === "own") {
				return ownRow;
			}
			return foreignRow;
		});

		const result = (await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as { results: Array<{ proposalId: string }> };

		expect(result.results.map((r) => r.proposalId)).toEqual(["own"]);
	});
});

describe("retryAllFailedProposalsProcedure — forbidEpics per-source gating (Codex round 6)", () => {
	it("a mixed batch gates forbidEpics PER proposal source (channel-monitor → true, AI_UPDATE_SIDEBAR → false)", async () => {
		// Row 1 is a channel-monitor source; row 2 is the general AI Update
		// sidebar. Each workflow start must carry the flag for ITS source.
		const baseChannelRow = rowFor("channel-row", {
			source: "TEAMS_CHANNEL",
		});
		const channelRow = {
			...baseChannelRow,
			applyReviewId: "example-review",
			applyReviewWorkflowId: baseChannelRow.applyWorkflowId,
		};
		mocks.getPendingProposalReview.mockResolvedValue({
			syncToPM: false,
			entries: channelRow.proposal.changes.map((change, changeIndex) => ({
				change,
				changeIndex,
				selected: true,
			})),
		});
		const sidebarRow = rowFor("sidebar-row", {
			source: "AI_UPDATE_SIDEBAR",
		});
		const rows = [channelRow, sidebarRow];
		mocks.listFailedProposals.mockResolvedValue(rows);
		mocks.getPendingBacklogProposal.mockImplementation((id: string) =>
			rows.find((r) => r.id === id),
		);

		await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
		const flagFor = (callIdx: number): boolean | undefined => {
			const startArgs = mocks.workflowStart.mock.calls[callIdx]?.[1] as {
				args: Array<{ forbidEpics?: boolean }>;
			};
			return startArgs.args[0]?.forbidEpics;
		};
		// First start = channel-monitor row → true; second = sidebar → false.
		expect(flagFor(0)).toBe(true);
		expect(flagFor(1)).toBe(false);
	});
});

describe("retryAllFailedProposalsProcedure — ROADMAP_RECOMMENDATION batch", () => {
	it("returns a recommendation batch to review and queues the others", async () => {
		const rows = [
			rowFor("p1", { source: "ROADMAP_RECOMMENDATION" }),
			rowFor("p2"),
		];
		mocks.listFailedProposals.mockResolvedValue(rows);
		mocks.getPendingBacklogProposal.mockImplementation((id: string) =>
			rows.find((r) => r.id === id),
		);
		mocks.returnFailedProposalToReview.mockResolvedValue(true);

		const result = (await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as {
			retriedCount: number;
			results: Array<{
				proposalId: string;
				status: string;
				workflowId: string | null;
			}>;
		};

		expect(result.results[0]).toMatchObject({
			proposalId: "p1",
			status: "returned_to_review",
			workflowId: null,
		});
		expect(result.results[1]?.status).toBe("queued");
		expect(mocks.returnFailedProposalToReview).toHaveBeenCalledWith("p1", {
			applyWorkflowId: "wf-prev-p1",
			applyReviewId: null,
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
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
			const row = rowFor("proposal-1");
			mocks.listFailedProposals.mockResolvedValue([row]);
			mocks.getPendingBacklogProposal.mockResolvedValue(row);
			mocks.workflowStart.mockRejectedValueOnce(error);
			const result = (await handlers.retryAll({
				input: { projectId: "project-1", organizationId: "org-1" },
				context: ctx,
			})) as { results: { message: string }[] };
			expect.soft(result.results[0]?.message).toBe(expected);
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
		const row = { ...rowFor("proposal-1") };
		mocks.listFailedProposals.mockResolvedValue([row]);
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
		await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
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
		const row = { ...rowFor("proposal-1") };
		mocks.listFailedProposals.mockResolvedValue([row]);
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
		const result = (await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as { results: Array<{ status: string }> };
		expect(result.results[0]?.status).toBe("error");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
	it.each([
		"TEAMS_CHANNEL",
		"SLACK_CHANNEL",
		"MONITORED_MEETING",
		"SCOPE_DOCUMENT",
	])("returns legacy %s rows to review", async (source) => {
		const row = { ...rowFor("proposal-1") };
		mocks.listFailedProposals.mockResolvedValue([row]);
		mocks.getPendingBacklogProposal.mockResolvedValue({ ...row, source });
		await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		});
		expect(mocks.returnFailedProposalToReview).toHaveBeenCalledWith(
			row.id,
			{ applyWorkflowId: row.applyWorkflowId, applyReviewId: null },
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
	it("returns a stale review binding to review", async () => {
		const row = { ...rowFor("proposal-1") };
		mocks.listFailedProposals.mockResolvedValue([row]);
		mocks.getPendingBacklogProposal.mockResolvedValue({
			...row,
			source: "TEAMS_CHANNEL",
			applyReviewId: "example-review",
			applyReviewWorkflowId: "old-code-attempt",
		});
		await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
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
	const row = rowFor("proposal-1");
	mocks.listFailedProposals.mockResolvedValue([row]);
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
	await handlers.retryAll({
		input: { projectId: "project-1", organizationId: "org-1" },
		context: ctx,
	});
	expect(mocks.workflowStart.mock.calls[0]?.[1].args[0]).toMatchObject({
		approvedChanges: [changes[3]],
		approvedChangeIndexes: [3],
		pmSyncOverrides: { 0: { skip: true } },
	});
});
it("full dedup considers only selected review entries and fences its terminal write", async () => {
	const row = rowFor("proposal-1");
	mocks.listFailedProposals.mockResolvedValue([row]);
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
	await handlers.retryAll({
		input: { projectId: "project-1", organizationId: "org-1" },
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
	const row = rowFor("proposal-1");
	mocks.listFailedProposals.mockResolvedValue([row]);
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
	const result = (await handlers.retryAll({
		input: { projectId: "project-1", organizationId: "org-1" },
		context: ctx,
	})) as { results: Array<{ status: string }> };
	expect(result.results[0]?.status).toBe("error");
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
		const row = rowFor("proposal-1");
		mocks.listFailedProposals.mockResolvedValue([row]);
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
		await handlers.retryAll({
			input: { projectId: "project-1", organizationId: "org-1" },
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
	const row = rowFor("proposal-1");
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
	mocks.listFailedProposals.mockResolvedValue([bound]);
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
	handlers.retryAll({
		input: { projectId: "project-1", organizationId: "org-1" },
		context: ctx,
	});
it.each(["full", "partial"] as const)(
	"a losing %s dedup claim writes no duplicate outcome",
	async (mode) => {
		prepareRoundOneRetry(mode);
		mocks.proposalUpdate.mockResolvedValue({ count: 0 });
		expect(
			(
				(await runRoundOneRetry()) as {
					results: Array<{ status: string }>;
				}
			).results[0]?.status,
		).toBe("error");
		expect(mocks.recordProposalDuplicateResolution).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	},
);
it("a late invalid review entry writes no duplicate outcome", async () => {
	prepareRoundOneRetry("invalid");
	expect(
		((await runRoundOneRetry()) as { results: Array<{ status: string }> })
			.results[0]?.status,
	).toBe("error");
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
				results: Array<{ status: string }>;
			};
			expect(result.results[0]?.status).toBe(
				mode === "full" ? "dedup_only_applied" : "queued",
			);
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
