/**
 * Unit Tests for ADO State Poll Activities
 *
 * Tests reconcileAdoStates, extractWorkItemStates via fetchAdoWorkItemStates,
 * and the batching/query logic.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/pm-state-poll.test.ts
 */

import { logger } from "@repo/logs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/database
const mockFindFabricItemByExternalId = vi.fn();
const mockGetLinkedExternalIds = vi.fn();
const mockUpsertPendingChange = vi.fn();
const mockCreatePmSyncConflictNotifications = vi.fn();
// `reconcileAdoStates` resolves the project's tenant once and the drifted
// entity's title per newly-created drift (for the pull-drift PmSyncLog row).
const mockProjectFindUnique = vi.fn();
const mockEpicFindUnique = vi.fn();
const mockFeatureFindUnique = vi.fn();
const mockUserStoryFindUnique = vi.fn();
const mockUserStoryUpdate = vi.fn();
const mockApplyTerminalClose = vi.fn();
const mockApplyTerminalUnhide = vi.fn();
const mockRecordAudit = vi.fn();
// FLAG_MISSING producer (#1360) helpers used by reconcileMissingTickets.
const mockFindFabricItemsByExternalId = vi.fn();
const mockIncrementMissingStreak = vi.fn();
const mockResetMissingStreaks = vi.fn();
const mockPendingFlagMissingExists = vi.fn();
// #1741: reconcileStoryTerminalStatus clears a story's pending CONTENT_DRIFT on
// the terminal branch, so reconcileAdoStates transitively calls this.
const mockClearPendingContentDrift = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		project: {
			findMany: vi.fn(),
			update: vi.fn(),
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
		},
		epic: {
			findUnique: (...args: unknown[]) => mockEpicFindUnique(...args),
		},
		feature: {
			findUnique: (...args: unknown[]) => mockFeatureFindUnique(...args),
		},
		userStory: {
			findUnique: (...args: unknown[]) =>
				mockUserStoryFindUnique(...args),
			update: (...args: unknown[]) => mockUserStoryUpdate(...args),
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
	applyTerminalClose: (...args: unknown[]) => mockApplyTerminalClose(...args),
	applyTerminalUnhide: (...args: unknown[]) =>
		mockApplyTerminalUnhide(...args),
	recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
	findFabricItemsByExternalId: (...args: unknown[]) =>
		mockFindFabricItemsByExternalId(...args),
	incrementMissingStreak: (...args: unknown[]) =>
		mockIncrementMissingStreak(...args),
	resetMissingStreaks: (...args: unknown[]) =>
		mockResetMissingStreaks(...args),
	pendingFlagMissingExists: (...args: unknown[]) =>
		mockPendingFlagMissingExists(...args),
	clearPendingContentDrift: (...args: unknown[]) =>
		mockClearPendingContentDrift(...args),
}));

