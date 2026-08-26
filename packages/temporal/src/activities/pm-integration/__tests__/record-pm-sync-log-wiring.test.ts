/**
 * Wiring tests for `recordPmSyncLog` at the sync-outcome boundaries (T4.1).
 *
 * These assert the CALL CONTRACT at each injection site — that the right
 * `status` + `entityType` + `direction` are emitted, that a bug logs as
 * `STORY`, and (critically, D4) that a nothing-to-do path emits ZERO rows.
 * `recordPmSyncLog` itself is mocked so the tests stay at the wiring layer
 * (its own non-fatal / context-resolution behaviour is covered by
 * `record-pm-sync-log.test.ts`).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/record-pm-sync-log-wiring.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// Shared mocks
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	recordPmSyncLog: vi.fn(),
	// @repo/database surface used across the three sites under test.
	epicFindUnique: vi.fn(),
	featureFindUnique: vi.fn(),
	userStoryFindUnique: vi.fn(),
	userStoryFindMany: vi.fn(),
	epicUpdate: vi.fn(),
	featureUpdate: vi.fn(),
	userStoryUpdate: vi.fn(),
	mcpServerFindUnique: vi.fn(),
	projectFindUnique: vi.fn(),
	upsertPendingChange: vi.fn(),
	findFabricItemByExternalId: vi.fn(),
	getLinkedExternalIds: vi.fn(),
	createPmSyncConflictNotifications: vi.fn(),
	discoverPMToolCapabilities: vi.fn(),
}));

vi.mock("../record-pm-sync-log", () => ({
	recordPmSyncLog: mocks.recordPmSyncLog,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		log: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	db: {
		epic: {
			findUnique: mocks.epicFindUnique,
			update: mocks.epicUpdate,
		},
		feature: {
			findUnique: mocks.featureFindUnique,
			update: mocks.featureUpdate,
		},
		userStory: {
			findUnique: mocks.userStoryFindUnique,
			update: mocks.userStoryUpdate,
			findMany: mocks.userStoryFindMany,
		},
		mCPServer: {
			findUnique: mocks.mcpServerFindUnique,
		},
		project: {
			findUnique: mocks.projectFindUnique,
		},
	},
	upsertPendingChange: mocks.upsertPendingChange,
	findFabricItemByExternalId: mocks.findFabricItemByExternalId,
	getLinkedExternalIds: mocks.getLinkedExternalIds,
	createPmSyncConflictNotifications: mocks.createPmSyncConflictNotifications,
}));

// `humanizePmSyncError` is a pure helper; keep the real one (identity-ish for
// unknown messages) so the FAILURE payload looks realistic.
vi.mock("../humanize-pm-sync-error", async () => {
	const actual = await vi.importActual<{
		humanizePmSyncError: (m: string) => string;
	}>("../humanize-pm-sync-error");
	return actual;
});

// `pm-state-poll` statically imports `fetchPMItemsByIds` from `story-sync`
// (a heavy module graph). Stub `story-sync` to a no-op surface so importing
// `reconcileAdoStates` stays light — the function under test never calls it.
vi.mock("../story-sync", () => ({
	fetchPMItemsByIds: mocks.discoverPMToolCapabilities,
}));

import { recordPmSyncFailure } from "../record-pm-sync-state";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.recordPmSyncLog.mockResolvedValue(undefined);
	mocks.epicUpdate.mockResolvedValue({});
	mocks.featureUpdate.mockResolvedValue({});
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.mcpServerFindUnique.mockResolvedValue({ key: "azure-devops" });
});

// =============================================================================
// Site 3 — Push FAILURE (record-pm-sync-state.ts → recordPmSyncFailure)
// =============================================================================

describe("recordPmSyncFailure → FAILURE log row + entityType mapping", () => {
	const projectTenant = {
		project: { organizationId: "org-1", userId: "user-9" },
	};

	function stubEntity(extra: Record<string, unknown> = {}) {
		return {
			title: "Checkout flow",
			externalId: "AB#42",
			externalUrl: "https://dev.azure.com/work/42",
			projectId: "proj-1",
			...projectTenant,
			...extra,
		};
	}

	it("logs status FAILURE, direction push, for a story → STORY with full context", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(
			stubEntity({ externalMcpServerId: null }),
		);

		await recordPmSyncFailure({
			itemId: "story-9",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmCreateError",
			triggerSource: "ai-update",
		});

		expect(mocks.recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "push",
				status: "FAILURE",
				entityType: "STORY",
				entityId: "story-9",
				title: "Checkout flow",
				projectId: "proj-1",
				// org context → userId is null (XOR).
				organizationId: "org-1",
				userId: null,
			}),
		);
	});

	it.each(["epic", "feature"] as const)(
		"legacy %s itemType writes NO row stamp and NO log row (folder tables removed)",
		async (itemType) => {
			await recordPmSyncFailure({
				itemId: `${itemType}-1`,
				itemType,
				errorMessage: "boom",
				errorClass: "PmUpdateError",
				triggerSource: "manual-edit",
			});

			expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
			expect(mocks.recordPmSyncLog).not.toHaveBeenCalled();
		},
	);

	it("maps story → STORY", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(
			stubEntity({ externalMcpServerId: null }),
		);

		await recordPmSyncFailure({
			itemId: "story-1",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmCreateError",
			triggerSource: "retry",
		});

		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "STORY", status: "FAILURE" }),
		);
	});

	it("maps a BUG → STORY (bugs are UserStory rows; never TASK)", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(
			stubEntity({ externalMcpServerId: null }),
		);

		await recordPmSyncFailure({
			itemId: "bug-1",
			itemType: "bug",
			errorMessage: "boom",
			errorClass: "PmCreateError",
			triggerSource: "ai-update",
		});

		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "STORY", status: "FAILURE" }),
		);
	});

	it("derives pmTool from the story's externalMcpServerId (MCPServer.key)", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(
			stubEntity({ externalMcpServerId: "srv-1" }),
		);
		mocks.mcpServerFindUnique.mockResolvedValue({ key: "jira" });

		await recordPmSyncFailure({
			itemId: "story-1",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmCreateError",
			triggerSource: "ai-update",
		});

		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ pmTool: "jira" }),
		);
	});

	it("uses personal tenant (userId set, organizationId null) when the project has no org", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(
			stubEntity({
				project: { organizationId: null, userId: "user-9" },
				externalMcpServerId: null,
			}),
		);

		await recordPmSyncFailure({
			itemId: "story-1",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmCreateError",
			triggerSource: "ai-update",
		});

		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null, userId: "user-9" }),
		);
	});

	it("emits no row when the synced item no longer exists", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(null);

		await recordPmSyncFailure({
			itemId: "gone-1",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmCreateError",
			triggerSource: "ai-update",
		});

		expect(mocks.recordPmSyncLog).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Site 4 — Pull drift
// =============================================================================
//
// The pull-drift `recordPmSyncLog` injection site moved out of
// `reconcileAdoStates` and into the poll's FETCH activity (#1741): the full
// card `title`/`description` needed to hash-compare content must not cross the
// activity boundary, so `detectContentDrift` now runs inside
// `fetchAdoWorkItemStates` (via `buildPollVerdict`). The CALL CONTRACT for that
// pull-drift log (direction "pull", status CONFLICT, reason ado-content-drift,
// pmTool, org/user XOR, actorUserId null, first-detection-only) is asserted
// against the fetch path in
// `packages/temporal/__tests__/pm-state-poll.test.ts`
// (describe: "fetchAdoWorkItemStates — content drift (moved from reconcile,
// #1741)"). `reconcileAdoStates` no longer emits pull-drift logs, so there is
// no reconcile-side wiring left to assert here.
