/**
 * Unit Tests for ADO State Poll Activities
 *
 * Tests reconcileAdoStates, extractWorkItemStates via fetchAdoWorkItemStates,
 * and the batching/query logic.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/pm-state-poll.test.ts
 */

import { logger } from "@repo/logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// Fizzy #2304 — mapped-status sync: the leaf's order read and compare-and-set,
// resolveTrusted's reads (never-stamped MCP stories), the project's statuses,
// the last-run summary writer and the CONFLICT dedupe lookup.
const mockUserStoryFindFirst = vi.fn();
const mockUserStoryFindMany = vi.fn();
const mockUserStoryUpdateMany = vi.fn();
const mockProjectStoryStatusFindMany = vi.fn();
const mockMcpServerFindUnique = vi.fn();
const mockMcpConfigFindUnique = vi.fn();
const mockMergePmStatusSyncLastRun = vi.fn();
const mockHasPmSyncConflictWithDedupeKey = vi.fn();

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
			findFirst: (...args: unknown[]) => mockUserStoryFindFirst(...args),
			findMany: (...args: unknown[]) => mockUserStoryFindMany(...args),
			updateMany: (...args: unknown[]) =>
				mockUserStoryUpdateMany(...args),
		},
		projectStoryStatus: {
			findMany: (...args: unknown[]) =>
				mockProjectStoryStatusFindMany(...args),
		},
		mCPServer: {
			findUnique: (...args: unknown[]) =>
				mockMcpServerFindUnique(...args),
		},
		mCPConfig: {
			findUnique: (...args: unknown[]) =>
				mockMcpConfigFindUnique(...args),
		},
	},
	mergePmStatusSyncLastRun: (...args: unknown[]) =>
		mockMergePmStatusSyncLastRun(...args),
	hasPmSyncConflictWithDedupeKey: (...args: unknown[]) =>
		mockHasPmSyncConflictWithDedupeKey(...args),
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
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
	PM_POLL_RESULT_BUDGET_BYTES,
	type PmWorkItemState,
	reconcileAdoStates,
	reconcileMissingTickets,
	STREAK_THRESHOLD,
	statusSyncFetchOrder,
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
// The real class — `pm-source.ts` is NOT mocked in this file, so production's
// `err instanceof PMSourceNotFound` check inside `fetchAdoWorkItemStates`
// needs the SAME class identity here.
import { PMSourceNotFound } from "../src/activities/pm-source";
// The serializer the D2.3 cap measures with (Fizzy #2304).
import { measureSerializedBytes } from "../src/lib/payload-size-guard";
// Select-honouring, where-evaluating fake tables for the status-sync decision
// reads (Fizzy #2304, spec §6 rule 1).
import {
	createFakeTable,
	type RecordedCall,
	type Row,
} from "./test-helpers/select-honouring-db";

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
			projectManagementAdditionalContext: {
				account_slug: "/6117483",
				project: "Saved project name",
				nested: { ignored: true },
				list: ["ignored"],
				number: 42,
			},
			lastAdoStatePollAt: null,
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(mockFetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				externalIds: ["101", "102", "103"],
				containerId: "container-1",
				// Saved string values survive; an explicit saved project takes
				// precedence over the display-name hint, and non-strings never cross
				// the Temporal/MCP boundary.
				additionalContext: {
					account_slug: "/6117483",
					project: "Saved project name",
				},
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

// =============================================================================
// Mapped-status sync (Fizzy #2304) — fetch side: D2.1, D2.2 rotation, D2.3, D2.6
// =============================================================================

describe("fetchAdoWorkItemStates — status sync (Fizzy #2304)", () => {
	const NOW = new Date("2026-09-21T12:00:00.000Z");
	const SESSION = new Date("2026-09-20T09:00:00.000Z");
	const ANCHOR = new Date("2026-05-05T00:00:00.000Z");
	const BEFORE_ANCHOR = "2026-05-01T00:00:00Z";

	let projectRows: Row[];
	const dbCalls: RecordedCall[] = [];
	const projectRow = (over: Row = {}): Row => ({
		id: "proj-1",
		organizationId: "org-1",
		userId: "user-9",
		pmTerminalStatuses: ["Closed", "Done", "Removed"],
		pmStatusSyncEnabled: true,
		pmStatusSyncSessionAt: SESSION,
		...over,
	});
	const linked = (externalId: string) => ({
		entityType: "STORY",
		entityId: `story-${externalId}`,
		externalId,
		draftingStage: "DRAFT",
		pmAutoHidden: false,
		lastSyncedPmHash: null,
		lastPmSyncStatus: null,
	});
	const mcpInput = {
		projectId: "proj-1",
		mcpConfigId: "mcp-1",
		mcpServerId: "srv-1",
		sourceKind: "mcp" as const,
		containerId: "cont-1",
		containerName: "Portal",
		lastAdoStatePollAt: ANCHOR,
		userId: "user-1",
	};
	const restInput = {
		projectId: "proj-1",
		mcpConfigId: null,
		mcpServerId: "key:gitlab-official",
		sourceKind: "rest-gitlab" as const,
		pmTool: "gitlab-official",
		containerId: "acme/portal",
		containerName: null,
		lastAdoStatePollAt: null,
		userId: "user-1",
	};

	// Worst-case REST items for the D2.3 payload cap. GitLab's limits: a label
	// title is at most 255 characters, and a deeply nested group path makes an
	// issue URL ~2,000 characters.
	const longUrl = (iid: string) =>
		`https://gitlab.example.com/${"example-group/".repeat(135)}portal/-/issues/${iid}`;
	const longLabels = Array.from(
		{ length: 20 },
		(_, i) => `scope-${String(i).padStart(2, "0")}::${"l".repeat(245)}`,
	);
	const worstCaseSummaries = (n: number) =>
		Array.from({ length: n }, (_, i) => {
			const iid = String(i + 1);
			return {
				id: iid,
				title: `Card ${iid}`,
				description: null,
				url: longUrl(iid),
				raw: {
					state: "opened",
					labels: longLabels,
					updatedAt: "2026-09-02T10:00:00.000Z",
				},
			};
		});
	/** Fetch `n` worst-case REST items (the caller pins the rotation). */
	const fetchWorstCase = async (n: number) => {
		mockGetLinkedExternalIds.mockResolvedValue(
			worstCaseSummaries(n).map((s) => linked(s.id)),
		);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: worstCaseSummaries(n),
			failedIds: [],
			notFoundIds: [],
		});
		return fetchAdoWorkItemStates(restInput);
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		dbCalls.length = 0;
		projectRows = [projectRow()];
		mockProjectFindUnique.mockImplementation(
			createFakeTable("project", () => projectRows, dbCalls).findUnique,
		);
		mockMergePmStatusSyncLastRun.mockResolvedValue(undefined);
		mockGetLinkedExternalIds.mockResolvedValue([linked("1")]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("D2.1 per-item path: the watermark filters with the switch off and is ignored with it on", async () => {
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "1",
					title: "Unchanged since the anchor",
					raw: {
						fields: {
							"System.State": "Active",
							"System.ChangedDate": BEFORE_ANCHOR,
						},
					},
				},
			],
			failedIds: [],
			notFoundIds: [],
		});

		// Positive control: this anchor really filters this item.
		projectRows = [projectRow({ pmStatusSyncEnabled: false })];
		const off = await fetchAdoWorkItemStates(mcpInput);
		expect(off.items).toEqual([]);

		projectRows = [projectRow()];
		const on = await fetchAdoWorkItemStates(mcpInput);
		expect(on.items.map((i) => i.externalId)).toEqual(["1"]);
	});

	it("D2.1 ADO batch path: the same resolved anchor is ignored with the switch on", async () => {
		const adoInput = {
			...mcpInput,
			pmTool: "azure-devops",
			mcpConfigId: "cfg",
		};
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: [
				{
					id: "1",
					title: "Unchanged since the anchor",
					description: null,
					raw: {
						fields: {
							"System.State": "Active",
							"System.ChangedDate": BEFORE_ANCHOR,
						},
					},
				},
			],
			notFoundIds: [],
			wrongBoardIds: [],
			availableWorkItemTypes: [],
			availableStates: [],
		});

		// Positive control for the fallback spy asserted below: with the batch
		// tool absent, the per-item path answers.
		mockGetWorkItemsByIdsFromPM.mockRejectedValueOnce(
			new Error(
				"The MCP server does not expose wit_get_work_items_batch_by_ids",
			),
		);
		mockFetchPMItemsByIds.mockResolvedValueOnce({
			items: [],
			failedIds: [],
			notFoundIds: [],
		});
		await fetchAdoWorkItemStates(adoInput);
		expect(mockFetchPMItemsByIds).toHaveBeenCalledTimes(1);
		mockFetchPMItemsByIds.mockClear();

		projectRows = [projectRow({ pmStatusSyncEnabled: false })];
		expect((await fetchAdoWorkItemStates(adoInput)).items).toEqual([]);

		projectRows = [projectRow()];
		const on = await fetchAdoWorkItemStates(adoInput);
		expect(on.items.map((i) => i.externalId)).toEqual(["1"]);
		// The batch path answered, not the per-item fallback.
		expect(mockFetchPMItemsByIds).not.toHaveBeenCalled();
	});

	it("D2.3 carries the REST issue's own URL on the verdict only while the switch is on", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([linked("7")]);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "7",
					title: "Checkout: saved cards",
					description: null,
					url: "https://gitlab.example.com/acme/portal/-/issues/7",
					raw: {
						state: "opened",
						labels: ["type::feature", "workflow::in-review"],
						updatedAt: "2026-09-02T10:00:00.000Z",
					},
				},
			],
			failedIds: [],
			notFoundIds: [],
		});

		const on = await fetchAdoWorkItemStates(restInput);
		expect(on.items[0].itemUrl).toBe(
			"https://gitlab.example.com/acme/portal/-/issues/7",
		);

		projectRows = [projectRow({ pmStatusSyncEnabled: false })];
		const off = await fetchAdoWorkItemStates(restInput);
		expect(off.items).toHaveLength(1); // positive control: still emitted
		expect(off.items[0]).not.toHaveProperty("itemUrl");
	});

	it("D2.2 starts each status-sync fetch at a new offset, so a budget that runs out leaves a different tail unread", async () => {
		const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
		mockGetLinkedExternalIds.mockResolvedValue(ids.map((id) => linked(id)));
		// A fetch budget that covers four reads: the rest are budget-skipped,
		// exactly as the REST/MCP pools report them.
		mockFetchPMItemsByIds.mockImplementation(
			async (args: { externalIds: string[] }) => ({
				items: args.externalIds.slice(0, 4).map((id) => ({
					id,
					title: `Card ${id}`,
					raw: { fields: { "System.State": "Active" } },
				})),
				failedIds: args.externalIds.slice(4),
				notFoundIds: [],
			}),
		);
		const offset = vi
			.spyOn(statusSyncFetchOrder, "startOffset")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(4)
			.mockReturnValueOnce(8);
		try {
			const seen: string[][] = [];
			for (let cycle = 0; cycle < 3; cycle++) {
				const out = await fetchAdoWorkItemStates(mcpInput);
				seen.push(out.seenExternalIds);
				expect(out.complete).toBe(false);
			}

			expect(offset.mock.calls).toEqual([[10], [10], [10]]);
			expect(seen).toEqual([
				["1", "2", "3", "4"],
				["5", "6", "7", "8"],
				["9", "10", "1", "2"],
			]);
			// The first two cycles read disjoint sets, and three cycles reach
			// every linked item: no tail is starved.
			expect(seen[0].filter((id) => seen[1].includes(id))).toEqual([]);
			expect(new Set(seen.flat())).toEqual(new Set(ids));

			// With the switch off the stored order is read, with no offset.
			offset.mockClear();
			mockFetchPMItemsByIds.mockClear();
			projectRows = [projectRow({ pmStatusSyncEnabled: false })];
			await fetchAdoWorkItemStates(mcpInput);
			expect(offset).not.toHaveBeenCalled();
			expect(mockFetchPMItemsByIds.mock.calls[0][0].externalIds).toEqual(
				ids,
			);
		} finally {
			offset.mockRestore();
		}
	});

	it("D2.3 caps the verdict list at the payload budget with worst-case URLs and labels, reporting the tail in failedIds like a budget-skipped read", async () => {
		const offset = vi
			.spyOn(statusSyncFetchOrder, "startOffset")
			.mockReturnValue(0);
		try {
			expect(longUrl("1").length).toBeGreaterThan(1_900);
			expect(longLabels.every((l) => l.length === 255)).toBe(true);

			// Positive control: a project that fits keeps every verdict.
			const small = await fetchWorstCase(50);
			expect(small.items).toHaveLength(50);
			expect(small.failedIds).toEqual([]);
			expect(small.complete).toBe(true);

			mockMergePmStatusSyncLastRun.mockClear();
			const big = await fetchWorstCase(1_000);
			const bytes = measureSerializedBytes(big);
			expect(bytes).toBeLessThanOrEqual(PM_POLL_RESULT_BUDGET_BYTES);
			// Under Temporal's 2 MiB single-payload limit, which is what binds
			// (not the 4 MiB gRPC frame).
			expect(bytes).toBeLessThan(2 * 1024 * 1024);

			const all = worstCaseSummaries(1_000).map((s) => s.id);
			const kept = big.items.map((v) => v.externalId);
			expect(kept.length).toBeGreaterThan(0);
			expect(kept.length).toBeLessThan(1_000);
			// The kept verdicts are the head of the fetch order, intact.
			expect(kept).toEqual(all.slice(0, kept.length));
			expect(big.items[0].itemUrl).toBe(longUrl("1"));
			expect(big.items[0].labels).toEqual(longLabels);
			// The tail is reported exactly like a budget-skipped read.
			const tail = all.slice(kept.length);
			expect(big.seenExternalIds).toEqual(kept);
			expect(big.failedIds).toEqual(tail);
			expect(big.notFoundIds).toEqual([]);
			expect(big.complete).toBe(false);
			// The summary counts the deferred tail as not fetched (linked −
			// fetched − failed − notFound), not as failed reads: every read
			// succeeded.
			expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
				[
					{
						projectId: "proj-1",
						sessionAt: SESSION,
						patch: {
							fetch: {
								at: NOW.toISOString(),
								linked: 1_000,
								fetched: kept.length,
								failed: 0,
								notFound: 0,
								complete: false,
							},
						},
					},
				],
			]);
			expect(1_000 - kept.length - 0 - 0).toBe(tail.length);
		} finally {
			offset.mockRestore();
		}
	});

	it("D2.3 the budget is Temporal's 2 MiB per-payload limit less 128 KiB: a result of exactly that size is kept whole, one byte more is capped", async () => {
		// A literal on purpose, so a changed constant fails here: Temporal
		// refuses a single payload above 2 MiB, and the budget keeps 128 KiB of
		// headroom under it (1,966,080 bytes).
		const BUDGET = 2 * 1024 * 1024 - 128 * 1024;
		const N = 20;
		const ids = Array.from({ length: N }, (_, i) => String(i + 1));
		// Ordinary REST items. The LAST one carries a label padded by `pad`
		// characters, which adds exactly `pad` bytes to the serialized result.
		const fetchPadded = async (pad: number) => {
			mockGetLinkedExternalIds.mockResolvedValue(
				ids.map((id) => linked(id)),
			);
			mockFetchPMItemsByIds.mockResolvedValue({
				items: ids.map((iid, i) => ({
					id: iid,
					title: `Card ${iid}`,
					description: null,
					url: `https://gitlab.example.com/acme/portal/-/issues/${iid}`,
					raw: {
						state: "opened",
						labels:
							i === N - 1
								? [
										"workflow::in-review",
										`pad::${"x".repeat(pad)}`,
									]
								: ["workflow::in-review"],
						updatedAt: "2026-09-02T10:00:00.000Z",
					},
				})),
				failedIds: [],
				notFoundIds: [],
			});
			return fetchAdoWorkItemStates(restInput);
		};
		const offset = vi
			.spyOn(statusSyncFetchOrder, "startOffset")
			.mockReturnValue(0);
		try {
			// Positive control (and calibration): a small result passes whole.
			const base = await fetchPadded(0);
			expect(base.items.map((v) => v.externalId)).toEqual(ids);
			const baseBytes = measureSerializedBytes(base);
			expect(baseBytes).toBeLessThan(BUDGET);

			// Exactly on the budget: it fits, so nothing is capped.
			const atBudget = await fetchPadded(BUDGET - baseBytes);
			expect(measureSerializedBytes(atBudget)).toBe(BUDGET);
			expect(atBudget.items.map((v) => v.externalId)).toEqual(ids);
			expect(atBudget.failedIds).toEqual([]);
			expect(atBudget.complete).toBe(true);

			// One byte over: the padded last verdict no longer fits, and is
			// reported as a failed read for the next cycle.
			const over = await fetchPadded(BUDGET - baseBytes + 1);
			expect(over.items.map((v) => v.externalId)).toEqual(
				ids.slice(0, N - 1),
			);
			expect(over.seenExternalIds).toEqual(ids.slice(0, N - 1));
			expect(over.failedIds).toEqual([ids[N - 1]]);
			expect(over.complete).toBe(false);
			expect(measureSerializedBytes(over)).toBeLessThanOrEqual(BUDGET);
			// The exported budget is this same value.
			expect(PM_POLL_RESULT_BUDGET_BYTES).toBe(BUDGET);
		} finally {
			offset.mockRestore();
		}
	});

	describe("D2.3 identifier lists over the budget", () => {
		/** An ordinary REST verdict source for one issue. */
		const restSummary = (iid: string) => ({
			id: iid,
			title: `Card ${iid}`,
			description: null,
			url: `https://gitlab.example.com/acme/portal/-/issues/${iid}`,
			raw: {
				state: "opened",
				labels: ["workflow::in-review"],
				updatedAt: "2026-09-02T10:00:00.000Z",
			},
		});
		const NOT_ATTEMPTED = "poll budget exceeded (not attempted)";

		/**
		 * A REST fetch of `fetchedIds`, with `unstarted` ids the pool never
		 * started before its deadline and `notFound` definite 404s — shaped as
		 * the REST pool returns them (`notFoundIds ⊆ failedIds`, in-order).
		 */
		const fetchRest = async (opts: {
			fetchedIds: string[];
			unstarted: string[];
			notFound: string[];
			failed?: string[];
		}) => {
			const failed = opts.failed ?? [];
			mockGetLinkedExternalIds.mockResolvedValue(
				[
					...opts.fetchedIds,
					...failed,
					...opts.notFound,
					...opts.unstarted,
				].map((id) => linked(id)),
			);
			const failedIdErrors: Record<string, string> = {};
			for (const id of failed) {
				failedIdErrors[id] = "GitLab API error: 500";
			}
			for (const id of opts.notFound) {
				failedIdErrors[id] = "not found";
			}
			for (const id of opts.unstarted) {
				failedIdErrors[id] = NOT_ATTEMPTED;
			}
			mockFetchPMItemsByIds.mockResolvedValue({
				items: opts.fetchedIds.map(restSummary),
				failedIds: [...failed, ...opts.notFound, ...opts.unstarted],
				notFoundIds: opts.notFound,
				failedIdErrors,
			});
			return fetchAdoWorkItemStates(restInput);
		};
		/** 300,000 six-digit ids: ~2.7 MB as a JSON list, over the budget alone. */
		const MANY = Array.from({ length: 300_000 }, (_, i) =>
			String(100_000 + i),
		);
		const fetchSummaryPatch = () => {
			expect(mockMergePmStatusSyncLastRun).toHaveBeenCalledTimes(1);
			return mockMergePmStatusSyncLastRun.mock.calls[0][0];
		};

		let offset: { mockRestore: () => void };
		beforeEach(() => {
			offset = vi
				.spyOn(statusSyncFetchOrder, "startOffset")
				.mockReturnValue(0);
		});
		afterEach(() => {
			offset.mockRestore();
		});

		it("an unstarted-id list alone over the budget is trimmed from the tail: the result fits, is incomplete, and the summary keeps the true totals", async () => {
			// Positive control: an over-budget ITEMS result keeps its id lists
			// whole — every pre-existing failed and not-found id, plus the tail.
			const unstartedFew = ["2001", "2002"];
			const worst = worstCaseSummaries(1_000);
			mockGetLinkedExternalIds.mockResolvedValue(
				[...worst.map((s) => s.id), "2000", ...unstartedFew].map((id) =>
					linked(id),
				),
			);
			mockFetchPMItemsByIds.mockResolvedValue({
				items: worst,
				failedIds: ["2000", ...unstartedFew],
				notFoundIds: ["2000"],
				failedIdErrors: {
					"2000": "not found",
					"2001": NOT_ATTEMPTED,
					"2002": NOT_ATTEMPTED,
				},
			});
			const whole = await fetchAdoWorkItemStates(restInput);
			const keptWhole = whole.items.length;
			expect(keptWhole).toBeGreaterThan(0);
			expect(whole.failedIds).toEqual([
				"2000",
				...unstartedFew,
				...worst.slice(keptWhole).map((s) => s.id),
			]);
			expect(whole.notFoundIds).toEqual(["2000"]);
			expect(measureSerializedBytes(whole)).toBeLessThanOrEqual(
				PM_POLL_RESULT_BUDGET_BYTES,
			);

			// The id list alone is over the budget.
			mockMergePmStatusSyncLastRun.mockClear();
			const notFound = ["900001", "900002"];
			const untrimmedFailed = [...notFound, ...MANY];
			expect(measureSerializedBytes(untrimmedFailed)).toBeGreaterThan(
				PM_POLL_RESULT_BUDGET_BYTES,
			);
			const out = await fetchRest({
				fetchedIds: ["1"],
				unstarted: MANY,
				notFound,
			});

			expect(measureSerializedBytes(out)).toBeLessThanOrEqual(
				PM_POLL_RESULT_BUDGET_BYTES,
			);
			expect(out.complete).toBe(false);
			expect(
				out.seenExternalIds.length + out.notFoundIds.length,
			).toBeLessThan(out.totalLinked);
			expect(out.totalLinked).toBe(300_003);
			// The ids kept are the head of the untrimmed list (the item pass
			// appended the evicted verdict "1" at its tail); trimming stopped at
			// the failed list, so every definite not-found id survives.
			expect(out.failedIds.length).toBeGreaterThan(0);
			expect(out.failedIds.length).toBeLessThan(untrimmedFailed.length);
			expect(out.failedIds).toEqual(
				[...untrimmedFailed, "1"].slice(0, out.failedIds.length),
			);
			expect(out.notFoundIds).toEqual(notFound);
			// Ids reported whole take precedence over verdicts, so the lone
			// verdict was deferred like a budget-skipped read.
			expect(out.items).toEqual([]);
			expect(out.seenExternalIds).toEqual([]);
			// The summary counts the untrimmed lists: nothing was attempted and
			// failed — the 300,001 deferred ids (300,000 unstarted + the evicted
			// verdict) show as not fetched.
			expect(fetchSummaryPatch()).toEqual({
				projectId: "proj-1",
				sessionAt: SESSION,
				patch: {
					fetch: {
						at: NOW.toISOString(),
						linked: 300_003,
						fetched: 0,
						failed: 0,
						notFound: 2,
						complete: false,
					},
				},
			});
		});

		it("a not-found list alone over the budget is dropped whole, never cut to a biased sample for the outage guard", async () => {
			// Positive control: when the failed list is what overflows, every
			// not-found id is kept.
			const control = await fetchRest({
				fetchedIds: ["1"],
				unstarted: MANY,
				notFound: ["9"],
			});
			expect(control.notFoundIds).toEqual(["9"]);
			mockMergePmStatusSyncLastRun.mockClear();

			const out = await fetchRest({
				fetchedIds: ["1"],
				unstarted: [],
				notFound: MANY,
			});

			expect(measureSerializedBytes(out)).toBeLessThanOrEqual(
				PM_POLL_RESULT_BUDGET_BYTES,
			);
			expect(out.complete).toBe(false);
			// All or nothing: a partial list would lower the not-found share
			// the FLAG_MISSING outage guard reads, while an empty one only
			// holds every streak for a cycle.
			expect(out.notFoundIds).toEqual([]);
			// With the not-found list gone, the failed list keeps the head
			// that fits.
			expect(out.failedIds.length).toBeGreaterThan(0);
			expect(out.failedIds).toEqual(
				[...MANY, "1"].slice(0, out.failedIds.length),
			);
			expect(out.totalLinked).toBe(300_001);
			expect(fetchSummaryPatch().patch).toEqual({
				fetch: {
					at: NOW.toISOString(),
					linked: 300_001,
					fetched: 0,
					failed: 0,
					notFound: 300_000,
					complete: false,
				},
			});
		});

		it("switch off: the same over-budget id list is returned whole — after a switch-on positive control", async () => {
			const on = await fetchRest({
				fetchedIds: ["1"],
				unstarted: MANY,
				notFound: [],
			});
			expect(on.failedIds.length).toBeLessThan(MANY.length);

			projectRows = [projectRow({ pmStatusSyncEnabled: false })];
			const off = await fetchRest({
				fetchedIds: ["1"],
				unstarted: MANY,
				notFound: [],
			});

			expect(measureSerializedBytes(off)).toBeGreaterThan(
				PM_POLL_RESULT_BUDGET_BYTES,
			);
			expect(off.failedIds).toEqual(MANY);
			expect(off.items.map((v) => v.externalId)).toEqual(["1"]);
			expect(off.seenExternalIds).toEqual(["1"]);
		});

		it("I2 the summary counts only attempted reads as failed; ids the pool never started show as not fetched", async () => {
			const out = await fetchRest({
				fetchedIds: ["1"],
				failed: ["2", "3"],
				notFound: ["4"],
				unstarted: ["5", "6", "7"],
			});

			// The result itself is unchanged: every failure stays in failedIds.
			expect(out.failedIds).toEqual(["2", "3", "4", "5", "6", "7"]);
			const { fetch } = fetchSummaryPatch().patch;
			// Positive control: the genuinely failed reads still count as failed.
			expect(fetch.failed).toBe(2);
			// …and the three never-started ids do not: they are "not fetched".
			expect(fetch).toEqual({
				at: NOW.toISOString(),
				linked: 7,
				fetched: 1,
				failed: 2,
				notFound: 1,
				complete: false,
			});
			expect(
				fetch.linked - fetch.fetched - fetch.failed - fetch.notFound,
			).toBe(3);
		});
	});

	it("D2.3 a switch-off result over the budget is not capped, so it stays byte-identical to today's — after a switch-on positive control", async () => {
		const all = worstCaseSummaries(1_000).map((s) => s.id);
		const offset = vi
			.spyOn(statusSyncFetchOrder, "startOffset")
			.mockReturnValue(0);
		try {
			// Positive control: with the switch on, this fixture is capped.
			const on = await fetchWorstCase(1_000);
			expect(on.items.length).toBeLessThan(1_000);
			expect(on.complete).toBe(false);

			projectRows = [projectRow({ pmStatusSyncEnabled: false })];
			const off = await fetchWorstCase(1_000);

			// Over the budget, and still whole: every verdict, nothing failed.
			expect(measureSerializedBytes(off)).toBeGreaterThan(
				PM_POLL_RESULT_BUDGET_BYTES,
			);
			expect(off.items.map((v) => v.externalId)).toEqual(all);
			expect(off.seenExternalIds).toEqual(all);
			expect(off.failedIds).toEqual([]);
			expect(off.complete).toBe(true);
		} finally {
			offset.mockRestore();
		}
	});

	it("D2.6 records the fetch summary against the session read at the START of the fetch", async () => {
		mockGetLinkedExternalIds.mockResolvedValue([
			linked("1"),
			linked("2"),
			linked("3"),
		]);
		mockFetchPMItemsByIds.mockImplementation(async () => {
			// The switch is turned off and on again (a new session) mid-fetch.
			projectRows[0].pmStatusSyncSessionAt = new Date(
				"2026-09-21T11:59:00.000Z",
			);
			return {
				items: [
					{
						id: "1",
						title: "A",
						raw: { fields: { "System.State": "Active" } },
					},
				],
				failedIds: ["2", "3"],
				notFoundIds: ["3"],
			};
		});

		await fetchAdoWorkItemStates({ ...mcpInput, lastAdoStatePollAt: null });

		expect(dbCalls.filter((c) => c.table === "project")).toHaveLength(1);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[
				{
					projectId: "proj-1",
					sessionAt: SESSION,
					patch: {
						fetch: {
							at: NOW.toISOString(),
							linked: 3,
							fetched: 1,
							failed: 1,
							notFound: 1,
							complete: false,
						},
					},
				},
			],
		]);
	});

	it("D2.6 records a failed fetch and rethrows it — and writes nothing with the switch off", async () => {
		mockFetchPMItemsByIds.mockRejectedValue(
			new Error("GitLab returned 502"),
		);

		await expect(fetchAdoWorkItemStates(mcpInput)).rejects.toThrow(
			"GitLab returned 502",
		);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[
				{
					projectId: "proj-1",
					sessionAt: SESSION,
					patch: {
						failure: {
							at: NOW.toISOString(),
							kind: "fetch-failed",
							error: "GitLab returned 502",
						},
					},
				},
			],
		]);

		mockMergePmStatusSyncLastRun.mockClear();
		projectRows = [projectRow({ pmStatusSyncEnabled: false })];
		await expect(fetchAdoWorkItemStates(mcpInput)).rejects.toThrow(
			"GitLab returned 502",
		);
		expect(mockMergePmStatusSyncLastRun).not.toHaveBeenCalled();
	});

	it("D2.6 scrubs a credential the provider echoes in its error before storing the failure the settings card shows", async () => {
		mockFetchPMItemsByIds.mockRejectedValue(
			new Error(
				"GitLab returned 401 for PRIVATE-TOKEN: example-private-token-value via https://ci-bot:example-password@gitlab.example/api/v4",
			),
		);

		// The activity still fails with the provider's own error (Temporal
		// records it; the retry sees it unchanged)…
		await expect(fetchAdoWorkItemStates(mcpInput)).rejects.toThrow(
			"example-private-token-value",
		);
		// …but the stored summary, which users see, carries no credential.
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[
				{
					projectId: "proj-1",
					sessionAt: SESSION,
					patch: {
						failure: {
							at: NOW.toISOString(),
							kind: "fetch-failed",
							error: "GitLab returned 401 for PRIVATE-TOKEN: [REDACTED] via https://ci-bot:[REDACTED]@gitlab.example/api/v4",
						},
					},
				},
			],
		]);
	});

	it("D2.6 records a PMSourceNotFound's fixed-vocabulary reason+detail, not its generic Error.message — same shape the enumeration path uses", async () => {
		mockFetchPMItemsByIds.mockRejectedValue(
			new PMSourceNotFound(
				"token-failed",
				"GitLab rejected the token refresh (HTTP 401 invalid_client)",
			),
		);

		await expect(fetchAdoWorkItemStates(mcpInput)).rejects.toBeInstanceOf(
			PMSourceNotFound,
		);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[
				{
					projectId: "proj-1",
					sessionAt: SESSION,
					patch: {
						failure: {
							at: NOW.toISOString(),
							kind: "fetch-failed",
							error: "token-failed: GitLab rejected the token refresh (HTTP 401 invalid_client)",
						},
					},
				},
			],
		]);
	});
});