// The pull-drift log write is verified in `record-pm-sync-log-wiring.test.ts`;
// here we only need it to not throw so the existing reconcile assertions hold.
const mockRecordPmSyncLog = vi.fn();
vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: (...args: unknown[]) => mockRecordPmSyncLog(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock fetchPMItemsByIds and getWorkItemsByIdsFromPM — the helpers from story-sync
// that pm-state-poll uses. Also provide the real extractItemState/extractChangedDate
// so normalizePolledState (imported transitively via extract-pm-item-state) can use them.
const mockFetchPMItemsByIds = vi.fn();
const mockGetWorkItemsByIdsFromPM = vi.fn();

// Inlined copies (not importActual): real story-sync.ts pulls heavy unmocked deps. Keep in sync with story-sync.ts extractItemState/extractChangedDate.
function _extractItemState(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): string | undefined {
	const ado = fields?.["System.State"];
	if (typeof ado === "string" && ado.length > 0) {
		return ado;
	}
	const jiraStatus = fields?.status;
	if (jiraStatus && typeof jiraStatus === "object") {
		const name = (jiraStatus as Record<string, unknown>).name;
		if (typeof name === "string" && name.length > 0) {
			return name;
		}
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

vi.mock("../src/activities/pm-integration/story-sync", () => ({
	fetchPMItemsByIds: (...args: unknown[]) => mockFetchPMItemsByIds(...args),
	getWorkItemsByIdsFromPM: (...args: unknown[]) =>
		mockGetWorkItemsByIdsFromPM(...args),
	extractItemState: _extractItemState,
	extractChangedDate: _extractChangedDate,
}));

// The real (pure) attachment-block helpers (Fizzy #1745, R20) — used to build
// a polled GitLab description that carries a Fabric-owned block, exactly what
// `gitlab-rest-story-sync.ts` would have pushed.
import {
	appendAttachmentBlock,
	renderAttachmentBlock,
} from "../src/activities/pm-integration/gitlab-attachment-block";
import {
	fetchAdoWorkItemStates,
	reconcileAdoStates,
	reconcileMissingTickets,
	STREAK_THRESHOLD,
} from "../src/activities/pm-integration/pm-state-poll";
// `pm-sync-hash` is NOT mocked — the real (pure) hash runs in both the activity
// and these tests, so baselines computed here match what reconcile computes.
import { computePmHash } from "../src/activities/pm-integration/pm-sync-hash";
// The real (pure) terminal-config helpers — reconcile's settings-hash gate
// compares against exactly what these produce (#1741 DEC-6).
import {
	hashTerminalStatuses,
	resolveTerminalSet,
} from "../src/activities/pm-integration/pm-terminal-config";

/** The config hash reconcile expects for a given `pmTerminalStatuses` list. */
const hashOf = (s?: string[] | null): string =>
	hashTerminalStatuses(resolveTerminalSet(s ?? null));

describe("reconcileAdoStates", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordPmSyncLog.mockResolvedValue(undefined);
		mockClearPendingContentDrift.mockResolvedValue(0);
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
		});
		mockEpicFindUnique.mockResolvedValue({ title: "Drifted epic" });
		mockFeatureFindUnique.mockResolvedValue({ title: "Drifted feature" });
		mockUserStoryFindUnique.mockResolvedValue({ title: "Drifted story" });
		mockUserStoryUpdate.mockResolvedValue({});
		// applyTerminalClose/Unhide now return { applied } (#1360 Task 2); the
		// extracted STORY helper destructures it. Default to applied:true so the
		// auto-close/auto-unhide audit + counter paths run as before.
		mockApplyTerminalClose.mockResolvedValue({ applied: true });
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
	});

	it("STORY terminal + auto-close OFF: snapshots pmTicketTerminal, no PENDING row", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed", "Done", "Removed"],
			pmAutoCloseEnabled: false,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "DRAFT",
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Closed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done", "Removed"]),
		});

		expect(mockUserStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			data: { pmTicketTerminal: true, pmTicketTerminalStatus: "Closed" },
		});
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(mockApplyTerminalClose).not.toHaveBeenCalled();
		expect(result.storiesAutoHidden).toBe(0);
	});

	it("STORY terminal + auto-close ON: applyTerminalClose + audit, no PENDING row", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed"],
			pmAutoCloseEnabled: true,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "DRAFT",
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Closed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(["Closed"]),
		});

		expect(mockUserStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			data: { pmTicketTerminal: true, pmTicketTerminalStatus: "Closed" },
		});
		expect(mockApplyTerminalClose).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "STORY",
				entityId: "story-1",
				projectId: "proj-1",
			}),
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "story.auto_hidden" }),
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(result.storiesAutoHidden).toBe(1);
	});

	it("STORY already CLOSED + auto-close ON: no re-close", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed"],
			pmAutoCloseEnabled: true,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "CLOSED",
		});
		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Closed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(["Closed"]),
		});
		expect(mockApplyTerminalClose).not.toHaveBeenCalled();
		expect(result.storiesAutoHidden).toBe(0);
	});

	it("STORY non-terminal (re-opened): clears the snapshot flag", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed"],
			pmAutoCloseEnabled: true,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "DRAFT",
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Active",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(["Closed"]),
		});
		expect(mockUserStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			data: { pmTicketTerminal: false, pmTicketTerminalStatus: null },
		});
		expect(mockApplyTerminalClose).not.toHaveBeenCalled();
	});

	it("legacy EPIC row is skipped defensively (folder tables removed) — no HIDE, no snapshot", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed"],
			pmAutoCloseEnabled: true,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "EPIC",
			entityId: "epic-1",
			draftingStage: "PUBLISHED",
		});
		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "AB#1",
					state: "Closed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(["Closed"]),
		});
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(mockUserStoryUpdate).not.toHaveBeenCalled();
		expect(result.pendingChangesCreated).toBe(0);
	});

	it("falls back to the built-in terminal set when pmTerminalStatuses is empty", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: false,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "DRAFT",
		});
		await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Done",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf([]),
		});
		// "Done" is in the built-in fallback set → snapshot true
		expect(mockUserStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			data: { pmTicketTerminal: true, pmTicketTerminalStatus: "Done" },
		});
	});

	it("legacy FEATURE row is skipped defensively (folder tables removed)", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "FEATURE",
			entityId: "feat-1",
			draftingStage: "READY",
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "456",
					state: "Done",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(),
		});

		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(result.pendingChangesCreated).toBe(0);
	});

	it("non-terminal state with no baseline proposes no HIDE and no CONTENT_DRIFT", async () => {
		// Non-terminal items are passthrough; drift now runs in the fetch activity
		// (not here), so reconcile issues no upsert. It still looks up each item.
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "DRAFTING",
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Active",
					stateChangedDate: null,
				},
				{
					externalId: "456",
					state: "New",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(),
		});

		expect(result.pendingChangesCreated).toBe(0);
		expect(mockFindFabricItemByExternalId).toHaveBeenCalled();
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
	});

	it("skips already-CLOSED item", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "CLOSED",
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Closed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(),
		});

		expect(result.pendingChangesCreated).toBe(0);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
	});

	it("skips gracefully when item not found in Fabric", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue(null);

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "999",
					state: "Closed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(),
		});

		expect(result.pendingChangesCreated).toBe(0);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// UNHIDE detection (#1360): STORY auto-hidden + ticket reopened
	// -------------------------------------------------------------------------

	it("STORY CLOSED+pmAutoHidden + non-terminal + autoCloseEnabled: applyTerminalUnhide + audit, no content-drift, no propose", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed", "Done"],
			pmAutoCloseEnabled: true,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "CLOSED",
			pmAutoHidden: true,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Active",
					stateChangedDate: null,
					// Fetch would carry 'reopen'; a fresh 'reopen' does not diverge.
					classification: "reopen",
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});

		expect(mockApplyTerminalUnhide).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "story-1",
				projectId: "proj-1",
				userId: "user-9",
				organizationId: "org-1",
			}),
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "story.auto_unhidden" }),
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(result.pendingChangesCreated).toBe(0);
	});

	it("STORY CLOSED+pmAutoHidden + non-terminal + autoCloseEnabled:false: proposes UNHIDE + increments pendingChangesCreated", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed", "Done"],
			pmAutoCloseEnabled: false,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "CLOSED",
			pmAutoHidden: true,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		mockUpsertPendingChange.mockResolvedValue({ action: "created" });

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Active",
					stateChangedDate: null,
					classification: "reopen",
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});

		expect(mockUpsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				proposedAction: "UNHIDE",
				newState: "Active",
				entityId: "story-1",
			}),
		);
		expect(mockApplyTerminalUnhide).not.toHaveBeenCalled();
		expect(mockRecordAudit).not.toHaveBeenCalledWith(
			expect.objectContaining({ action: "story.auto_unhidden" }),
		);
		expect(result.pendingChangesCreated).toBe(1);
	});

	it("regression: STORY CLOSED+pmAutoHidden:false (manually closed) + non-terminal → no unhide, no propose (drift moved to fetch)", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: ["Closed", "Done"],
			pmAutoCloseEnabled: true,
		});
		// pmAutoHidden is false — manually closed, not auto-hidden by the poller
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "CLOSED",
			pmAutoHidden: false,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "123",
					state: "Active",
					stateChangedDate: null,
					// Fresh classification is 'passthrough' (manual-hide guard). Fetch
					// carried the same, so no divergence.
					classification: "passthrough",
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});

		expect(mockApplyTerminalUnhide).not.toHaveBeenCalled();
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		// Reconcile no longer runs drift — it stays 0 here.
		expect(result.pendingChangesCreated).toBe(0);
	});

	it("GitLab reopen: STORY CLOSED+pmAutoHidden + item.state='' + autoCloseEnabled:false → UNHIDE row newState==='open'", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: false,
		});
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-gl",
			draftingStage: "CLOSED",
			pmAutoHidden: true,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		mockUpsertPendingChange.mockResolvedValue({ action: "created" });

		const result = await reconcileAdoStates({
			projectId: "proj-1",
			items: [
				{
					externalId: "gl-42",
					// GitLab REST items have an empty string for state when reopened
					state: "",
					stateChangedDate: null,
					isClosed: false,
					classification: "reopen",
				},
			],
			terminalStatusesHash: hashOf([]),
		});

		expect(mockUpsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				proposedAction: "UNHIDE",
				newState: "open",
				entityId: "story-gl",
			}),
		);
		expect(result.pendingChangesCreated).toBe(1);
	});
});

