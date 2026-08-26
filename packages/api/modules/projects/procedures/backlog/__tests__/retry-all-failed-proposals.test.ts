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
		buildBacklogDedupGuard: vi.fn(),
		inferDedupFamily: vi.fn(),
		markPendingProposalApplied: vi.fn(),
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
	listFailedProposals: mocks.listFailedProposals,
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
	mocks.proposalUpdate.mockResolvedValue({});
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
		const channelRow = rowFor("channel-row", { source: "TEAMS_CHANNEL" });
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
