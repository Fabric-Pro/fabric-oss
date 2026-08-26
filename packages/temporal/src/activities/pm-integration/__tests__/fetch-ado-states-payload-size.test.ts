/**
 * Payload-size regression guard (#1741).
 *
 * The frozen prod poll was caused by `fetchAdoWorkItemStates` packing
 * `title`+`description` for every linked card (~6.48 MB on "Fabric-Main"),
 * blowing past Temporal's 4 MB gRPC limit so the activity return was rejected
 * and reconcile never ran. This test drives BOTH fetch paths (per-ID + ADO
 * batch) with 480 large-description cards and asserts the serialized result is
 * far under the limit and carries NO `title`/`description` — and that every
 * item carries a fetch-time `classification` (so the reconcile divergence gate
 * never fails open for a real poll).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/activities/pm-integration/__tests__/fetch-ado-states-payload-size.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Inlined copies of the real (pure) helpers — keep in sync with story-sync.ts.
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

const BIG = "x".repeat(12_000); // ~12 KB description per card → ~5.8 MB if packed

function makeSummaries(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: String(i + 1),
		title: `Card ${i + 1}`,
		description: BIG,
		raw: {
			fields: {
				"System.State": "Active",
				"System.ChangedDate": "2030-01-01T00:00:00Z",
			},
		},
	}));
}

describe("fetchAdoWorkItemStates — payload size (#1741)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordPmSyncLog.mockResolvedValue(undefined);
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org_1",
			userId: "user_1",
			pmTerminalStatuses: ["Closed", "Done", "Removed"],
			pmAutoCloseEnabled: true,
		});
		// Non-null baseline hash so passthrough drift would run if title/desc leaked.
		mockGetLinkedExternalIds.mockResolvedValue(
			makeSummaries(480).map((s) => ({
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

	it("per-ID path: slim result is < 512 KB and carries no title/description", async () => {
		mockFetchPMItemsByIds.mockResolvedValue({
			items: makeSummaries(480),
			failedIds: [],
			notFoundIds: [],
		});
		const res = await fetchAdoWorkItemStates({
			projectId: "proj_1",
			mcpConfigId: "cfg",
			containerId: "c",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user_1",
			pmTool: "fizzy",
			sourceKind: "mcp",
		});
		const bytes = JSON.stringify(res).length;
		expect(bytes).toBeLessThan(512 * 1024);
		expect(typeof res.terminalStatusesHash).toBe("string");
		expect(res.items.length).toBe(480);
		for (const it of res.items) {
			expect(it).not.toHaveProperty("title");
			expect(it).not.toHaveProperty("description");
			expect(["terminal", "reopen", "passthrough"]).toContain(
				it.classification,
			);
		}
	});

	it("ADO-batch path: slim result is < 512 KB and carries no title/description", async () => {
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: makeSummaries(200),
			wrongBoardIds: [],
			notFoundIds: [],
		});
		const res = await fetchAdoWorkItemStates({
			projectId: "proj_1",
			mcpConfigId: "cfg",
			containerId: "c",
			containerName: "Proj",
			lastAdoStatePollAt: null,
			userId: "user_1",
			pmTool: "azure-devops",
			sourceKind: "mcp",
		});
		expect(JSON.stringify(res).length).toBeLessThan(512 * 1024);
		expect(typeof res.terminalStatusesHash).toBe("string");
		expect(res.items.length).toBeGreaterThan(0);
		for (const it of res.items) {
			expect(it).not.toHaveProperty("title");
			expect(it).not.toHaveProperty("description");
			expect(["terminal", "reopen", "passthrough"]).toContain(
				it.classification,
			);
		}
	});
});