describe("fetchAdoWorkItemStates", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const buildItem = (
		id: string,
		state: string,
		changedDate: string | null = null,
	) => ({
		id,
		displayId: id,
		title: `Item ${id}`,
		description: null,
		url: null,
		raw: {
			fields: {
				"System.Id": Number(id),
				"System.State": state,
				...(changedDate ? { "System.ChangedDate": changedDate } : {}),
			},
		},
	});

	it("forwards all linked external IDs to fetchPMItemsByIds", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ entityType: "STORY", entityId: "s1", externalId: "101" },
			{ entityType: "STORY", entityId: "s2", externalId: "102" },
			{ entityType: "FEATURE", entityId: "f1", externalId: "103" },
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				buildItem("101", "Active", "2026-05-05T00:00:00Z"),
				buildItem("102", "Closed", "2026-05-05T00:00:00Z"),
				buildItem("103", "Done", "2026-05-05T00:00:00Z"),
			],
			total: 3,
			hasNextPage: false,
			failedIds: [],
		});

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: "mcp-1",
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			containerId: "container-1",
			containerName: "MyProject",
			lastAdoStatePollAt: null,
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(mockFetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				externalIds: ["101", "102", "103"],
				containerId: "container-1",
				additionalContext: { project: "MyProject" },
				// Poll wiring (DEC-2/DEC-7): concurrency raised 5->8 and the fetch
				// is bounded by a per-call timeout + a whole-fetch budget.
				concurrency: 8,
				callTimeoutMs: 20_000,
				budgetMs: 4 * 60_000,
			}),
		);
		expect(result.items).toHaveLength(3);
		expect(result.seenExternalIds).toEqual(["101", "102", "103"]);
		expect(result.failedIds).toEqual([]);
		expect(result.totalLinked).toBe(3);
	});

	it("returns all items in backfill mode regardless of date", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ entityType: "STORY", entityId: "s1", externalId: "101" },
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [buildItem("101", "Active", "2026-01-01T00:00:00Z")],
			total: 1,
			hasNextPage: false,
			failedIds: [],
		});

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: "mcp-1",
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			containerId: "container-1",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user-1",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].externalId).toBe("101");
	});

	it("filters items by date in non-backfill mode", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ entityType: "STORY", entityId: "s1", externalId: "101" },
			{ entityType: "STORY", entityId: "s2", externalId: "102" },
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				buildItem("101", "Closed", "2026-05-04T00:00:00Z"),
				buildItem("102", "Done", "2026-05-06T00:00:00Z"),
			],
			total: 2,
			hasNextPage: false,
			failedIds: [],
		});

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: "mcp-1",
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			containerId: "container-1",
			containerName: null,
			lastAdoStatePollAt: new Date("2026-05-05T00:00:00Z"),
			userId: "user-1",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].externalId).toBe("102");
	});

	it("returns empty array when no linked items exist", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([]);

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: "mcp-1",
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			containerId: "container-1",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user-1",
		});

		expect(result.items).toEqual([]);
		expect(result.seenExternalIds).toEqual([]);
		expect(result.failedIds).toEqual([]);
		expect(result.totalLinked).toBe(0);
		expect(result.terminalStatusesHash).toEqual(expect.any(String));
		expect(result.terminalStatusesHash.length).toBeGreaterThan(0);
		expect(result.complete).toBe(true);
		expect(mockFetchPMItemsByIds).not.toHaveBeenCalled();
	});

	it("includes MCP items with no System.State (state becomes empty string)", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ entityType: "STORY", entityId: "s1", externalId: "101" },
			{ entityType: "STORY", entityId: "s2", externalId: "102" },
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				buildItem("101", "Closed"),
				{
					id: "102",
					displayId: "102",
					title: "Item 102",
					description: null,
					url: null,
					raw: { fields: {} },
				},
			],
			total: 2,
			hasNextPage: false,
			failedIds: [],
		});

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: "mcp-1",
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			containerId: "container-1",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user-1",
		});

		// normalizePolledState returns statusString: null → state: "" for missing System.State
		expect(result.items).toHaveLength(2);
		expect(result.items[0].externalId).toBe("101");
		expect(result.items[1].externalId).toBe("102");
		expect(result.items[1].state).toBe("");
	});

	it("normalizes a GitLab-REST item (closed + labels + updatedAt) — slim, no title", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([{ externalId: "7" }]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "7",
					title: "Closed issue",
					description: "done",
					raw: {
						state: "closed",
						labels: ["Done"],
						updatedAt: "2026-05-30T10:00:00Z",
					},
				},
			],
			failedIds: [],
		});

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: null,
			mcpServerId: "srv-gl",
			sourceKind: "rest-gitlab",
			containerId: "100",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user-1",
		});

		expect(result.items).toHaveLength(1);
		// #1741: the boundary verdict no longer carries title/description.
		expect(result.items[0]).not.toHaveProperty("title");
		expect(result.items[0]).not.toHaveProperty("description");
		expect(result.items[0]).toMatchObject({
			externalId: "7",
			state: "", // GitLab has no string status
			isClosed: true,
			labels: ["Done"],
			stateChangedDate: "2026-05-30T10:00:00.000Z",
		});
	});

	it("applies the incremental changed-date filter for MCP items", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ externalId: "1" },
			{ externalId: "2" },
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "1",
					title: "Old",
					raw: {
						fields: {
							"System.State": "Active",
							"System.ChangedDate": "2026-05-01T00:00:00Z",
						},
					},
				},
				{
					id: "2",
					title: "New",
					raw: {
						fields: {
							"System.State": "Active",
							"System.ChangedDate": "2026-05-10T00:00:00Z",
						},
					},
				},
			],
			failedIds: [],
		});

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: "mcp-1",
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			containerId: "cont-1",
			containerName: "P",
			lastAdoStatePollAt: new Date("2026-05-05T00:00:00Z"),
			userId: "user-1",
		});

		// Item 1 (changed 05-01, before anchor) skipped; item 2 (05-10) kept.
		expect(result.items.map((r) => r.externalId)).toEqual(["2"]);
	});

	it("surfaces failedIds and totalLinked from the fetch", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ externalId: "1" },
			{ externalId: "2" },
			{ externalId: "3" },
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "1",
					title: "A",
					raw: { fields: { "System.State": "Active" } },
				},
			],
			failedIds: ["2", "3"],
		});

		const result = await fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: "mcp-1",
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			containerId: "cont-1",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user-1",
		});

		expect(result.seenExternalIds).toEqual(["1"]);
		expect(result.failedIds).toEqual(["2", "3"]);
		expect(result.totalLinked).toBe(3);
	});

	// -------------------------------------------------------------------------
	// ADO structural batch branch (Task 3)
	// -------------------------------------------------------------------------

	const adoInput = {
		projectId: "p1",
		mcpConfigId: "cfg",
		mcpServerId: "srv",
		sourceKind: "mcp" as const,
		pmTool: "azure-devops",
		containerId: "c1",
		containerName: "Proj",
		lastAdoStatePollAt: null,
		userId: "u1",
		organizationId: "o1",
	};

	const sumOf = (n: number) => ({
		id: String(n),
		title: "x",
		description: null,
		state: "Active",
		raw: { fields: { "System.State": "Active" } },
	});

	it("ADO branch: silent-drop → structural notFoundIds", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ externalId: "1" },
			{ externalId: "2" },
			{ externalId: "3" },
		]);
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: [sumOf(1)],
			notFoundIds: [2, 3],
			wrongBoardIds: [],
			availableWorkItemTypes: [],
			availableStates: [],
		});
		const r = await fetchAdoWorkItemStates(adoInput);
		expect(r.notFoundIds.sort()).toEqual(["2", "3"]);
		expect(r.seenExternalIds).toEqual(["1"]);
		expect(mockGetWorkItemsByIdsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({ strict: true }),
		);
	});

	it("ADO branch: wrongBoardIds → seen, not missing", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ externalId: "1" },
			{ externalId: "2" },
		]);
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: [sumOf(1)],
			notFoundIds: [],
			wrongBoardIds: [2],
			availableWorkItemTypes: [],
			availableStates: [],
		});
		const r = await fetchAdoWorkItemStates(adoInput);
		expect(r.notFoundIds).toEqual([]);
		expect(r.seenExternalIds.sort()).toEqual(["1", "2"]);
	});

	it("ADO branch: all-requested missing (recognized empty) → notFound, NOT suppressed", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ externalId: "1" },
			{ externalId: "2" },
		]);
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: [],
			notFoundIds: [1, 2],
			wrongBoardIds: [],
			availableWorkItemTypes: [],
			availableStates: [],
		});
		const r = await fetchAdoWorkItemStates(adoInput);
		expect(r.notFoundIds.sort()).toEqual(["1", "2"]);
		expect(r.failedIds).toEqual([]);
	});

	it("ADO branch: batch throws (transient) → failedIds, not notFound", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ externalId: "1" },
			{ externalId: "2" },
			{ externalId: "3" },
		]);
		mockGetWorkItemsByIdsFromPM.mockRejectedValue(
			new Error("Failed to batch-fetch work items: 429"),
		);
		const r = await fetchAdoWorkItemStates(adoInput);
		expect(r.notFoundIds).toEqual([]);
		expect(r.failedIds.sort()).toEqual(["1", "2", "3"]);
	});

	it("ADO branch: non-numeric externalId → failedIds, never requested", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{ externalId: "AB#9" },
			{ externalId: "2" },
		]);
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: [sumOf(2)],
			notFoundIds: [],
			wrongBoardIds: [],
			availableWorkItemTypes: [],
			availableStates: [],
		});
		const r = await fetchAdoWorkItemStates(adoInput);
		expect(r.failedIds).toContain("AB#9");
		expect(mockGetWorkItemsByIdsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({ ids: [2] }),
		);
	});

	it("ADO branch: chunks >200 ids and unions notFound", async () => {
		const ids = Array.from({ length: 250 }, (_, i) => ({
			externalId: String(i + 1),
		}));
		mockGetLinkedExternalIds.mockResolvedValue(ids);
		mockGetWorkItemsByIdsFromPM.mockImplementation(
			async ({ ids }: { ids: number[] }) => ({
				items: ids.map((n) => sumOf(n)),
				notFoundIds: [],
				wrongBoardIds: [],
				availableWorkItemTypes: [],
				availableStates: [],
			}),
		);
		await fetchAdoWorkItemStates(adoInput);
		expect(mockGetWorkItemsByIdsFromPM).toHaveBeenCalledTimes(2); // 200 + 50
	});

	it("ADO branch: capability absent → falls back to per-ID path", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([{ externalId: "1" }]);
		mockGetWorkItemsByIdsFromPM.mockRejectedValue(
			new Error(
				"Azure DevOps MCP server does not expose wit_get_work_items_batch_by_ids",
			),
		);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "1",
					raw: { fields: { "System.State": "Active" } },
					title: "A",
					description: null,
				},
			],
			notFoundIds: [],
			failedIds: [],
		} as any);
		await fetchAdoWorkItemStates(adoInput);
		expect(mockFetchPMItemsByIds).toHaveBeenCalled();
	});

	it("non-ADO: uses per-ID path, not the batch", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([{ externalId: "X" }]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [],
			notFoundIds: [],
			failedIds: [],
		} as any);
		await fetchAdoWorkItemStates({ ...adoInput, pmTool: "fizzy" });
		expect(mockGetWorkItemsByIdsFromPM).not.toHaveBeenCalled();
		expect(mockFetchPMItemsByIds).toHaveBeenCalled();
	});
});

