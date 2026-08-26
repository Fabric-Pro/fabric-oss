/**
 * Drift-loop heartbeat regression guard (#1741).
 *
 * Task 4 relocated the content-drift work (detectContentDrift →
 * upsertPendingChange / recordPmSyncLog / notification fan-out) INTO the fetch
 * activity, running sequentially per passthrough item in the loops that build
 * the poll verdicts — AFTER all MCP calls have returned. Those loops emit no
 * heartbeat on their own, while the fetch proxy sets heartbeatTimeout: "60s".
 * On a large first-post-freeze backlog the drift loop could exceed 60s since the
 * last heartbeat, fail the activity, and re-freeze the watermark (the #1741
 * symptom). fetchAdoWorkItemStates now calls a throttled safeHeartbeat() at the
 * top of BOTH drift loops (per-ID + ADO batch); this test proves it fires and
 * that safeHeartbeat() never throws when there is no activity context.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/activities/pm-integration/__tests__/fetch-ado-states-heartbeat.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @temporalio/activity so Context.current() returns a spy heartbeat we can
// assert on. `activityState.throwOnCurrent` lets one case simulate "no activity
// context" (the real behaviour in unit tests) so we can prove safeHeartbeat's
// try/catch swallows it.
const { heartbeatSpy, activityState } = vi.hoisted(() => ({
	heartbeatSpy: vi.fn(),
	activityState: { throwOnCurrent: false },
}));

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => {
			if (activityState.throwOnCurrent) {
				throw new Error("Activity context not initialized");
			}
			return { heartbeat: heartbeatSpy };
		},
	},
}));

const mockProjectFindUnique = vi.fn();
const mockGetLinkedExternalIds = vi.fn();
const mockFindFabricItemByExternalId = vi.fn();
const mockUpsertPendingChange = vi.fn();
const mockCreatePmSyncConflictNotifications = vi.fn();
const mockUserStoryFindUnique = vi.fn();
const mockFetchPMItemsByIds = vi.fn();
const mockGetWorkItemsByIdsFromPM = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		project: {
			findMany: vi.fn(),
			update: vi.fn(),
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
		},
		userStory: {
			findUnique: (...args: unknown[]) =>
				mockUserStoryFindUnique(...args),
			update: vi.fn(),
		},
	},
	findFabricItemByExternalId: (...args: unknown[]) =>
		mockFindFabricItemByExternalId(...args),
	getLinkedExternalIds: (...args: unknown[]) =>
		mockGetLinkedExternalIds(...args),
	upsertPendingChange: (...args: unknown[]) =>
		mockUpsertPendingChange(...args),
	createPmSyncConflictNotifications: (...args: unknown[]) =>
		mockCreatePmSyncConflictNotifications(...args),
	applyTerminalClose: vi.fn(),
	applyTerminalUnhide: vi.fn(),
	recordAudit: vi.fn(),
	findFabricItemsByExternalId: vi.fn(),
	incrementMissingStreak: vi.fn(),
	resetMissingStreaks: vi.fn(),
	pendingFlagMissingExists: vi.fn(),
	autoDismissReappearedFlagMissing: vi.fn(),
	clearPendingContentDrift: vi.fn(),
}));

const mockRecordPmSyncLog = vi.fn();
vi.mock("../../pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: (...args: unknown[]) => mockRecordPmSyncLog(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

function _extractItemState(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): string | undefined {
	const ado = fields?.["System.State"];
	if (typeof ado === "string" && ado.length > 0) {
		return ado;
	}
	const generic = rec.state ?? rec.status;
	if (typeof generic === "string" && generic.length > 0) {
		return generic;
	}
	return undefined;
}

function _extractChangedDate(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): Date | null {
	const value =
		(fields?.["System.ChangedDate"] as unknown) ??
		rec.updated_at ??
		rec.updatedAt ??
		rec.changed_date;
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

vi.mock("../story-sync", () => ({
	fetchPMItemsByIds: (...args: unknown[]) => mockFetchPMItemsByIds(...args),
	getWorkItemsByIdsFromPM: (...args: unknown[]) =>
		mockGetWorkItemsByIdsFromPM(...args),
	extractItemState: _extractItemState,
	extractChangedDate: _extractChangedDate,
}));

import { fetchAdoWorkItemStates } from "../pm-state-poll";

// 60 items crosses the every-20 throttle three times (indices 0, 20, 40), so
// the drift loop must emit at least 3 heartbeats regardless of per-item latency.
const ITEM_COUNT = 60;
const EXPECTED_MIN_HEARTBEATS = 3;

function makeSummaries(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: String(i + 1),
		title: `Card ${i + 1}`,
		description: `desc ${i + 1}`,
		raw: {
			fields: {
				// "Active" → non-terminal → passthrough → drift pass runs.
				"System.State": "Active",
				"System.ChangedDate": "2030-01-01T00:00:00Z",
			},
		},
	}));
}

describe("fetchAdoWorkItemStates — drift-loop heartbeat (#1741)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		activityState.throwOnCurrent = false;
		mockRecordPmSyncLog.mockResolvedValue(undefined);
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org_1",
			userId: "user_1",
			pmTerminalStatuses: ["Closed", "Done", "Removed"],
			pmAutoCloseEnabled: true,
		});
		// Non-null baseline hash so passthrough items run the drift DB work.
		mockGetLinkedExternalIds.mockResolvedValue(
			makeSummaries(ITEM_COUNT).map((s) => ({
				entityType: "STORY",
				entityId: `story_${s.id}`,
				externalId: s.id,
				draftingStage: "DRAFT",
				pmAutoHidden: false,
				lastSyncedPmHash: "baseline",
				lastPmSyncStatus: null,
			})),
		);
		mockUserStoryFindUnique.mockResolvedValue({
			title: "Story",
			assigneeId: null,
		});
		mockUpsertPendingChange.mockResolvedValue({
			action: "skipped",
			pendingId: null,
		});
	});

	it("per-ID path: heartbeats the drift loop at least items/throttle times", async () => {
		mockFetchPMItemsByIds.mockResolvedValue({
			items: makeSummaries(ITEM_COUNT),
			failedIds: [],
			notFoundIds: [],
		});

		await fetchAdoWorkItemStates({
			projectId: "proj_1",
			mcpConfigId: "cfg",
			containerId: "c",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user_1",
			pmTool: "fizzy",
			sourceKind: "mcp",
		});

		expect(heartbeatSpy).toHaveBeenCalled();
		expect(heartbeatSpy.mock.calls.length).toBeGreaterThanOrEqual(
			EXPECTED_MIN_HEARTBEATS,
		);
	});

	it("ADO-batch path: heartbeats the drift loop at least items/throttle times", async () => {
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: makeSummaries(ITEM_COUNT),
			wrongBoardIds: [],
			notFoundIds: [],
		});

		await fetchAdoWorkItemStates({
			projectId: "proj_1",
			mcpConfigId: "cfg",
			containerId: "c",
			containerName: "Proj",
			lastAdoStatePollAt: null,
			userId: "user_1",
			pmTool: "azure-devops",
			sourceKind: "mcp",
		});

		expect(heartbeatSpy).toHaveBeenCalled();
		expect(heartbeatSpy.mock.calls.length).toBeGreaterThanOrEqual(
			EXPECTED_MIN_HEARTBEATS,
		);
	});

	it("safeHeartbeat swallows a thrown Context.current() (no activity context)", async () => {
		// Simulate a unit-test / no-activity environment where Context.current()
		// throws — the fetch must still resolve, proving safeHeartbeat's try/catch.
		activityState.throwOnCurrent = true;
		mockFetchPMItemsByIds.mockResolvedValue({
			items: makeSummaries(ITEM_COUNT),
			failedIds: [],
			notFoundIds: [],
		});

		await expect(
			fetchAdoWorkItemStates({
				projectId: "proj_1",
				mcpConfigId: "cfg",
				containerId: "c",
				containerName: null,
				lastAdoStatePollAt: null,
				userId: "user_1",
				pmTool: "fizzy",
				sourceKind: "mcp",
			}),
		).resolves.toBeDefined();

		// Context.current() threw every time, so no heartbeat was actually recorded.
		expect(heartbeatSpy).not.toHaveBeenCalled();
	});
});
