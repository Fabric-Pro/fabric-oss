/**
 * Workflow Logic Tests for ADO State Poll
 *
 * Tests the workflow orchestration logic by validating the activity
 * composition and data flow. Since the project's Temporal workflow tests
 * primarily validate through the existing replay-validation.test.ts (which
 * covers all workflows once fixtures are populated), these tests focus on
 * the activity-level logic that the workflows orchestrate.
 *
 * The parent workflow (adoStatePollWorkflow) fans out child workflows in
 * batches of 10. The child workflow (adoStatePollProjectWorkflow) calls:
 *   1. fetchAdoWorkItemStates
 *   2. reconcileAdoStates
 *   3. updateProjectPollTimestamp
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/pm-state-poll-workflow.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all external dependencies
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		project: {
			findMany: vi.fn(),
			update: vi.fn(),
			// reconcileAdoStates resolves the project tenant once for any
			// pull-drift PmSyncLog rows it emits.
			findUnique: vi.fn().mockResolvedValue({
				organizationId: "org-1",
				userId: "user-1",
			}),
		},
		// Per-entity title lookups for the pull-drift log snapshot.
		epic: { findUnique: vi.fn().mockResolvedValue({ title: "Epic" }) },
		feature: {
			findUnique: vi.fn().mockResolvedValue({ title: "Feature" }),
		},
		userStory: {
			findUnique: vi.fn().mockResolvedValue({ title: "Story" }),
			update: vi.fn().mockResolvedValue({}),
		},
	},
	findFabricItemByExternalId: vi.fn(),
	getLinkedExternalIds: vi.fn(),
	upsertPendingChange: vi.fn(),
	createPmSyncConflictNotifications: vi.fn(),
	applyTerminalClose: vi.fn().mockResolvedValue(undefined),
	recordAudit: vi.fn(),
	// #1741: reconcile's terminal branch clears pending CONTENT_DRIFT.
	clearPendingContentDrift: vi.fn().mockResolvedValue(0),
}));

// Pull-drift log write — verified elsewhere; here it just needs to not throw.
vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(),
}));

const mockResolvePmSource = vi.fn();
vi.mock("../src/activities/pm-source", () => ({
	resolvePmSource: (...args: unknown[]) => mockResolvePmSource(...args),
	resolvePmServerKey: vi.fn().mockResolvedValue("azure-devops"),
	PMSourceNotFound: class PMSourceNotFound extends Error {
		constructor(public reason: string) {
			super(reason);
			this.name = "PMSourceNotFound";
		}
	},
}));

import { db } from "@repo/database";
import {
	getAdoActiveProjects,
	reconcileAdoStates,
	updateProjectPollTimestamp,
} from "../src/activities/pm-integration/pm-state-poll";
import {
	hashTerminalStatuses,
	resolveTerminalSet,
} from "../src/activities/pm-integration/pm-terminal-config";

// These tests' project mock returns no pmTerminalStatuses → reconcile uses the
// built-in fallback set; pass the matching hash so the settings gate opens.
const FALLBACK_HASH = hashTerminalStatuses(resolveTerminalSet(null));

describe("getAdoActiveProjects — filters correctly", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolvePmSource.mockResolvedValue({ kind: "mcp" });
	});

	it("returns projects with adoStatePollActive and valid PM config", async () => {
		vi.mocked(db.project.findMany).mockResolvedValue([
			{
				id: "proj-1",
				projectManagementMcpServerId: "srv-1",
				projectManagementMcpConfigId: "mcp-1",
				projectManagementContainerId: "cont-1",
				projectManagementContainerName: "MyProject",
				lastAdoStatePollAt: new Date("2026-05-01"),
				userId: "user-1",
				organizationId: "org-1",
			},
			{
				id: "proj-2",
				projectManagementMcpServerId: "srv-2",
				projectManagementMcpConfigId: "mcp-2",
				projectManagementContainerId: null, // missing container
				projectManagementContainerName: null,
				lastAdoStatePollAt: null,
				userId: "user-2",
				organizationId: null,
			},
		] as any);

		const result = await getAdoActiveProjects();

		// Only proj-1 should pass (proj-2 has no containerId)
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("proj-1");
		expect(result[0].mcpConfigId).toBe("mcp-1");
		expect(result[0].containerId).toBe("cont-1");
	});

	it("returns empty array when no projects match", async () => {
		vi.mocked(db.project.findMany).mockResolvedValue([]);

		const result = await getAdoActiveProjects();
		expect(result).toEqual([]);
	});
});

describe("getAdoActiveProjects — multi-tool gate (Phase B)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("includes a GitLab-REST project (mcpConfigId null) that resolves to rest-gitlab", async () => {
		vi.mocked(db.project.findMany).mockResolvedValue([
			{
				id: "gl-1",
				projectManagementMcpServerId: "srv-gl",
				projectManagementMcpConfigId: null,
				projectManagementContainerId: "100",
				projectManagementContainerName: "group/repo",
				lastAdoStatePollAt: null,
				userId: "user-1",
				organizationId: null,
			},
		] as never);
		mockResolvePmSource.mockResolvedValue({
			kind: "rest-gitlab",
			token: "secret",
			baseUrl: "x",
			projectId: "100",
		});

		const result = await getAdoActiveProjects();

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			id: "gl-1",
			mcpConfigId: null,
			mcpServerId: "srv-gl",
			sourceKind: "rest-gitlab",
			containerId: "100",
		});
		// SECURITY: the resolved token must NOT be returned.
		expect(JSON.stringify(result[0])).not.toContain("secret");
		// Tenant isolation: classify resolves AS THE PROJECT OWNER.
		expect(mockResolvePmSource).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: null,
				containerId: "100",
			}),
		);
	});

	it("skips a project whose source does not resolve, WITHOUT aborting the batch", async () => {
		const { PMSourceNotFound } = await import(
			"../src/activities/pm-source"
		);
		vi.mocked(db.project.findMany).mockResolvedValue([
			{
				id: "bad",
				projectManagementMcpServerId: "srv-bad",
				projectManagementMcpConfigId: "cfg-bad",
				projectManagementContainerId: "1",
				projectManagementContainerName: null,
				lastAdoStatePollAt: null,
				userId: "user-1",
				organizationId: null,
			},
			{
				id: "ok",
				projectManagementMcpServerId: "srv-ok",
				projectManagementMcpConfigId: "cfg-ok",
				projectManagementContainerId: "2",
				projectManagementContainerName: null,
				lastAdoStatePollAt: null,
				userId: "user-1",
				organizationId: null,
			},
		] as never);
		mockResolvePmSource
			.mockRejectedValueOnce(new PMSourceNotFound("no-integration"))
			.mockResolvedValueOnce({ kind: "mcp" });

		const result = await getAdoActiveProjects();

		// "bad" skipped, "ok" still returned — one bad project never kills the poll.
		expect(result.map((p) => p.id)).toEqual(["ok"]);
	});

	it("rethrows an unexpected resolve error (does not silently drop the project)", async () => {
		vi.mocked(db.project.findMany).mockResolvedValue([
			{
				id: "x",
				projectManagementMcpServerId: "srv",
				projectManagementMcpConfigId: "cfg",
				projectManagementContainerId: "1",
				projectManagementContainerName: null,
				lastAdoStatePollAt: null,
				userId: "user-1",
				organizationId: null,
			},
		] as never);
		mockResolvePmSource.mockRejectedValue(new Error("db down"));
		await expect(getAdoActiveProjects()).rejects.toThrow("db down");
	});
});

describe("updateProjectPollTimestamp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("updates lastAdoStatePollAt to current time", async () => {
		vi.mocked(db.project.update).mockResolvedValue({} as any);

		await updateProjectPollTimestamp("proj-1", true);

		expect(db.project.update).toHaveBeenCalledWith({
			where: { id: "proj-1" },
			data: { lastAdoStatePollAt: expect.any(Date) },
		});
	});
});

describe("workflow orchestration flow validation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reconcileAdoStates processes multiple items in a single call", async () => {
		const { findFabricItemByExternalId, upsertPendingChange } =
			await import("@repo/database");

		vi.mocked(findFabricItemByExternalId as any)
			.mockResolvedValueOnce({
				entityType: "STORY",
				entityId: "s-1",
				draftingStage: "DRAFTING",
			})
			.mockResolvedValueOnce({
				entityType: "EPIC",
				entityId: "e-1",
				draftingStage: "READY",
			})
			.mockResolvedValueOnce(null); // not found

		vi.mocked(upsertPendingChange as any).mockResolvedValue({
			action: "created",
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "101",
					state: "Closed",
					stateChangedDate: null,
				},
				{
					externalId: "102",
					state: "Done",
					stateChangedDate: null,
				},
				{
					externalId: "103",
					state: "Removed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: FALLBACK_HASH,
		});

		// 101 is a STORY (terminal Closed) → snapshots its pmTicketTerminal flag
		// via the STORY branch, no PENDING row (auto-close defaults OFF). 102 is
		// a legacy EPIC row → skipped defensively (the Epic/Feature folder tables
		// were dropped; `user_story` is the only work-item table). 103 not found
		// — skipped. So no pending changes at all, but every item was looked up.
		expect(result.pendingChangesCreated).toBe(0);
		expect(upsertPendingChange).not.toHaveBeenCalled();
		const { findFabricItemByExternalId: lookup } = await import(
			"@repo/database"
		);
		expect(lookup).toHaveBeenCalledTimes(3);
	});

	it("workflow handles mix of terminal and non-terminal states", async () => {
		const { findFabricItemByExternalId, upsertPendingChange } =
			await import("@repo/database");

		vi.mocked(findFabricItemByExternalId as any).mockResolvedValue({
			entityType: "STORY",
			entityId: "s-1",
			draftingStage: "DRAFTING",
		});
		vi.mocked(upsertPendingChange as any).mockResolvedValue({
			action: "created",
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "1",
					state: "Active",
					stateChangedDate: null,
				},
				{
					externalId: "2",
					state: "Closed",
					stateChangedDate: null,
				},
				{
					externalId: "3",
					state: "New",
					stateChangedDate: null,
				},
				{
					externalId: "4",
					state: "Done",
					stateChangedDate: null,
				},
				{
					externalId: "5",
					state: "Resolved",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: FALLBACK_HASH,
		});

		// Closed (2) and Done (4) are terminal → the STORY branch snapshots the
		// terminal flag (no PENDING row — auto-close defaults OFF, and the
		// propose-HIDE review flow was retired with the folder tables). The three
		// non-terminal items run the content-drift pass, which finds no baseline
		// (mock has no lastSyncedPmHash) and skips — no CONTENT_DRIFT row either.
		expect(result.pendingChangesCreated).toBe(0);
		// `findFabricItemByExternalId` is now looked up for ALL changed items
		// (terminal AND non-terminal) — the content-drift pass needs the Fabric
		// item + its baseline for non-terminal items (deliberate Chunk C change).
		expect(findFabricItemByExternalId).toHaveBeenCalledTimes(5);
	});
});

// ---------------------------------------------------------------------------
// #1741 Task 5 — fetch→reconcile→watermark wiring in
// `adoStatePollProjectWorkflow` (pm-state-poll-project-workflow.ts).
//
// That wiring only runs inside a real Temporal workflow context (proxied
// activities, `patched()`, `workflowInfo()`), so — same rationale as
// `__tests__/draft-project-cleanup/draft-project-cleanup-workflow.test.ts`
// — we pin the contract via a mirror of the fetch/reconcile/watermark slice
// driven by mocked activity callables rather than `TestWorkflowEnvironment`.
// This is a data-flow/gating contract (hash pass-through, settingsStable
// default, watermark gate), not activity-call-order novelty, and is
// checkable without a sandboxed worker. Replay determinism is covered
// separately by `.github/workflows/temporal-replay-validation.yml`.
// ---------------------------------------------------------------------------

/**
 * Mirrors `pm-state-poll-project-workflow.ts`'s reconcile-call + watermark
 * gate 1:1 (kept in test scope so a divergence is caught on code review):
 *
 *   const reconcileResult = await reconcileAdoStates({
 *     projectId, items: fetched.items, pmTool: input.pmTool,
 *     terminalStatusesHash: fetched.terminalStatusesHash,
 *   });
 *   const settingsStable = reconcileResult.settingsStable ?? true;
 *   await updateProjectPollTimestamp(projectId, fetched.complete && settingsStable);
 */
