/**
 * Procedure-level tests for the Security & Accessibility Scanning enhancement
 * API surface. These exercise each handler's ORCHESTRATION (tenant gate, the DB
 * calls it makes, the count it returns, the workflow args it threads) with
 * `@repo/database` and the temporal client mocked — no Prisma / no worker.
 *
 * Pattern mirrors the repo's other procedure unit tests (e.g. incidents/
 * add-comment): the `../../../../orpc/procedures` chainable is stubbed so
 * `.handler(fn)` hands back `{ _handler: fn }`, which we invoke directly.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- @repo/database mock (hoisted spies shared across the suite) -------------
const {
	mockHasProjectAccess,
	mockUpdateScanFinding,
	mockRecordScanActivity,
	mockListScanFindings,
	mockGetScanFindingReview,
	mockGetLatestScanFindingReview,
	mockCreateScanFindingReview,
	mockHasActiveScanReview,
	mockUpdateScanFindingReview,
	mockDeleteOpenProjectScanFindings,
	mockGetProjectScanConfig,
	mockGetProjectReposForCodeSearch,
	mockGetLatestProjectScan,
	mockGetProjectScan,
	mockCreateProjectScan,
	mockUpdateProjectScan,
	mockFailScanIfActive,
	mockHasActiveScan,
	mockCountIncrementalChangedItems,
	mockGetScanCheckpoint,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockUpdateScanFinding: vi.fn(),
	mockRecordScanActivity: vi.fn(),
	mockListScanFindings: vi.fn(),
	mockGetScanFindingReview: vi.fn(),
	mockGetLatestScanFindingReview: vi.fn(),
	mockCreateScanFindingReview: vi.fn(),
	mockHasActiveScanReview: vi.fn(),
	mockUpdateScanFindingReview: vi.fn(),
	mockDeleteOpenProjectScanFindings: vi.fn(),
	mockGetProjectScanConfig: vi.fn(),
	mockGetProjectReposForCodeSearch: vi.fn(),
	mockGetLatestProjectScan: vi.fn(),
	mockGetProjectScan: vi.fn(),
	mockCreateProjectScan: vi.fn(),
	mockUpdateProjectScan: vi.fn(),
	mockFailScanIfActive: vi.fn(),
	mockHasActiveScan: vi.fn(),
	mockCountIncrementalChangedItems: vi.fn(),
	mockGetScanCheckpoint: vi.fn(),
}));

// Spread the REAL @repo/database exports (so transitively-eager consumers —
// @repo/payments wiring `setAiUsageRecorder`, @repo/ai reading
// `DB_GATEWAY_PROVIDERS` — find every symbol they expect at module-eval), then
// override the handful of query functions these procedures call + `db` so no
// Prisma connection is opened.
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {},
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		updateScanFinding: (...a: unknown[]) => mockUpdateScanFinding(...a),
		recordScanActivity: (...a: unknown[]) => mockRecordScanActivity(...a),
		listScanFindings: (...a: unknown[]) => mockListScanFindings(...a),
		getScanFindingReview: (...a: unknown[]) =>
			mockGetScanFindingReview(...a),
		getLatestScanFindingReview: (...a: unknown[]) =>
			mockGetLatestScanFindingReview(...a),
		createScanFindingReview: (...a: unknown[]) =>
			mockCreateScanFindingReview(...a),
		hasActiveScanReview: (...a: unknown[]) => mockHasActiveScanReview(...a),
		updateScanFindingReview: (...a: unknown[]) =>
			mockUpdateScanFindingReview(...a),
		deleteOpenProjectScanFindings: (...a: unknown[]) =>
			mockDeleteOpenProjectScanFindings(...a),
		getProjectScanConfig: (...a: unknown[]) =>
			mockGetProjectScanConfig(...a),
		getProjectReposForCodeSearch: (...a: unknown[]) =>
			mockGetProjectReposForCodeSearch(...a),
		getLatestProjectScan: (...a: unknown[]) =>
			mockGetLatestProjectScan(...a),
		// cancel-scan loads the scan by id (tenant-scoped) before terminating.
		getProjectScan: (...a: unknown[]) => mockGetProjectScan(...a),
		// cancel-scan compare-and-sets the row to FAILED via failScanIfActive.
		failScanIfActive: (...a: unknown[]) => mockFailScanIfActive(...a),
		// The start-scan helper (reached via trigger-scan) calls these.
		createProjectScan: (...a: unknown[]) => mockCreateProjectScan(...a),
		updateProjectScan: (...a: unknown[]) => mockUpdateProjectScan(...a),
		// trigger-scan's per-branch dedupe + FR4 no-op guard.
		hasActiveScan: (...a: unknown[]) => mockHasActiveScan(...a),
		countIncrementalChangedItems: (...a: unknown[]) =>
			mockCountIncrementalChangedItems(...a),
		getScanCheckpoint: (...a: unknown[]) => mockGetScanCheckpoint(...a),
	};
});

// --- temporal client mock (used by start-scan helper + start-review +
// cancel-review). cancel-review reaches workflow.getHandle(id).terminate(...).
const {
	mockWorkflowStart,
	mockTerminate,
	mockGetHandle,
	mockGetTemporalClient,
} = vi.hoisted(() => {
	const start = vi.fn();
	const terminate = vi.fn();
	const getHandle = vi.fn(() => ({ terminate }));
	return {
		mockWorkflowStart: start,
		mockTerminate: terminate,
		mockGetHandle: getHandle,
		mockGetTemporalClient: vi.fn(async () => ({
			workflow: { start, getHandle },
		})),
	};
});
vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => mockGetTemporalClient(...a),
}));

// Identity passthrough so the workflow args/options are inspectable verbatim.
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

// --- @repo/atlas mock: new AtlasService(...).listBranches(...) — consulted only
// by trigger-scan's FR4 no-op guard (live HEAD SHA per branch). Mirrors
// branch-status.test.ts so the real Atlas graph never loads.
const { mockListBranches } = vi.hoisted(() => ({
	mockListBranches: vi.fn(),
}));
vi.mock("@repo/atlas", () => ({
	AtlasService: class {
		listBranches = (...a: unknown[]) => mockListBranches(...a);
	},
}));

// --- procedures chainable: `.handler(fn)` -> `{ _handler: fn }` --------------
// NOTE: the procedure files (one directory up, in `scan/`) import this as
// `../../../../orpc/procedures`; from THIS test file (in `scan/__tests__/`) the
// same absolute module is `../../../../../orpc/procedures` (one level deeper).
// vitest resolves mock specifiers relative to the file declaring them, so the
// specifier here MUST use the 5-level path to mock what the procedures import.
const { proceduresMockFactory } = vi.hoisted(() => ({
	proceduresMockFactory: () => {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: unknown) => ({ _handler: fn }),
		});
		return {
			tenantProtectedProcedure: chainable,
			Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
			requireProjectPermission: () => (c: unknown) => c,
		};
	},
}));
vi.mock("../../../../../orpc/procedures", proceduresMockFactory);
vi.mock("../../../../orpc/procedures", proceduresMockFactory);

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

const ctx = { user: { id: "user-1" } };

async function loadHandler(
	module: string,
	exportName: string,
): Promise<Handler> {
	const mod = (await import(module)) as Record<string, { _handler: Handler }>;
	return mod[exportName]._handler;
}

// `loadHandler` imports inside the test body, so whichever test reaches a
// handler module FIRST pays that module's cold transform against its own
// `testTimeout`. The dep graph behind these is the expensive one this package's
// vitest.config.ts already warns about (Prisma client, ai-sdk, @repo/temporal,
// slower to transform under Vitest 4's module runner than it was under v3).
// Measured in this file: the first test to reach `../bulk-update-findings` runs
// 4077ms against 5-19ms for every other test in it — a cost that belongs to the
// import, not to anything the test asserts.
//
// That is what made this file flaky rather than slow (Fabric item 897). On a
// loaded CI runner with cold caches the import intermittently tips past 20s,
// and the failure does not stop there: vitest fails the test at the timeout but
// cannot cancel the promise, so the abandoned continuation drains the three
// `mockResolvedValueOnce` values queued by "applies the patch to each id" into
// whichever test is running when it lands. The next one asserts a single call
// and sees four. One timeout, two failures, and the second names a mock count
// rather than the import that actually broke.
//
// Warming the graph once here pays the transform before any test runs.
//
// This is deliberately TOP-LEVEL rather than a `beforeAll`. A hook would move
// the same cold import off `testTimeout` and straight onto `hookTimeout`, which
// this package never sets and which therefore defaults to 10s — half the budget
// the import was already exceeding, so the fix would have failed sooner than the
// bug it replaced. Both numbers were measured here rather than read off the
// docs: a `beforeAll` sleeping 30s reports "Hook timed out in 10000ms", while a
// 15s top-level await completes, because collection is bound by neither budget.
//
// `vi.mock` calls are hoisted above this, so the mocks are registered before
// these imports evaluate. Isolation is unchanged either way: `vi.resetModules()`
// still hands each test a fresh module instance, because it resets the module
// registry and not Vite's transform cache.
await Promise.all([
	import("../apply-review"),
	import("../bulk-update-findings"),
	import("../cancel-review"),
	import("../cancel-scan"),
	import("../list-findings"),
	import("../start-review"),
	import("../trigger-scan"),
]);

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetProjectReposForCodeSearch.mockResolvedValue([]);
	mockRecordScanActivity.mockResolvedValue(undefined);
	mockUpdateScanFindingReview.mockResolvedValue(undefined);
	// Defaults for trigger-scan's dedupe + no-op guard: nothing mid-scan, and the
	// planning signal reports "everything is new" (never no-op) unless a test opts
	// in. The checkpoint/branch-listing paths only run when a test drives them.
	mockHasActiveScan.mockResolvedValue(false);
	mockCountIncrementalChangedItems.mockResolvedValue(Number.MAX_SAFE_INTEGER);
	mockGetScanCheckpoint.mockResolvedValue(null);
	mockListBranches.mockResolvedValue([]);
});

// =============================================================================
// bulk-update-findings (G8)
// =============================================================================
describe("bulkUpdateFindingsProcedure", () => {
	it("applies the patch to each id (tenant-scoped) and returns the updated count", async () => {
		// Two of three ids update; the third (foreign project) does not.
		mockUpdateScanFinding
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const handler = await loadHandler(
			"../bulk-update-findings",
			"bulkUpdateFindingsProcedure",
		);

		const result = await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				findingIds: ["f1", "f2", "f3"],
				status: "DISMISSED",
			},
			context: ctx,
		});

		expect(result).toEqual({ updated: 2 });
		// Every update is scoped by projectId (tenant safety).
		expect(mockUpdateScanFinding).toHaveBeenCalledTimes(3);
		for (const call of mockUpdateScanFinding.mock.calls) {
			expect(call[1]).toBe("proj-1");
			expect(call[2]).toMatchObject({ status: "DISMISSED" });
		}
		// One FINDINGS_REVIEWED page-history entry for the whole batch.
		expect(mockRecordScanActivity).toHaveBeenCalledTimes(1);
		expect(mockRecordScanActivity.mock.calls[0][0]).toMatchObject({
			type: "FINDINGS_REVIEWED",
			projectId: "proj-1",
		});
	});

	it("de-dupes repeated ids so the count is not inflated", async () => {
		mockUpdateScanFinding.mockResolvedValue(true);
		const handler = await loadHandler(
			"../bulk-update-findings",
			"bulkUpdateFindingsProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				findingIds: ["f1", "f1", "f1"],
				severity: "LOW",
			},
			context: ctx,
		});
		expect(result).toEqual({ updated: 1 });
		expect(mockUpdateScanFinding).toHaveBeenCalledTimes(1);
	});

	it("throws FORBIDDEN and writes nothing when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler(
			"../bulk-update-findings",
			"bulkUpdateFindingsProcedure",
		);
		await expect(
			handler({
				input: {
					projectId: "proj-x",
					findingIds: ["f1"],
					status: "RESOLVED",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockUpdateScanFinding).not.toHaveBeenCalled();
		expect(mockRecordScanActivity).not.toHaveBeenCalled();
	});

	it("records nothing when no rows actually changed", async () => {
		mockUpdateScanFinding.mockResolvedValue(false);
		const handler = await loadHandler(
			"../bulk-update-findings",
			"bulkUpdateFindingsProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				findingIds: ["f1", "f2"],
				status: "RESOLVED",
			},
			context: ctx,
		});
		expect(result).toEqual({ updated: 0 });
		expect(mockRecordScanActivity).not.toHaveBeenCalled();
	});
});

// =============================================================================
// apply-review (G7 apply path)
// =============================================================================
describe("applyReviewProcedure", () => {
	it("applies the confirmed subset and returns the applied count", async () => {
		mockGetScanFindingReview.mockResolvedValue({
			id: "rev-1",
			projectId: "proj-1",
		});
		// First decision dismisses, second re-grades severity; both land.
		mockUpdateScanFinding.mockResolvedValue(true);
		const handler = await loadHandler(
			"../apply-review",
			"applyReviewProcedure",
		);

		const result = await handler({
			input: {
				projectId: "proj-1",
				reviewId: "rev-1",
				decisions: [
					{ findingId: "f1", status: "DISMISSED" },
					{ findingId: "f2", severity: "LOW" },
				],
			},
			context: ctx,
		});

		expect(result).toEqual({ applied: 2 });
		expect(mockUpdateScanFinding).toHaveBeenNthCalledWith(
			1,
			"f1",
			"proj-1",
			{
				status: "DISMISSED",
				severity: undefined,
			},
		);
		expect(mockUpdateScanFinding).toHaveBeenNthCalledWith(
			2,
			"f2",
			"proj-1",
			{
				status: undefined,
				severity: "LOW",
			},
		);
		expect(mockRecordScanActivity.mock.calls[0][0]).toMatchObject({
			type: "FINDINGS_REVIEWED",
		});
	});

	it("only counts the rows that actually moved (partial subset)", async () => {
		mockGetScanFindingReview.mockResolvedValue({
			id: "rev-1",
			projectId: "proj-1",
		});
		mockUpdateScanFinding
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const handler = await loadHandler(
			"../apply-review",
			"applyReviewProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				reviewId: "rev-1",
				decisions: [
					{ findingId: "f1", status: "DISMISSED" },
					{ findingId: "gone", status: "DISMISSED" },
				],
			},
			context: ctx,
		});
		expect(result).toEqual({ applied: 1 });
	});

	it("throws NOT_FOUND when the review does not belong to the project", async () => {
		mockGetScanFindingReview.mockResolvedValue(null);
		const handler = await loadHandler(
			"../apply-review",
			"applyReviewProcedure",
		);
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					reviewId: "rev-other",
					decisions: [{ findingId: "f1", status: "DISMISSED" }],
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockUpdateScanFinding).not.toHaveBeenCalled();
	});
});

// =============================================================================
// trigger-scan purge (G10)
// =============================================================================
describe("triggerScanProcedure — purge re-scan", () => {
	beforeEach(() => {
		mockGetProjectScanConfig.mockResolvedValue({
			securityEnabled: true,
			accessibilityEnabled: true,
			semgrepEnabled: false,
			gitHistoryEnabled: false,
		});
		// start-scan helper reaches createProjectScan + updateProjectScan through
		// @repo/database; default them so the dispatch completes.
		mockCreateProjectScan.mockResolvedValue({ id: "scan-1" });
		mockUpdateProjectScan.mockResolvedValue(undefined);
		mockWorkflowStart.mockResolvedValue({ workflowId: "wf-1" });
	});

	it("deletes OPEN findings, records FINDINGS_PURGED, and threads purge:true into a FULL scan", async () => {
		mockDeleteOpenProjectScanFindings.mockResolvedValue(4);

		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				purgeUnresolved: true,
			},
			context: ctx,
		});

		// The trigger now returns a bulk {started, skipped} shape; the single
		// project-scope scan lands as the sole `started` entry.
		expect(result).toMatchObject({
			started: [expect.objectContaining({ scanId: "scan-1" })],
		});
		// Delete is tenant-scoped and OPEN-only (the query enforces OPEN).
		expect(mockDeleteOpenProjectScanFindings).toHaveBeenCalledWith(
			"proj-1",
			{
				userId: "user-1",
				organizationId: null,
			},
		);
		// FINDINGS_PURGED page-history entry with the deleted count.
		const purgeActivity = mockRecordScanActivity.mock.calls.find(
			(c) => (c[0] as { type: string }).type === "FINDINGS_PURGED",
		);
		expect(purgeActivity).toBeTruthy();
		expect((purgeActivity?.[0] as { summary: string }).summary).toContain(
			"4",
		);
		// purge:true threaded into the workflow args, in FULL mode.
		const startArgs = mockWorkflowStart.mock.calls[0];
		expect(startArgs[0]).toBe("securityAccessibilityScanWorkflow");
		const wfInput = (
			startArgs[1] as { args: Array<Record<string, unknown>> }
		).args[0];
		expect(wfInput).toMatchObject({ mode: "FULL", purge: true });
	});

	it("does NOT delete or thread purge on a normal (non-purge) scan", async () => {
		mockCreateProjectScan.mockResolvedValue({ id: "scan-2" });

		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);
		await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(mockDeleteOpenProjectScanFindings).not.toHaveBeenCalled();
		const wfInput = (
			mockWorkflowStart.mock.calls[0][1] as {
				args: Array<Record<string, unknown>>;
			}
		).args[0];
		expect(wfInput.purge).toBeUndefined();
	});
});

// =============================================================================
// list-findings — scanner + sort passthrough (G1 / G12)
// =============================================================================
describe("listFindingsProcedure — scanner + sort passthrough", () => {
	it("forwards scanner and sort to listScanFindings (scanId pinned)", async () => {
		mockListScanFindings.mockResolvedValue([{ id: "f1" }]);
		const handler = await loadHandler(
			"../list-findings",
			"listFindingsProcedure",
		);

		const result = await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				scanId: "scan-1",
				scanner: "SEMGREP",
				sort: "confidence",
			},
			context: ctx,
		});

		expect(result).toEqual({ findings: [{ id: "f1" }] });
		// No latest-scan lookup needed when scanId is explicit.
		expect(mockGetLatestProjectScan).not.toHaveBeenCalled();
		expect(mockListScanFindings).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({
				scanId: "scan-1",
				scanner: "SEMGREP",
				sort: "confidence",
			}),
		);
	});

	it("defaults scanId to the latest COMPLETED scan, still forwarding the filters", async () => {
		mockGetLatestProjectScan.mockResolvedValue({ id: "latest-scan" });
		mockListScanFindings.mockResolvedValue([]);
		const handler = await loadHandler(
			"../list-findings",
			"listFindingsProcedure",
		);

		await handler({
			input: {
				projectId: "proj-1",
				scanner: "AI_ACCESSIBILITY",
				sort: "severity",
			},
			context: ctx,
		});

		expect(mockGetLatestProjectScan).toHaveBeenCalledWith("proj-1", {
			storyId: null,
			status: "COMPLETED",
		});
		expect(mockListScanFindings).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({
				scanId: "latest-scan",
				scanner: "AI_ACCESSIBILITY",
				sort: "severity",
			}),
		);
	});
});

// =============================================================================
// start-review (G7) — dedupe + dispatch
// =============================================================================
describe("startReviewProcedure", () => {
	it("creates a review, starts the workflow on fabric-worker, and stamps the workflowId", async () => {
		mockHasActiveScanReview.mockResolvedValue(false);
		mockCreateScanFindingReview.mockResolvedValue({
			id: "rev-1",
			status: "PENDING",
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "scan-review-rev-1",
		});

		const handler = await loadHandler(
			"../start-review",
			"startReviewProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(result).toEqual({ reviewId: "rev-1", status: "PENDING" });
		const [wfName, opts] = mockWorkflowStart.mock.calls[0] as [
			string,
			{ taskQueue: string; args: Array<Record<string, unknown>> },
		];
		expect(wfName).toBe("scanFindingReviewWorkflow");
		expect(opts.taskQueue).toBe("fabric-worker");
		expect(opts.args[0]).toMatchObject({
			reviewId: "rev-1",
			projectId: "proj-1",
		});
		expect(mockUpdateScanFindingReview).toHaveBeenCalledWith("rev-1", {
			workflowId: "scan-review-rev-1",
		});
		// Records REVIEW_STARTED (the trigger + who) in the page history.
		const startedActivity = mockRecordScanActivity.mock.calls.find(
			(c) => (c[0] as { type: string }).type === "REVIEW_STARTED",
		);
		expect(startedActivity).toBeTruthy();
		expect(startedActivity?.[0]).toMatchObject({
			type: "REVIEW_STARTED",
			projectId: "proj-1",
			userId: "user-1",
		});
	});

	it("dedupes against an in-flight review (CONFLICT, no new row, no dispatch)", async () => {
		mockHasActiveScanReview.mockResolvedValue(true);
		const handler = await loadHandler(
			"../start-review",
			"startReviewProcedure",
		);
		await expect(
			handler({
				input: { projectId: "proj-1" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockCreateScanFindingReview).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});
});

// =============================================================================
// cancel-review (G7) — terminate the running review + record REVIEW_CANCELLED
// =============================================================================
describe("cancelReviewProcedure", () => {
	it("terminates the workflow, marks the review FAILED, records REVIEW_CANCELLED, and returns cancelled:true", async () => {
		mockGetScanFindingReview.mockResolvedValue({
			id: "rev-1",
			projectId: "proj-1",
			status: "RUNNING",
			workflowId: "scan-review-rev-1",
		});
		mockUpdateScanFindingReview.mockResolvedValue(undefined);

		const handler = await loadHandler(
			"../cancel-review",
			"cancelReviewProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				reviewId: "rev-1",
			},
			context: ctx,
		});

		expect(result).toEqual({ cancelled: true });
		// Best-effort terminate of the in-flight review workflow.
		expect(mockGetHandle).toHaveBeenCalledWith("scan-review-rev-1");
		expect(mockTerminate).toHaveBeenCalledWith("Cancelled by user");
		// Procedure owns the final state: FAILED + Cancelled + completedAt set.
		expect(mockUpdateScanFindingReview).toHaveBeenCalledWith("rev-1", {
			status: "FAILED",
			error: "Cancelled by user",
			completedAt: expect.any(Date),
		});
		// REVIEW_CANCELLED page-history entry (0 findings updated).
		const cancelActivity = mockRecordScanActivity.mock.calls.find(
			(c) => (c[0] as { type: string }).type === "REVIEW_CANCELLED",
		);
		expect(cancelActivity).toBeTruthy();
		expect(cancelActivity?.[0]).toMatchObject({
			type: "REVIEW_CANCELLED",
			projectId: "proj-1",
			userId: "user-1",
		});
	});

	it("returns cancelled:false for an already-terminal review (no terminate, no state write)", async () => {
		mockGetScanFindingReview.mockResolvedValue({
			id: "rev-1",
			projectId: "proj-1",
			status: "COMPLETED",
			workflowId: "scan-review-rev-1",
		});

		const handler = await loadHandler(
			"../cancel-review",
			"cancelReviewProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1", reviewId: "rev-1" },
			context: ctx,
		});

		expect(result).toEqual({ cancelled: false });
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
		expect(mockUpdateScanFindingReview).not.toHaveBeenCalled();
		expect(mockRecordScanActivity).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the review does not belong to the project (no terminate)", async () => {
		mockGetScanFindingReview.mockResolvedValue(null);

		const handler = await loadHandler(
			"../cancel-review",
			"cancelReviewProcedure",
		);
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					reviewId: "rev-other",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
		expect(mockUpdateScanFindingReview).not.toHaveBeenCalled();
	});
});

// =============================================================================
// cancel-scan — terminate the running scan + record SCAN_FAILED
// =============================================================================
describe("cancelScanProcedure", () => {
	it("terminates by the DERIVED workflowId, flips via failScanIfActive, records SCAN_FAILED, and returns cancelled:true", async () => {
		mockGetProjectScan.mockResolvedValue({
			id: "scan-1",
			projectId: "proj-1",
			status: "RUNNING",
			// workflowId not yet written back to the row — cancel must derive it
			// (security-scan-<scanId>) so the in-flight workflow is still terminated.
			workflowId: null,
		});
		// Compare-and-set won: the row was still active, so 1 row flipped.
		mockFailScanIfActive.mockResolvedValue(1);

		const handler = await loadHandler(
			"../cancel-scan",
			"cancelScanProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				scanId: "scan-1",
			},
			context: ctx,
		});

		expect(result).toEqual({ cancelled: true });
		// Best-effort terminate by the deterministic id derived from the scanId,
		// even though the row's workflowId is still null.
		expect(mockGetHandle).toHaveBeenCalledWith("security-scan-scan-1");
		expect(mockTerminate).toHaveBeenCalledWith("Cancelled by user");
		// Compare-and-set flip (scanId, projectId, reason) — NOT a blanket update.
		expect(mockFailScanIfActive).toHaveBeenCalledWith(
			"scan-1",
			"proj-1",
			"Cancelled by user",
		);
		expect(mockUpdateProjectScan).not.toHaveBeenCalled();
		// SCAN_FAILED page-history entry — a reused enum value (no new taxonomy).
		const cancelActivity = mockRecordScanActivity.mock.calls.find(
			(c) => (c[0] as { type: string }).type === "SCAN_FAILED",
		);
		expect(cancelActivity).toBeTruthy();
		expect(cancelActivity?.[0]).toMatchObject({
			type: "SCAN_FAILED",
			projectId: "proj-1",
			userId: "user-1",
			scanId: "scan-1",
			summary: "Scan cancelled by user",
		});
	});

	it("returns cancelled:false and records nothing when the compare-and-set loses the race (failScanIfActive → 0)", async () => {
		mockGetProjectScan.mockResolvedValue({
			id: "scan-1",
			projectId: "proj-1",
			status: "RUNNING",
			workflowId: "security-scan-scan-1",
		});
		// The workflow's persist won the race and wrote COMPLETED between our
		// status read and the flip — 0 rows updated ⇒ treat the cancel as a no-op.
		mockFailScanIfActive.mockResolvedValue(0);

		const handler = await loadHandler(
			"../cancel-scan",
			"cancelScanProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1", scanId: "scan-1" },
			context: ctx,
		});

		expect(result).toEqual({ cancelled: false });
		// It attempted the compare-and-set flip...
		expect(mockFailScanIfActive).toHaveBeenCalledWith(
			"scan-1",
			"proj-1",
			"Cancelled by user",
		);
		// ...but records NO SCAN_FAILED activity — the scan wasn't actually cancelled.
		expect(mockRecordScanActivity).not.toHaveBeenCalled();
	});

	it("returns cancelled:false for an already-terminal scan (no terminate, no flip)", async () => {
		mockGetProjectScan.mockResolvedValue({
			id: "scan-1",
			projectId: "proj-1",
			status: "COMPLETED",
			workflowId: "security-scan-scan-1",
		});

		const handler = await loadHandler(
			"../cancel-scan",
			"cancelScanProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1", scanId: "scan-1" },
			context: ctx,
		});

		expect(result).toEqual({ cancelled: false });
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
		expect(mockFailScanIfActive).not.toHaveBeenCalled();
		expect(mockRecordScanActivity).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN and writes nothing when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		const handler = await loadHandler(
			"../cancel-scan",
			"cancelScanProcedure",
		);
		await expect(
			handler({
				input: { projectId: "proj-x", scanId: "scan-1" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockGetProjectScan).not.toHaveBeenCalled();
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
		expect(mockFailScanIfActive).not.toHaveBeenCalled();
	});
});

// =============================================================================
// trigger-scan — per-branch scanning (branch resolution + recording)
// =============================================================================
describe("triggerScanProcedure — scan branch", () => {
	beforeEach(() => {
		mockCreateProjectScan.mockResolvedValue({ id: "scan-b" });
		mockUpdateProjectScan.mockResolvedValue(undefined);
		mockWorkflowStart.mockResolvedValue({ workflowId: "wf-b" });
	});

	it("records the configured scanBranch (wins over the repo default) + names it in SCAN_STARTED", async () => {
		mockGetProjectScanConfig.mockResolvedValue({
			securityEnabled: true,
			accessibilityEnabled: false,
			semgrepEnabled: false,
			gitHistoryEnabled: false,
			scanBranch: "develop",
		});
		mockGetProjectReposForCodeSearch.mockResolvedValue([
			{ branch: "main" },
		]);

		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);
		await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(mockCreateProjectScan).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "develop" }),
		);
		const started = mockRecordScanActivity.mock.calls.find(
			(c) => (c[0] as { type: string }).type === "SCAN_STARTED",
		);
		expect((started?.[0] as { summary: string }).summary).toContain(
			'branch "develop"',
		);
	});

	it("falls back to the repository default branch when scanBranch is blank/whitespace", async () => {
		mockGetProjectScanConfig.mockResolvedValue({
			securityEnabled: true,
			accessibilityEnabled: false,
			semgrepEnabled: false,
			gitHistoryEnabled: false,
			scanBranch: "   ",
		});
		mockGetProjectReposForCodeSearch.mockResolvedValue([
			{ branch: "main" },
		]);

		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);
		await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(mockCreateProjectScan).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "main" }),
		);
	});

	it("records a null branch when nothing is set and no repo is connected", async () => {
		mockGetProjectScanConfig.mockResolvedValue({
			securityEnabled: true,
			accessibilityEnabled: false,
			semgrepEnabled: false,
			gitHistoryEnabled: false,
			scanBranch: null,
		});
		mockGetProjectReposForCodeSearch.mockResolvedValue([]);

		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);
		await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(mockCreateProjectScan).toHaveBeenCalledWith(
			expect.objectContaining({ branch: null }),
		);
	});
});

// =============================================================================
// list-findings — branch-scoped default latest scan
// =============================================================================
describe("listFindingsProcedure — branch scoping", () => {
	it("scopes the default latest COMPLETED scan to the requested branch", async () => {
		mockGetLatestProjectScan.mockResolvedValue({ id: "branch-scan" });
		mockListScanFindings.mockResolvedValue([]);
		const handler = await loadHandler(
			"../list-findings",
			"listFindingsProcedure",
		);
		await handler({
			input: { projectId: "proj-1", branch: "develop" },
			context: ctx,
		});
		expect(mockGetLatestProjectScan).toHaveBeenCalledWith("proj-1", {
			storyId: null,
			status: "COMPLETED",
			branch: "develop",
		});
	});
});

// =============================================================================
// trigger-scan — bulk / branch-targeted / force-full / no-op (FR1–FR4)
// =============================================================================
describe("triggerScanProcedure — bulk / branch-targeted / force-full / no-op", () => {
	beforeEach(() => {
		mockGetProjectScanConfig.mockResolvedValue({
			securityEnabled: true,
			accessibilityEnabled: true,
			semgrepEnabled: false,
			gitHistoryEnabled: false,
			scanBranch: null,
		});
		// createProjectScan + workflow dispatch defaults so start-scan completes.
		mockCreateProjectScan.mockResolvedValue({ id: "scan-x" });
		mockUpdateProjectScan.mockResolvedValue(undefined);
		mockWorkflowStart.mockResolvedValue({ workflowId: "wf-x" });
	});

	const wfInputs = () =>
		mockWorkflowStart.mock.calls.map(
			(c) => (c[1] as { args: Array<Record<string, unknown>> }).args[0],
		);

	it("fans out a bulk `branches` set into one scan per branch, each carrying its own branch", async () => {
		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);

		const result = (await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				branches: ["alpha", "beta"],
			},
			context: ctx,
		})) as { started: Array<{ branch: string }>; skipped: unknown[] };

		// One createProjectScan (with THAT branch) per target, in order.
		expect(mockCreateProjectScan).toHaveBeenCalledTimes(2);
		expect(mockCreateProjectScan).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ branch: "alpha" }),
		);
		expect(mockCreateProjectScan).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ branch: "beta" }),
		);
		// Each workflow input carries its resolved branch (scan-row branch == input).
		expect(wfInputs().map((w) => w.branch)).toEqual(["alpha", "beta"]);
		expect(result.started.map((s) => s.branch)).toEqual(["alpha", "beta"]);
		expect(result.skipped).toEqual([]);
	});

	it("lands an already-scanning branch in `skipped` and still starts the rest", async () => {
		// alpha is mid-scan; beta is free.
		mockHasActiveScan.mockImplementation(
			async (_projectId: string, opts: { branch?: string }) =>
				opts.branch === "alpha",
		);
		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);

		const result = (await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				branches: ["alpha", "beta"],
			},
			context: ctx,
		})) as {
			started: Array<{ branch: string }>;
			skipped: Array<{ branch: string; reason: string }>;
		};

		expect(result.skipped).toEqual([
			{ branch: "alpha", reason: "already-scanning" },
		]);
		expect(result.started.map((s) => s.branch)).toEqual(["beta"]);
		// Only beta actually created a scan.
		expect(mockCreateProjectScan).toHaveBeenCalledTimes(1);
		expect(mockCreateProjectScan).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "beta" }),
		);
	});

	it("threads forceFull:true through start-scan into the workflow input", async () => {
		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);

		await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				branch: "main",
				forceFull: true,
			},
			context: ctx,
		});

		expect(wfInputs()[0]).toMatchObject({
			branch: "main",
			forceFull: true,
		});
	});

	it("passes a single `branch` override to createProjectScan and the workflow input", async () => {
		const handler = await loadHandler(
			"../trigger-scan",
			"triggerScanProcedure",
		);

		const result = (await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				branch: "release",
			},
			context: ctx,
		})) as { started: Array<{ branch: string }> };

		// The scan-row branch (createProjectScan) equals the workflow-input branch.
		expect(mockCreateProjectScan).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "release" }),
		);
		expect(wfInputs()[0].branch).toBe("release");
		expect(result.started).toEqual([
			{ branch: "release", scanId: "scan-x", workflowId: "wf-x" },
		]);
	});
});