// =============================================================================
// Content-drift detection — now runs in the FETCH activity (#1741)
// =============================================================================

describe("fetchAdoWorkItemStates — content drift (moved from reconcile, #1741)", () => {
	const BASELINE = computePmHash("Old title", "Old description");

	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordPmSyncLog.mockResolvedValue(undefined);
		mockCreatePmSyncConflictNotifications.mockResolvedValue(undefined);
		// Fetch reads project config (tenant + terminal statuses) once.
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-9",
		});
		mockEpicFindUnique.mockResolvedValue({ title: "Drifted epic" });
		mockFeatureFindUnique.mockResolvedValue({ title: "Drifted feature" });
		mockUserStoryFindUnique.mockResolvedValue({
			title: "Drifted story",
			assigneeId: "assignee-1",
		});
	});

	/**
	 * Drive one card through the FETCH activity per-ID path: fetch classifies the
	 * item and, for passthrough, runs detectContentDrift in-place (the full card
	 * `title`/`description` is in hand there and must NOT cross the boundary).
	 */
	const runFetchDrift = (
		linkedOver: Record<string, unknown>,
		summary: {
			title: string | null;
			description: string | null;
			state?: string;
		},
	) => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "story-1",
				externalId: "AB#9",
				draftingStage: "DRAFTING",
				pmAutoHidden: false,
				lastSyncedPmHash: null,
				lastPmSyncStatus: null,
				...linkedOver,
			},
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "AB#9",
					title: summary.title,
					description: summary.description,
					raw: {
						fields: { "System.State": summary.state ?? "Active" },
					},
				},
			],
			failedIds: [],
			notFoundIds: [],
		});
		return fetchAdoWorkItemStates({
			projectId: "proj-1",
			// mcpConfigId null keeps us on the per-ID path (the ADO batch needs
			// numeric ids); pmTool azure-devops so the drift log stamps that slug.
			mcpConfigId: null,
			mcpServerId: "srv-1",
			sourceKind: "mcp",
			pmTool: "azure-devops",
			containerId: "c",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user-1",
		});
	};

	it("detects drift (changed title) → CONTENT_DRIFT upsert with the ADO hash", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pending-1",
		});
		const adoHash = computePmHash("New title", "Old description");
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "Old description" },
		);
		expect(mockUpsertPendingChange).toHaveBeenCalledWith({
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-1",
			externalId: "AB#9",
			previousState: "CONTENT",
			newState: "CONTENT",
			proposedAction: "CONTENT_DRIFT",
			detectedPmHash: adoHash,
		});
	});

	it("surfaces the created drift-row count in the fetch diagnostic (contentDriftRows)", async () => {
		// buildPollVerdict must CAPTURE detectContentDrift's boolean, not drop it:
		// a created row bumps the count the fetch logs (moved from reconcile, #1741).
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pending-1",
		});
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "Old description" },
		);
		expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
			"[PM Poll] Fetched work item states",
			expect.objectContaining({ contentDriftRows: 1 }),
		);
	});

	it("logs contentDriftRows: 0 when the item did not drift", async () => {
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "Old title", description: "Old description" },
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
			"[PM Poll] Fetched work item states",
			expect.objectContaining({ contentDriftRows: 0 }),
		);
	});

	it("detects drift on a changed description too", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pending-2",
		});
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: null },
			{ title: "Old title", description: "New description" },
		);
		expect(mockUpsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({ proposedAction: "CONTENT_DRIFT" }),
		);
	});

	it("no drift when the ADO content hashes identically to the baseline", async () => {
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "Old title", description: "Old description" },
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(mockRecordPmSyncLog).not.toHaveBeenCalled();
	});

	it("HTML/whitespace normalization parity → no false drift", async () => {
		// Baseline computed from plain text; ADO returns HTML-wrapped equivalent.
		await runFetchDrift(
			{
				lastSyncedPmHash: computePmHash("Title", "Line one"),
				lastPmSyncStatus: "SYNCED",
			},
			{ title: "Title  ", description: "<p>Line one</p>" },
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
	});

	it("skips when baseline is null (Q3 — no claim without a baseline)", async () => {
		await runFetchDrift(
			{ lastSyncedPmHash: null, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "New description" },
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(mockRecordPmSyncLog).not.toHaveBeenCalled();
	});

	it("skips when the item is already in push-time CONFLICT (Q7)", async () => {
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "CONFLICT" },
			{ title: "New title", description: "New description" },
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
	});

	it("terminal-state takes precedence — no CONTENT_DRIFT for a terminal item (Q11)", async () => {
		// A terminal STORY whose content ALSO drifted: fetch classifies it terminal
		// and the content-drift pass never runs — drift is only evaluated on
		// non-terminal passthrough.
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{
				title: "New title",
				description: "New description",
				state: "Closed",
			},
		);
		expect(mockUpsertPendingChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ proposedAction: "CONTENT_DRIFT" }),
		);
	});

	it("first-detection-only: 'created' logs once with reason ado-content-drift", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pending-1",
		});
		const adoHash = computePmHash("New title", "Old description");
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "Old description" },
		);
		expect(mockRecordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(mockRecordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				status: "CONFLICT",
				pmTool: "azure-devops",
				entityType: "STORY",
				entityId: "story-1",
				externalId: "AB#9",
				organizationId: "org-1",
				userId: null,
				actorUserId: null,
				errorPayload: {
					reason: "ado-content-drift",
					detectedPmHash: adoHash,
				},
			}),
		);
	});

	it("does NOT log/notify on 'updated' (drift re-observed, newer hash)", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "updated",
			pendingId: "pending-1",
		});
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "New description" },
		);
		expect(mockRecordPmSyncLog).not.toHaveBeenCalled();
		expect(mockCreatePmSyncConflictNotifications).not.toHaveBeenCalled();
	});

	it("does NOT log/notify on 'skipped' (already-open or dismissed-at-hash)", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "skipped",
			pendingId: null,
		});
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "New description" },
		);
		expect(mockRecordPmSyncLog).not.toHaveBeenCalled();
		expect(mockCreatePmSyncConflictNotifications).not.toHaveBeenCalled();
	});

	it("notifies for STORY content drift (project owner + assignee)", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pending-story",
		});
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "New description" },
		);
		expect(mockCreatePmSyncConflictNotifications).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "STORY",
				entityId: "story-1",
				proposedAction: "CONTENT_DRIFT",
				recipientUserIds: expect.arrayContaining([
					"assignee-1",
					"user-9",
				]),
			}),
		);
	});

	it("does NOT touch lastPmSyncStatus (Q7 — no push-side mutation)", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pending-1",
		});
		await runFetchDrift(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "New title", description: "New description" },
		);
		// The only userStory read is the title/assignee lookup for the log +
		// notification; there is no `.update` on the drift path.
		expect(mockUserStoryFindUnique).toHaveBeenCalled();
		expect(mockUserStoryUpdate).not.toHaveBeenCalled();
	});

	// R20 (Fizzy #1745, review round 2): the poller reaches GitLab REST too
	// (`sourceKind: "rest-gitlab"`), and `item.description` there is the raw
	// remote body — including any Fabric-owned attachment block. Drives
	// `fetchAdoWorkItemStates` the same way `runFetchDrift` does, but with the
	// GitLab REST source shape (`raw.state`/`raw.labels`, not `raw.fields`).
	const runFetchDriftGitLab = (
		linkedOver: Record<string, unknown>,
		summary: {
			title: string | null;
			description: string | null;
			state?: string;
		},
	) => {
		mockGetLinkedExternalIds.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "story-1",
				externalId: "42",
				draftingStage: "DRAFTING",
				pmAutoHidden: false,
				lastSyncedPmHash: null,
				lastPmSyncStatus: null,
				...linkedOver,
			},
		]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "42",
					title: summary.title,
					description: summary.description,
					raw: { state: summary.state ?? "opened", labels: [] },
				},
			],
			failedIds: [],
			notFoundIds: [],
		});
		return fetchAdoWorkItemStates({
			projectId: "proj-1",
			mcpConfigId: null,
			mcpServerId: "srv-1",
			sourceKind: "rest-gitlab",
			pmTool: "gitlab",
			containerId: "c",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user-1",
		});
	};

	it("R20: a polled GitLab description differing from the baseline ONLY by the attachment block is NOT reported as drift", async () => {
		const block = renderAttachmentBlock({
			links: [
				{
					filename: "spec.pdf",
					path: `/uploads/${"c".repeat(32)}/spec.pdf`,
				},
			],
			excluded: [],
		});
		// Baseline (BASELINE, defined above) was stamped block-free — mirrors
		// gitlab-rest-story-sync.ts's push/pull. The remote/polled description
		// carries the block, exactly what GitLab actually stores after a push
		// with attachments.
		const polledDescriptionWithBlock = appendAttachmentBlock(
			"Old description",
			block,
		);

		await runFetchDriftGitLab(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "Old title", description: polledDescriptionWithBlock },
		);

		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		expect(mockRecordPmSyncLog).not.toHaveBeenCalled();
	});

	it("R20: a polled GitLab description still reports REAL drift once the attachment block is discounted", async () => {
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pending-gitlab-1",
		});
		const block = renderAttachmentBlock({
			links: [
				{
					filename: "spec.pdf",
					path: `/uploads/${"c".repeat(32)}/spec.pdf`,
				},
			],
			excluded: [],
		});
		const polledDescriptionWithBlock = appendAttachmentBlock(
			"New description",
			block,
		);

		await runFetchDriftGitLab(
			{ lastSyncedPmHash: BASELINE, lastPmSyncStatus: "SYNCED" },
			{ title: "Old title", description: polledDescriptionWithBlock },
		);

		expect(mockUpsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({ proposedAction: "CONTENT_DRIFT" }),
		);
	});
});