async function runWatermarkWiring(
	fetched: {
		items: unknown[];
		complete: boolean;
		terminalStatusesHash: string;
	},
	reconcileAdoStatesActivity: (input: {
		projectId: string;
		items: unknown[];
		pmTool?: string | null;
		terminalStatusesHash: string;
	}) => Promise<{
		pendingChangesCreated: number;
		storiesAutoHidden: number;
		settingsStable?: boolean;
	}>,
	updateProjectPollTimestampActivity: (
		projectId: string,
		advance: boolean,
	) => Promise<void>,
	projectId: string,
) {
	const reconcileResult = await reconcileAdoStatesActivity({
		projectId,
		items: fetched.items,
		terminalStatusesHash: fetched.terminalStatusesHash,
	});
	const settingsStable = reconcileResult.settingsStable ?? true;
	await updateProjectPollTimestampActivity(
		projectId,
		fetched.complete && settingsStable,
	);
	return reconcileResult;
}

describe("adoStatePollProjectWorkflow — fetch→reconcile→watermark wiring (mirrored body)", () => {
	it("passes fetch's terminalStatusesHash to reconcile", async () => {
		const mockReconcileAdoStates = vi.fn().mockResolvedValue({
			pendingChangesCreated: 0,
			storiesAutoHidden: 0,
			settingsStable: true,
		});
		const mockUpdateProjectPollTimestamp = vi
			.fn()
			.mockResolvedValue(undefined);

		await runWatermarkWiring(
			{ items: [], complete: true, terminalStatusesHash: "h" },
			mockReconcileAdoStates,
			mockUpdateProjectPollTimestamp,
			"proj_1",
		);

		expect(mockReconcileAdoStates).toHaveBeenCalledWith(
			expect.objectContaining({ terminalStatusesHash: "h" }),
		);
	});

	it("advances the watermark only when fetch was complete AND settings were stable", async () => {
		const mockReconcileAdoStates = vi.fn().mockResolvedValue({
			pendingChangesCreated: 0,
			storiesAutoHidden: 0,
			settingsStable: false,
		});
		const mockUpdateProjectPollTimestamp = vi
			.fn()
			.mockResolvedValue(undefined);

		await runWatermarkWiring(
			{ items: [], complete: true, terminalStatusesHash: "h" },
			mockReconcileAdoStates,
			mockUpdateProjectPollTimestamp,
			"proj_1",
		);

		expect(mockUpdateProjectPollTimestamp).toHaveBeenCalledWith(
			"proj_1",
			false,
		);
	});

	it("advances the watermark when complete AND settingsStable", async () => {
		const mockReconcileAdoStates = vi.fn().mockResolvedValue({
			pendingChangesCreated: 0,
			storiesAutoHidden: 0,
			settingsStable: true,
		});
		const mockUpdateProjectPollTimestamp = vi
			.fn()
			.mockResolvedValue(undefined);

		await runWatermarkWiring(
			{ items: [], complete: true, terminalStatusesHash: "h" },
			mockReconcileAdoStates,
			mockUpdateProjectPollTimestamp,
			"proj_1",
		);

		expect(mockUpdateProjectPollTimestamp).toHaveBeenCalledWith(
			"proj_1",
			true,
		);
	});

	it("holds the watermark when fetch was incomplete even if settings were stable", async () => {
		const mockReconcileAdoStates = vi.fn().mockResolvedValue({
			pendingChangesCreated: 0,
			storiesAutoHidden: 0,
			settingsStable: true,
		});
		const mockUpdateProjectPollTimestamp = vi
			.fn()
			.mockResolvedValue(undefined);

		await runWatermarkWiring(
			{ items: [], complete: false, terminalStatusesHash: "h" },
			mockReconcileAdoStates,
			mockUpdateProjectPollTimestamp,
			"proj_1",
		);

		expect(mockUpdateProjectPollTimestamp).toHaveBeenCalledWith(
			"proj_1",
			false,
		);
	});

	it("version skew: a legacy reconcile result with NO settingsStable still advances the watermark", async () => {
		// Models a deserialized pre-#1741 reconcile result — the key is OMITTED
		// entirely (not `settingsStable: undefined`), per the plan's version-skew
		// safety note.
		const mockReconcileAdoStates = vi.fn().mockResolvedValue({
			pendingChangesCreated: 0,
			storiesAutoHidden: 0,
		});
		const mockUpdateProjectPollTimestamp = vi
			.fn()
			.mockResolvedValue(undefined);

		await runWatermarkWiring(
			{ items: [], complete: true, terminalStatusesHash: "h" },
			mockReconcileAdoStates,
			mockUpdateProjectPollTimestamp,
			"proj_1",
		);

		expect(mockUpdateProjectPollTimestamp).toHaveBeenCalledWith(
			"proj_1",
			true,
		);
	});
});