// =============================================================================
// Mapped-status sync (Fizzy #2304) — reconcile side, with the REAL leaf
// =============================================================================

describe("reconcileAdoStates — mapped-status sync (Fizzy #2304)", () => {
	const NOW = new Date("2026-09-21T12:00:00.000Z");
	const SESSION = new Date("2026-09-20T09:00:00.000Z");
	const T0 = new Date("2026-09-01T10:00:00.000Z");
	const D1 = "2026-09-02T10:00:00.000Z";
	const TERMINALS = ["Closed", "Done", "Removed"];
	const TODO = "st-todo";
	const PROGRESS = "st-progress";
	const REVIEW = "st-review";
	const GITLAB_SERVER = "key:gitlab-official";
	const issueUrl = (iid: string) =>
		`https://gitlab.example.com/acme/portal/-/issues/${iid}`;

	let projectRows: Row[];
	let storyRows: Row[];
	let statusRows: Row[];
	let mcpServerRows: Row[];
	let mcpConfigRows: Row[];
	const dbCalls: RecordedCall[] = [];

	const projectRow = (over: Row = {}): Row => ({
		id: "proj-1",
		organizationId: "org-1",
		userId: "user-9",
		pmTerminalStatuses: TERMINALS,
		pmAutoCloseEnabled: false,
		pmStatusSyncEnabled: true,
		pmStatusSyncSessionAt: SESSION,
		projectManagementAdditionalContext: {
			labelStatusMap: {
				"workflow::todo": TODO,
				"workflow::in-progress": PROGRESS,
				"workflow::in-review": REVIEW,
			},
		},
		projectManagementMcpServerId: GITLAB_SERVER,
		projectManagementMcpConfigId: null,
		...over,
	});

	/** A REST GitLab story as import leaves it: stored URL, no server stamp, base on its link. */
	const glStory = (
		id: string,
		iid: string,
		kind: "FEATURE" | "BUG",
		over: Row = {},
	): Row => ({
		id,
		projectId: "proj-1",
		kind,
		title: `Linked ${kind.toLowerCase()} ${iid}`,
		statusId: TODO,
		order: 1,
		draftingStage: "DRAFT",
		pmAutoHidden: false,
		pmStatusSyncBaseId: TODO,
		pmStatusSyncBaseAt: T0,
		pmStatusSyncBaseLink: issueUrl(iid),
		pmStatusSyncBaseFabricId: TODO,
		lastPmSyncStatus: "SUCCESS",
		externalId: iid,
		externalUrl: issueUrl(iid),
		externalMcpServerId: null,
		lastEditedAt: new Date("2026-08-30T09:00:00.000Z"),
		lastEditedSource: "MANUAL",
		lastEditedByName: "Example Editor",
		...over,
	});

	/** A slim verdict exactly as fetch emits it with the switch on. */
	const verdict = (
		iid: string,
		over: Partial<PmWorkItemState> = {},
	): PmWorkItemState => ({
		externalId: iid,
		state: "",
		stateChangedDate: D1,
		isClosed: false,
		labels: ["type::feature", "workflow::in-review"],
		classification: "passthrough",
		itemUrl: issueUrl(iid),
		...over,
	});

	const run = (items: PmWorkItemState[], pmTool = "gitlab-official") =>
		reconcileAdoStates({
			projectId: "proj-1",
			items,
			pmTool,
			terminalStatusesHash: hashOf(TERMINALS),
		});

	const statusOf = (id: string) =>
		storyRows.find((s) => s.id === id)?.statusId;
	const casCalls = () =>
		dbCalls
			.filter((c) => c.table === "userStory" && c.method === "updateMany")
			.map((c) => c.args);
	/** The exact compare-and-set a `moved` outcome writes for a glStory at its defaults. */
	const movedCas = (id: string, iid: string, order: number) => ({
		where: {
			id,
			projectId: "proj-1",
			statusId: TODO,
			pmStatusSyncBaseId: TODO,
			pmStatusSyncBaseAt: T0,
			pmStatusSyncBaseLink: issueUrl(iid),
			pmStatusSyncBaseFabricId: TODO,
		},
		data: {
			statusId: REVIEW,
			order,
			pmStatusSyncBaseId: REVIEW,
			pmStatusSyncBaseAt: new Date(D1),
			pmStatusSyncBaseLink: issueUrl(iid),
			pmStatusSyncBaseFabricId: REVIEW,
			lastEditedAt: NOW,
			lastEditedSource: "PM_PULL",
			lastEditedByName: null,
		},
	});
	const counts = (over: Record<string, number> = {}) => ({
		moved: 0,
		unchanged: 0,
		"fabric-ahead": 0,
		"not-mapped": 0,
		ambiguous: 0,
		unverified: 0,
		stale: 0,
		"skipped-conflict": 0,
		raced: 0,
		...over,
	});
	const outcomeWrite = (over: Record<string, number> = {}) => ({
		projectId: "proj-1",
		sessionAt: SESSION,
		patch: { outcome: { at: NOW.toISOString(), counts: counts(over) } },
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		dbCalls.length = 0;
		projectRows = [projectRow()];
		storyRows = [];
		statusRows = [
			{ id: TODO, projectId: "proj-1", name: "To Do" },
			{ id: PROGRESS, projectId: "proj-1", name: "In Progress" },
			{ id: REVIEW, projectId: "proj-1", name: "In Review" },
		];
		mcpServerRows = [];
		mcpConfigRows = [];
		const project = createFakeTable("project", () => projectRows, dbCalls);
		const story = createFakeTable("userStory", () => storyRows, dbCalls);
		const status = createFakeTable(
			"projectStoryStatus",
			() => statusRows,
			dbCalls,
		);
		const server = createFakeTable(
			"mCPServer",
			() => mcpServerRows,
			dbCalls,
		);
		const config = createFakeTable(
			"mCPConfig",
			() => mcpConfigRows,
			dbCalls,
		);
		mockProjectFindUnique.mockImplementation(project.findUnique);
		mockUserStoryFindUnique.mockImplementation(story.findUnique);
		mockUserStoryFindFirst.mockImplementation(story.findFirst);
		mockUserStoryFindMany.mockImplementation(story.findMany);
		mockUserStoryUpdateMany.mockImplementation(story.updateMany);
		mockUserStoryUpdate.mockResolvedValue({});
		mockProjectStoryStatusFindMany.mockImplementation(status.findMany);
		mockMcpServerFindUnique.mockImplementation(server.findUnique);
		mockMcpConfigFindUnique.mockImplementation(config.findUnique);
		mockHasPmSyncConflictWithDedupeKey.mockResolvedValue(false);
		mockMergePmStatusSyncLastRun.mockResolvedValue(undefined);
		mockRecordPmSyncLog.mockResolvedValue(undefined);
		mockClearPendingContentDrift.mockResolvedValue(0);
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
		mockFindFabricItemByExternalId.mockImplementation(
			async (_projectId: string, externalId: string) => {
				const row = storyRows.find((s) => s.externalId === externalId);
				return row
					? {
							entityType: "STORY",
							entityId: row.id,
							draftingStage: row.draftingStage,
							lastSyncedPmHash: null,
							lastPmSyncStatus: row.lastPmSyncStatus,
							pmAutoHidden: row.pmAutoHidden,
						}
					: null;
			},
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("moves a FEATURE and a BUG to their ticket's mapped status, appended to the column (AC3, AC10)", async () => {
		storyRows = [
			glStory("story-feature", "42", "FEATURE"),
			glStory("story-bug", "43", "BUG"),
			glStory("story-in-review", "50", "FEATURE", {
				statusId: REVIEW,
				order: 4,
			}),
		];

		await run([verdict("42"), verdict("43")]);

		expect(statusOf("story-feature")).toBe(REVIEW);
		expect(statusOf("story-bug")).toBe(REVIEW);
		expect(casCalls()).toEqual([
			movedCas("story-feature", "42", 5),
			movedCas("story-bug", "43", 6),
		]);
		expect(mockRecordPmSyncLog).toHaveBeenNthCalledWith(1, {
			organizationId: "org-1",
			userId: null,
			projectId: "proj-1",
			direction: "pull",
			entityType: "STORY",
			entityId: "story-feature",
			title: "Linked feature 42",
			pmTool: "gitlab",
			status: "SUCCESS",
			actorUserId: null,
			externalId: "42",
			externalUrl: issueUrl("42"),
		});
		expect(mockRecordAudit).toHaveBeenCalledTimes(2);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[outcomeWrite({ moved: 2 })],
		]);
		// AC3 — the move is the leaf's own compare-and-set, never move-story:
		// the only other story writes are the two terminal-checkmark
		// snapshots. (Reconcile has no notification call site at all —
		// createPmSyncConflictNotifications is fetch-only — so a "not called"
		// assertion on it could never fail and is not made here.)
		expect(mockUserStoryUpdate.mock.calls).toEqual([
			[
				{
					where: { id: "story-feature", projectId: "proj-1" },
					data: {
						pmTicketTerminal: false,
						pmTicketTerminalStatus: null,
					},
				},
			],
			[
				{
					where: { id: "story-bug", projectId: "proj-1" },
					data: {
						pmTicketTerminal: false,
						pmTicketTerminalStatus: null,
					},
				},
			],
		]);
	});

	it("runs the leaf on an auto-unhid verdict, so a reopened ticket lands in its mapped status (AC7)", async () => {
		projectRows = [projectRow({ pmAutoCloseEnabled: true })];
		storyRows = [
			glStory("story-reopened", "42", "FEATURE", {
				draftingStage: "CLOSED",
				pmAutoHidden: true,
				pmStatusSyncBaseId: "__terminal__",
			}),
		];

		await run([
			verdict("42", {
				classification: "reopen",
				labels: ["workflow::in-progress"],
			}),
		]);

		expect(mockApplyTerminalUnhide).toHaveBeenCalledTimes(1);
		expect(statusOf("story-reopened")).toBe(PROGRESS);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[outcomeWrite({ moved: 1 })],
		]);
	});

	it("a terminal verdict records __terminal__ without touching the status, and the reopen that follows is a change (AC6, AC7)", async () => {
		storyRows = [
			glStory("story-1", "42", "FEATURE", {
				statusId: PROGRESS,
				pmStatusSyncBaseId: PROGRESS,
				pmStatusSyncBaseFabricId: PROGRESS,
			}),
		];

		await run([
			verdict("42", {
				classification: "terminal",
				isClosed: true,
				labels: ["workflow::in-progress"],
			}),
		]);

		expect(casCalls()).toEqual([
			{
				where: {
					id: "story-1",
					projectId: "proj-1",
					statusId: PROGRESS,
					pmStatusSyncBaseId: PROGRESS,
					pmStatusSyncBaseAt: T0,
					pmStatusSyncBaseLink: issueUrl("42"),
					pmStatusSyncBaseFabricId: PROGRESS,
				},
				data: {
					pmStatusSyncBaseId: "__terminal__",
					pmStatusSyncBaseAt: new Date(D1),
					pmStatusSyncBaseLink: issueUrl("42"),
					pmStatusSyncBaseFabricId: PROGRESS,
				},
			},
		]);
		expect(statusOf("story-1")).toBe(PROGRESS);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[outcomeWrite()],
		]);

		// Moved in Fabric while the ticket was closed; the ticket then reopens
		// with the label it had before it closed.
		storyRows[0].statusId = TODO;
		await run([
			verdict("42", {
				stateChangedDate: "2026-09-05T10:00:00.000Z",
				labels: ["workflow::in-progress"],
			}),
		]);
		expect(statusOf("story-1")).toBe(PROGRESS);
	});

	it("with the switch off: no status read, no write, no summary (AC14) — after a positive control", async () => {
		storyRows = [glStory("story-1", "42", "FEATURE")];
		await run([verdict("42")]);
		// Positive controls for every negative below.
		expect(statusOf("story-1")).toBe(REVIEW);
		expect(mockMergePmStatusSyncLastRun).toHaveBeenCalledTimes(1);
		expect(mockRecordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(
			new Set(
				dbCalls
					.filter((c) => c.table !== "project")
					.map((c) => c.table),
			),
		).toEqual(new Set(["projectStoryStatus", "userStory"]));

		mockMergePmStatusSyncLastRun.mockClear();
		mockRecordPmSyncLog.mockClear();
		dbCalls.length = 0;
		storyRows = [
			glStory("story-1", "42", "FEATURE"),
			glStory("story-2", "43", "BUG"),
		];
		projectRows = [projectRow({ pmStatusSyncEnabled: false })];
		await run([
			verdict("42"),
			verdict("43", { classification: "terminal", isClosed: true }),
		]);

		expect(statusOf("story-1")).toBe(TODO);
		expect(dbCalls.filter((c) => c.table !== "project")).toEqual([]);
		expect(mockMergePmStatusSyncLastRun).not.toHaveBeenCalled();
		expect(mockRecordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a Fabric edit newer than the ticket's change does not hold back the ticket's status (no poll-level lastEditedAt skip)", async () => {
		storyRows = [
			glStory("story-1", "42", "FEATURE", {
				statusId: PROGRESS, // a Fabric move…
				lastEditedAt: new Date("2026-09-02T11:00:00.000Z"), // …an hour after the ticket changed
			}),
		];

		await run([verdict("42")]);

		expect(statusOf("story-1")).toBe(REVIEW);
	});

	it("verifies a never-stamped MCP story through the project's trusted org, resolved once per run (AC8)", async () => {
		projectRows = [
			projectRow({
				projectManagementMcpServerId: "srv-ado",
				projectManagementMcpConfigId: "cfg-ado",
				projectManagementAdditionalContext: {},
			}),
		];
		mcpServerRows = [
			{ id: "srv-ado", key: "azure-devops", defaultUrl: null },
		];
		mcpConfigRows = [
			{
				id: "cfg-ado",
				baseUrl: null,
				commandArgs: ["example-org"],
				atlassianCloudSiteUrl: null,
			},
		];
		statusRows = [
			{ id: "st-new", projectId: "proj-1", name: "New" },
			{ id: "st-active", projectId: "proj-1", name: "Active" },
		];
		const adoStory = (id: string, externalId: string, org: string): Row =>
			glStory(id, externalId, "FEATURE", {
				statusId: "st-new",
				pmStatusSyncBaseId: null,
				pmStatusSyncBaseAt: null,
				pmStatusSyncBaseLink: null,
				pmStatusSyncBaseFabricId: null,
				externalUrl: `https://dev.azure.com/${org}/Portal/_workitems/edit/${externalId}`,
			});
		storyRows = [
			adoStory("story-ours", "101", "example-org"),
			adoStory("story-foreign", "102", "other-org"),
		];
		const adoVerdict = (externalId: string): PmWorkItemState => ({
			externalId,
			state: "Active",
			stateChangedDate: D1,
			isClosed: null,
			labels: [],
			classification: "passthrough",
			// Exactly what fetch emits for an MCP tool with the switch on.
			itemUrl: null,
		});

		await run([adoVerdict("101"), adoVerdict("102")], "azure-devops");

		expect(statusOf("story-ours")).toBe("st-active");
		expect(statusOf("story-foreign")).toBe("st-new");
		expect(dbCalls.filter((c) => c.table === "mCPServer")).toHaveLength(1);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[outcomeWrite({ moved: 1, unverified: 1 })],
		]);
	});

	it("writes the outcome counts once, against the session read at the START of reconcile (D2.6 session guard)", async () => {
		storyRows = [glStory("story-1", "42", "FEATURE")];
		const stories = createFakeTable("userStory", () => storyRows, dbCalls);
		mockUserStoryUpdateMany.mockImplementation(
			async (args: Record<string, unknown>) => {
				// The switch is turned off and on again (a new session) mid-run.
				projectRows[0].pmStatusSyncSessionAt = new Date(
					"2026-09-21T11:59:00.000Z",
				);
				return stories.updateMany(args);
			},
		);

		await run([verdict("42")]);

		expect(dbCalls.filter((c) => c.table === "project")).toHaveLength(1);
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[outcomeWrite({ moved: 1 })],
		]);
	});

	it("a verdict fetched while the switch was off (no itemUrl key) is not observed: no CONFLICT row, no write, not counted (D2.3)", async () => {
		// Positive control for the write assertions below: the same story
		// with the issue's URL on the verdict moves.
		storyRows = [glStory("story-1", "42", "FEATURE")];
		await run([verdict("42")]);
		expect(casCalls()).toEqual([movedCas("story-1", "42", 1)]);
		expect(statusOf("story-1")).toBe(REVIEW);

		// Positive control for the CONFLICT and count assertions below:
		// itemUrl null — fetched with the switch on, the issue had no URL —
		// IS unverified, with one CONFLICT row, and is counted.
		mockRecordPmSyncLog.mockClear();
		mockMergePmStatusSyncLastRun.mockClear();
		storyRows = [glStory("story-1", "42", "FEATURE")];
		await run([verdict("42", { itemUrl: null })]);
		expect(mockRecordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(mockRecordPmSyncLog.mock.calls[0][0]).toMatchObject({
			entityId: "story-1",
			status: "CONFLICT",
		});
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[outcomeWrite({ unverified: 1 })],
		]);

		mockRecordPmSyncLog.mockClear();
		mockMergePmStatusSyncLastRun.mockClear();
		dbCalls.length = 0;
		// Exactly what fetch emitted with the switch off: no itemUrl key at all
		// (the switch came on between the fetch and this reconcile).
		const switchOffVerdict: PmWorkItemState = {
			externalId: "42",
			state: "",
			stateChangedDate: D1,
			isClosed: false,
			labels: ["type::feature", "workflow::in-review"],
			classification: "passthrough",
		};
		await run([switchOffVerdict]);

		expect(mockRecordPmSyncLog).not.toHaveBeenCalled();
		expect(casCalls()).toEqual([]);
		expect(statusOf("story-1")).toBe(TODO);
		// The run still records its (empty) outcome summary: nothing counted.
		expect(mockMergePmStatusSyncLastRun.mock.calls).toEqual([
			[outcomeWrite()],
		]);
	});
});