describe("reconcileAdoStates — unified terminal predicate (Phase B)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-1",
			pmTerminalStatuses: ["Closed", "Done"],
			pmAutoCloseEnabled: false,
		});
	});

	function story(over: Record<string, unknown> = {}) {
		return {
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "BUILDING",
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
			...over,
		};
	}

	it("GitLab closed issue → terminal even with no status string", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue(story());
		await reconcileAdoStates({
			projectId: "proj-1",
			pmTool: "gitlab-official",
			items: [
				{
					externalId: "7",
					state: "",
					stateChangedDate: null,
					isClosed: true,
					labels: [],
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});
		expect(mockUserStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "closed",
				},
			}),
		);
	});

	it("GitLab open issue with a terminal label → terminal (label name snapshotted)", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue(story());
		await reconcileAdoStates({
			projectId: "proj-1",
			pmTool: "gitlab-official",
			items: [
				{
					externalId: "7",
					state: "",
					stateChangedDate: null,
					isClosed: false,
					labels: ["Done"],
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});
		expect(mockUserStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "Done",
				},
			}),
		);
	});

	it("case-insensitive: lowercase 'closed' status matches a 'Closed' list entry", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue(story());
		await reconcileAdoStates({
			projectId: "proj-1",
			pmTool: "github",
			items: [
				{
					externalId: "9",
					state: "closed",
					stateChangedDate: null,
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});
		expect(mockUserStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "closed",
				},
			}),
		);
	});

	it("non-terminal GitLab (open, no terminal label) → pmTicketTerminal false", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue(
			story({ lastSyncedPmHash: "h" }),
		);
		await reconcileAdoStates({
			projectId: "proj-1",
			pmTool: "gitlab-official",
			items: [
				{
					externalId: "7",
					state: "",
					stateChangedDate: null,
					isClosed: false,
					labels: ["backend"],
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});
		expect(mockUserStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { pmTicketTerminal: false, pmTicketTerminalStatus: null },
			}),
		);
	});

	it("GitLab open issue (state: '', isClosed: null) → pmTicketTerminal false, pmTicketTerminalStatus null", async () => {
		mockFindFabricItemByExternalId.mockResolvedValue(
			story({ lastSyncedPmHash: "h" }),
		);
		await reconcileAdoStates({
			projectId: "proj-1",
			pmTool: "gitlab-official",
			items: [
				{
					externalId: "7",
					state: "",
					stateChangedDate: null,
					isClosed: null,
					labels: [],
				},
			],
			terminalStatusesHash: hashOf(["Closed", "Done"]),
		});
		expect(mockUserStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			data: { pmTicketTerminal: false, pmTicketTerminalStatus: null },
		});
	});
});

// =============================================================================
// Settings-hash gate + story-state divergence (#1741 DEC-6)
// =============================================================================

describe("reconcileAdoStates — settings-hash gate + divergence", () => {
	const STABLE_HASH = hashOf(["Closed", "Done", "Removed"]);
	const stableConfig = {
		organizationId: "org_1",
		userId: "user_1",
		pmTerminalStatuses: ["Closed", "Done", "Removed"], // hash unchanged
		pmAutoCloseEnabled: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordPmSyncLog.mockResolvedValue(undefined);
		mockClearPendingContentDrift.mockResolvedValue(0);
		mockUserStoryUpdate.mockResolvedValue({});
		mockApplyTerminalClose.mockResolvedValue({ applied: true });
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
	});

	it("applies nothing and reports settingsStable:false when the hash no longer matches", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org_1",
			userId: "user_1",
			pmTerminalStatuses: ["Closed", "Done", "Removed", "Shipped"], // changed
			pmAutoCloseEnabled: true,
		});
		const res = await reconcileAdoStates({
			projectId: "proj_1",
			items: [
				{
					externalId: "1",
					state: "Shipped",
					stateChangedDate: null,
					labels: [],
					classification: "terminal",
				},
			],
			pmTool: "fizzy",
			terminalStatusesHash: hashOf(["Closed", "Done", "Removed"]),
		});
		expect(res.settingsStable).toBe(false);
		expect(res.storiesAutoHidden).toBe(0);
		expect(mockFindFabricItemByExternalId).not.toHaveBeenCalled();
	});

	it("applies terminal + reports settingsStable:true when the hash matches", async () => {
		mockProjectFindUnique.mockResolvedValue(stableConfig);
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story_1",
			draftingStage: "DRAFT",
			pmAutoHidden: false,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		const res = await reconcileAdoStates({
			projectId: "proj_1",
			// classification MUST be set (fail-closed rule holds on null) — a real
			// poll item always carries it (Codex round-3).
			items: [
				{
					externalId: "1",
					state: "Done",
					stateChangedDate: null,
					labels: [],
					classification: "terminal",
				},
			],
			pmTool: "fizzy",
			terminalStatusesHash: STABLE_HASH,
		});
		expect(res.settingsStable).toBe(true);
		expect(res.storiesAutoHidden).toBe(1);
	});

	it("HARMFUL reopen→passthrough diverged: holds the watermark (settingsStable:false)", async () => {
		mockProjectFindUnique.mockResolvedValue(stableConfig);
		// Fetch carried 'reopen'; reconcile re-reads a now-DRAFT/not-hidden story →
		// fresh classification is 'passthrough' → drift skipped in fetch, needed now.
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story_1",
			draftingStage: "DRAFT",
			pmAutoHidden: false,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		const res = await reconcileAdoStates({
			projectId: "proj_1",
			items: [
				{
					externalId: "1",
					state: "In Progress",
					stateChangedDate: null,
					labels: [],
					classification: "reopen",
				},
			],
			pmTool: "fizzy",
			terminalStatusesHash: STABLE_HASH,
		});
		expect(res.settingsStable).toBe(false);
	});

	it("HARMLESS passthrough→reopen diverged: still advances (settingsStable:true) — drift already ran in fetch", async () => {
		mockProjectFindUnique.mockResolvedValue(stableConfig);
		// Fetch carried 'passthrough' (ran drift); reconcile re-reads a now-CLOSED,
		// auto-hidden story → fresh 'reopen'. No drift is lost; unhide applies.
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story_1",
			draftingStage: "CLOSED",
			pmAutoHidden: true,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
		const res = await reconcileAdoStates({
			projectId: "proj_1",
			items: [
				{
					externalId: "1",
					state: "In Progress",
					stateChangedDate: null,
					labels: [],
					classification: "passthrough",
				},
			],
			pmTool: "fizzy",
			terminalStatusesHash: STABLE_HASH,
		});
		expect(res.settingsStable).toBe(true);
	});

	it("FAIL-CLOSED: an item without a fetch-time classification holds the watermark", async () => {
		mockProjectFindUnique.mockResolvedValue(stableConfig);
		mockFindFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story_1",
			draftingStage: "DRAFT",
			pmAutoHidden: false,
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
		});
		const res = await reconcileAdoStates({
			projectId: "proj_1",
			// No `classification` key — models an old fetch result during a deploy.
			items: [
				{
					externalId: "1",
					state: "In Progress",
					stateChangedDate: null,
					labels: [],
				},
			],
			pmTool: "fizzy",
			terminalStatusesHash: STABLE_HASH,
		});
		expect(res.settingsStable).toBe(false);
	});

	it("terminal hides still apply on a held cycle", async () => {
		mockProjectFindUnique.mockResolvedValue(stableConfig);
		// Item A is terminal (applies); item B diverges reopen→passthrough (holds).
		mockFindFabricItemByExternalId.mockImplementation(
			(_p: string, ext: string) =>
				ext === "A"
					? {
							entityType: "STORY",
							entityId: "story_A",
							draftingStage: "DRAFT",
							pmAutoHidden: false,
							lastSyncedPmHash: null,
							lastPmSyncStatus: null,
						}
					: {
							entityType: "STORY",
							entityId: "story_B",
							draftingStage: "DRAFT",
							pmAutoHidden: false,
							lastSyncedPmHash: null,
							lastPmSyncStatus: null,
						},
		);
		mockApplyTerminalClose.mockResolvedValue({ applied: true });
		const res = await reconcileAdoStates({
			projectId: "proj_1",
			items: [
				{
					externalId: "A",
					state: "Done",
					stateChangedDate: null,
					labels: [],
					classification: "terminal",
				},
				{
					externalId: "B",
					state: "In Progress",
					stateChangedDate: null,
					labels: [],
					classification: "reopen",
				},
			],
			pmTool: "fizzy",
			terminalStatusesHash: STABLE_HASH,
		});
		expect(res.storiesAutoHidden).toBe(1); // terminal A still hidden
		expect(res.settingsStable).toBe(false); // B's harmful divergence held it
	});
});

// =============================================================================
// FLAG_MISSING producer end-to-end (#1360)
// =============================================================================

describe("reconcileMissingTickets — end-to-end", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResetMissingStreaks.mockResolvedValue(undefined);
		mockPendingFlagMissingExists.mockResolvedValue(false);
		mockUpsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "pc1",
		});
	});

	it("flags a story whose ticket is missing for 3 cycles on the active server", async () => {
		mockFindFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "story-1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
		]);

		// Simulate the real streak helper: increment per cycle, capped at threshold.
		let streak = 0;
		mockIncrementMissingStreak.mockImplementation(async () => {
			streak = Math.min(streak + 1, STREAK_THRESHOLD);
			return streak;
		});

		// Each cycle is a distinct poll run (fresh child workflow per tick).
		const cycle = (pollRunId: string) => ({
			projectId: "p1",
			activeServerId: "srv-1",
			pollRunId,
			seenExternalIds: [] as string[],
			notFoundIds: ["123"],
			totalLinked: 10,
		});

		// Cycle 1 + 2: streak below threshold → no flag.
		expect(await reconcileMissingTickets(cycle("run-1"))).toBe(0);
		expect(await reconcileMissingTickets(cycle("run-2"))).toBe(0);
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();

		// Cycle 3: streak reaches threshold → FLAG_MISSING created.
		expect(await reconcileMissingTickets(cycle("run-3"))).toBe(1);
		expect(mockUpsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				proposedAction: "FLAG_MISSING",
				entityType: "STORY",
				entityId: "story-1",
				externalId: "123",
				newState: "MISSING",
				expectedExternalMcpServerId: "srv-1",
			}),
		);
	});

	it("never flags a cross-tool story even after many missing cycles", async () => {
		// Story is linked to a DIFFERENT PM server than the active one.
		mockFindFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "story-2",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-OTHER",
			},
		]);

		for (let i = 0; i < 5; i++) {
			expect(
				await reconcileMissingTickets({
					projectId: "p1",
					activeServerId: "srv-1",
					pollRunId: `run-${i}`,
					seenExternalIds: [] as string[],
					notFoundIds: ["456"],
					totalLinked: 10,
				}),
			).toBe(0);
		}
		expect(mockIncrementMissingStreak).not.toHaveBeenCalled();
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
	});
});
