/**
 * Unit tests for `syncGitLabStoryViaRest` — the REST-fallback per-story
 * push/pull/self-heal routine that `syncStoryToPM` delegates to when no
 * `mcpConfigId` is pinned (GitLab REST fallback projects).
 *
 * Mocks the source resolver, the REST dispatcher, and the database layer so
 * the routine's branching (push create vs update, pull self-heal, source
 * resolution failure) can be exercised without a live GitLab or Postgres.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolvePmSource, PMSourceNotFound } = vi.hoisted(() => {
	class PMSourceNotFound extends Error {
		constructor(public reason: string) {
			super(`PM source not resolvable: ${reason}`);
			this.name = "PMSourceNotFound";
		}
	}
	return { resolvePmSource: vi.fn(), PMSourceNotFound };
});

const { callPmToolWithFallback } = vi.hoisted(() => ({
	callPmToolWithFallback: vi.fn(),
}));

const {
	getStoryById,
	updateStory,
	findManyStatuses,
	projectFindUnique,
	isProjectReadOnly,
	userStoryUpdateMany,
} = vi.hoisted(() => ({
	getStoryById: vi.fn(),
	updateStory: vi.fn(),
	findManyStatuses: vi.fn(),
	projectFindUnique: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	userStoryUpdateMany: vi.fn(),
}));

// #1360 Task 7: the REST pull wiring statically imports
// `reconcileStoryTerminalStatus` from `./reconcile-story-terminal-status`.
// Mock it so we can (a) assert the normalized `item` it receives (proving
// state→raw→normalize threading) and (b) make it throw to prove the
// reconcile is non-fatal. `normalizePolledState` runs for real (not mocked)
// so the test exercises the actual state→isClosed mapping.
const { reconcileStoryTerminalStatus } = vi.hoisted(() => ({
	reconcileStoryTerminalStatus: vi.fn(),
}));

const { recordPmSyncLog } = vi.hoisted(() => ({ recordPmSyncLog: vi.fn() }));

const { getPmSyncBaseline, stampPmSyncConflict, stampPmSyncSuccess } =
	vi.hoisted(() => ({
		getPmSyncBaseline: vi.fn(),
		stampPmSyncConflict: vi.fn(),
		stampPmSyncSuccess: vi.fn(),
	}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));
// This suite's import graph (via `@repo/database` / `./story-sync`) loads
// `@repo/rag`, whose vector-store module constructs a QdrantClient at import.
// Its async server-version probe then prints "Failed to obtain server
// version…" to stderr whenever no Qdrant is running — intermittently, since it
// races the run. Nothing here touches a vector store, so keep the real client
// and only turn that probe off.
vi.mock("@qdrant/js-client-rest", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@qdrant/js-client-rest")>();
	class QdrantClientWithoutVersionProbe extends actual.QdrantClient {
		constructor(
			args: ConstructorParameters<typeof actual.QdrantClient>[0] = {},
		) {
			super({ ...args, checkCompatibility: false });
		}
	}
	return { ...actual, QdrantClient: QdrantClientWithoutVersionProbe };
});
vi.mock("../pm-source", () => ({ resolvePmSource, PMSourceNotFound }));
vi.mock("../pm-tool-fallback", () => ({ callPmToolWithFallback }));
// Mock the audit-log writer so we can assert on it without a real DB write
// (the real `recordPmSyncLog` calls `createPmSyncLog` → @repo/database).
vi.mock("../pm-integration/record-pm-sync-log", () => ({ recordPmSyncLog }));
// Mock the conflict-guard helpers borrowed from the MCP hierarchy-sync path so
// tests don't need a real Prisma client for the baseline/stamp/conflict writes.
vi.mock("../pm-integration/hierarchy-sync", () => ({
	getPmSyncBaseline,
	stampPmSyncConflict,
	stampPmSyncSuccess,
}));
// #1360 Task 7: mock the leaf reconcile module so the REST pull wiring's call
// is observable / throwable without a real DB write.
vi.mock("../pm-integration/reconcile-story-terminal-status", () => ({
	reconcileStoryTerminalStatus,
}));
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		getStoryById,
		updateStory,
		formatBackLinkForProvider: (desc: string) => desc,
		// Read-only gate — deterministic stub so the push branch's
		// early check doesn't attempt a real DB lookup (which would fail-open).
		isProjectReadOnly,
		db: {
			...actual.db,
			projectStoryStatus: { findMany: findManyStatuses },
			project: { findUnique: projectFindUnique },
			// The §4.5 base stamp (Fizzy #2304) — a compare-and-set.
			userStory: { updateMany: userStoryUpdateMany },
		},
	};
});

import {
	computeLabelDeltaOnPush,
	decidePmStatusSync,
	PM_STATUS_SYNC_SENTINEL,
	resolveMappedStatus,
	toResolvedTicketStatus,
} from "@repo/integrations/pm";
import { logger } from "@repo/logs";
import { syncGitLabStoryViaRest } from "../pm-integration/gitlab-rest-story-sync";
// The real status-sync leaf, for the create → poll trace. With a
// `fabric-ahead` outcome it issues no database call at all.
import { reconcileStoryMappedStatus } from "../pm-integration/reconcile-story-mapped-status";
import { syncStoryToPM } from "../pm-integration/story-sync";

const REST_SOURCE = {
	kind: "rest-gitlab" as const,
	token: "TOK",
	baseUrl: "https://gitlab.com/api/v4",
	projectId: "100",
};

function baseStory(overrides: Record<string, unknown> = {}) {
	return {
		id: "story-1",
		projectId: "proj-1",
		identifier: "F-001",
		title: "My Feature",
		description: "Body",
		acceptanceCriteria: null,
		releaseNotes: null,
		priority: null,
		size: null,
		storyPoints: null,
		labels: [],
		statusId: "status-todo",
		lastSyncedStatusId: null,
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		pmStatusSyncBaseId: null,
		pmStatusSyncBaseAt: null,
		pmStatusSyncBaseLink: null,
		pmStatusSyncBaseFabricId: null,
		...overrides,
	};
}

function baseInput(overrides: Record<string, unknown> = {}) {
	return {
		storyId: "story-1",
		projectId: "proj-1",
		mcpConfigId: null,
		mcpServerId: "server-1",
		containerId: "100",
		direction: "push" as const,
		userId: "user-1",
		organizationId: "org-1",
		additionalContext: {},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// clearAllMocks keeps implementations, so re-assert the read-only default
	// each test — otherwise a per-test `mockResolvedValue(true)` would leak.
	isProjectReadOnly.mockResolvedValue(false);
	resolvePmSource.mockResolvedValue(REST_SOURCE);
	findManyStatuses.mockResolvedValue([]);
	updateStory.mockResolvedValue(undefined);
	userStoryUpdateMany.mockResolvedValue({ count: 1 });
	recordPmSyncLog.mockResolvedValue(undefined);
	// Default baseline = null so existing tests (which don't care about the
	// conflict guard) skip it and proceed to the push. Conflict-specific tests
	// override this per-case.
	getPmSyncBaseline.mockResolvedValue(null);
	stampPmSyncConflict.mockResolvedValue(undefined);
	stampPmSyncSuccess.mockResolvedValue(undefined);
	// #1360 Task 7 reconcile-wiring defaults. Existing tests don't engage the
	// reconcile assertions, so a benign project config + no-op reconcile keeps
	// them green while the new tests override per-case.
	projectFindUnique.mockResolvedValue({
		pmTerminalStatuses: [],
		pmAutoCloseEnabled: false,
		organizationId: "org-1",
		userId: null,
	});
	reconcileStoryTerminalStatus.mockResolvedValue({
		terminalApplied: false,
		action: "non-terminal-passthrough",
		pendingChangesCreated: 0,
		terminalStatusLabel: null,
	});
});

describe("syncGitLabStoryViaRest", () => {
	it("push with no externalId creates the item and stamps the link", async () => {
		getStoryById.mockResolvedValue(baseStory());
		callPmToolWithFallback.mockResolvedValue({
			externalId: "42",
			externalUrl: "https://gitlab.com/group/proj/-/issues/42",
			title: "My Feature",
		});

		const result = await syncGitLabStoryViaRest(baseInput());

		expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
		const call = callPmToolWithFallback.mock.calls[0]![0];
		expect(call.call.tool).toBe("createItem");
		expect(call.source.kind).toBe("rest-gitlab");

		expect(updateStory).toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			{
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
			},
			{ lastEditedSource: "PM_PULL" },
		);

		expect(result.success).toBe(true);
		expect(result.externalId).toBe("42");
		expect(result.externalUrl).toBe(
			"https://gitlab.com/group/proj/-/issues/42",
		);
		expect(result.direction).toBe("push");

		// A SUCCESS row is recorded so the GitLab REST push shows up in Sync
		// History (tagged "gitlab", capturing the freshly-created external id).
		expect(recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "push",
				status: "SUCCESS",
				pmTool: "gitlab",
				entityType: "STORY",
				entityId: "story-1",
				externalId: "42",
				projectId: "proj-1",
			}),
		);
	});

	it("Read-only mode blocks the push before any GitLab upload or write", async () => {
		isProjectReadOnly.mockResolvedValueOnce(true);
		getStoryById.mockResolvedValue(baseStory());

		const result = await syncGitLabStoryViaRest(baseInput());

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/read-only/i);
		expect(result.direction).toBe("push");
		// The gate sits ahead of the /uploads POSTs and the issue create/update
		// — nothing external is dispatched.
		expect(callPmToolWithFallback).not.toHaveBeenCalled();
		expect(updateStory).not.toHaveBeenCalled();
	});

	it("does NOT consult the read-only gate on a pull (reads stay allowed)", async () => {
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
			}),
		);
		callPmToolWithFallback.mockResolvedValue({
			externalId: "42",
			externalUrl: "https://gitlab.com/group/proj/-/issues/42",
			title: "My Feature",
			description: "body",
			labels: [],
		});

		const result = await syncGitLabStoryViaRest(
			baseInput({ direction: "pull" }),
		);

		// The gate lives in the push branch only, so a pull never even checks
		// read-only — GitLab is read from regardless of the mode.
		expect(result.direction).toBe("pull");
		expect(isProjectReadOnly).not.toHaveBeenCalled();
		expect(callPmToolWithFallback).toHaveBeenCalled();
	});

	it("records a FAILURE log with PM_TOOL_MISMATCH (no remote call) when linked to another server", async () => {
		getStoryById.mockResolvedValue(
			baseStory({ externalMcpServerId: "a-different-server" }),
		);

		const result = await syncGitLabStoryViaRest(baseInput());

		expect(result.success).toBe(false);
		expect(result.errorCode).toBe("PM_TOOL_MISMATCH");
		expect(callPmToolWithFallback).not.toHaveBeenCalled();
		expect(recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FAILURE",
				pmTool: "gitlab",
				entityId: "story-1",
				errorPayload: expect.objectContaining({
					errorCode: "PM_TOOL_MISMATCH",
				}),
			}),
		);
	});

	it("push with existing externalId updates that item", async () => {
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
			}),
		);
		callPmToolWithFallback.mockResolvedValue({
			externalId: "42",
			externalUrl: "https://gitlab.com/group/proj/-/issues/42",
			title: "My Feature",
		});

		const result = await syncGitLabStoryViaRest(baseInput());

		expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
		const call = callPmToolWithFallback.mock.calls[0]![0];
		expect(call.call.tool).toBe("updateItem");
		expect(call.call.externalId).toBe("42");
		expect(result.success).toBe(true);
	});

	it("push on a status transition sends add_labels/remove_labels deltas, not a full-replace labels array", async () => {
		// Story is moving from statusId-1 → statusId-2. The pre-existing labels
		// include the to-be-removed status label and an unrelated user label.
		// The fix must send addLabels: ["status:done"] AND
		// removeLabels: ["status:in-progress"] via GitLab's delta parameters,
		// and must NOT send a full-replace `labels` array (which would clobber
		// any labels added on the GitLab side between pushes).
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
				statusId: "statusId-2",
				lastSyncedStatusId: "statusId-1",
				labels: ["status:in-progress", "feature"],
			}),
		);
		callPmToolWithFallback.mockResolvedValue({
			externalId: "42",
			externalUrl: "https://gitlab.com/group/proj/-/issues/42",
			title: "My Feature",
		});

		const result = await syncGitLabStoryViaRest(
			baseInput({
				additionalContext: {
					labelStatusMap: {
						"status:in-progress": "statusId-1",
						"status:done": "statusId-2",
					},
				},
			}),
		);

		expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
		const call = callPmToolWithFallback.mock.calls[0]![0];
		expect(call.call.tool).toBe("updateItem");
		expect(call.call.externalId).toBe("42");

		const payload = call.call.payload as Record<string, unknown>;
		expect(payload.addLabels).toEqual(["status:done"]);
		expect(payload.removeLabels).toEqual(["status:in-progress"]);
		expect(payload).not.toHaveProperty("labels");

		expect(result.success).toBe(true);
	});

	// #1360: three-rule pull not-found contract. A not-found on a STAMPED link
	// (externalMcpServerId set) PRESERVES it — deletion is owned by the
	// scheduled poll's source-scoped streak + human Accept. A not-found on a
	// NULL-provenance (legacy) link still self-heals, because the poll's
	// reconcileMissingTickets can never flag a null-provenance row.
	it("pull not-found on a STAMPED link preserves it (no unlink, linkPreserved:true)", async () => {
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
			}),
		);
		callPmToolWithFallback.mockRejectedValue(new Error("404 Not Found"));

		const result = await syncGitLabStoryViaRest(
			baseInput({ direction: "pull" }),
		);

		// The stamped link must NOT be cleared.
		expect(updateStory).not.toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			expect.objectContaining({ externalId: null }),
		);
		expect(result.success).toBe(false);
		expect(result.errorCode).toBe("EXTERNAL_ID_NOT_FOUND");
		expect(result.linkPreserved).toBe(true);
		expect(recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				status: "FAILURE",
				pmTool: "gitlab",
				errorPayload: expect.objectContaining({
					errorCode: "EXTERNAL_ID_NOT_FOUND",
				}),
			}),
		);
	});

	it("pull not-found on a NULL-PROVENANCE (legacy) link clears the link and self-heals", async () => {
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: null,
			}),
		);
		callPmToolWithFallback.mockRejectedValue(new Error("404 Not Found"));

		const result = await syncGitLabStoryViaRest(
			baseInput({ direction: "pull" }),
		);

		expect(updateStory).toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			{
				externalId: null,
				externalUrl: null,
				externalMcpServerId: null,
			},
			{ lastEditedSource: "PM_PULL" },
		);
		expect(result.success).toBe(false);
		expect(result.errorCode).toBe("EXTERNAL_ID_NOT_FOUND");
		expect(result.linkPreserved).toBeFalsy();
		expect(recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				status: "FAILURE",
				pmTool: "gitlab",
				errorPayload: expect.objectContaining({
					errorCode: "EXTERNAL_ID_NOT_FOUND",
				}),
			}),
		);
	});

	it("pull where fetchItem throws a transient error preserves the link", async () => {
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
			}),
		);
		callPmToolWithFallback.mockRejectedValue(
			new Error("500 Internal Server Error"),
		);

		const result = await syncGitLabStoryViaRest(
			baseInput({ direction: "pull" }),
		);

		// The link must NOT be cleared on a transient failure.
		expect(updateStory).not.toHaveBeenCalledWith("story-1", "proj-1", {
			externalId: null,
			externalUrl: null,
			externalMcpServerId: null,
		});
		expect(result.success).toBe(false);
		expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
		// Transient failure still records a FAILURE row (preserves the link).
		expect(recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILURE", pmTool: "gitlab" }),
		);
	});

	// #1360 Task 7: after a successful REST content pull, the routine runs the
	// STORY terminal-status reconcile using the issue `state` the fetch adapter
	// returns — threaded through the local FetchResult, into summary.raw, and
	// normalized by the real `normalizePolledState({ kind: "rest-gitlab" })`.
	it("pull of a closed GitLab issue runs the terminal-status reconcile (state→isClosed:true → auto-hidden)", async () => {
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
				draftingStage: "DRAFT",
				pmAutoHidden: false,
			}),
		);
		projectFindUnique.mockResolvedValue({
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: true,
			organizationId: "org-1",
			userId: null,
		});
		reconcileStoryTerminalStatus.mockResolvedValue({
			terminalApplied: true,
			action: "auto-hidden",
			pendingChangesCreated: 0,
			terminalStatusLabel: "closed",
		});
		// The fetch adapter returns the native GitLab issue state alongside the
		// content fields. "closed" is the terminal signal.
		callPmToolWithFallback.mockResolvedValueOnce({
			title: "Pulled Title",
			description: "Pulled Body",
			externalUrl: "https://gitlab.com/group/proj/-/issues/42",
			labels: ["bug"],
			state: "closed",
		});

		const result = await syncGitLabStoryViaRest(
			baseInput({ direction: "pull" }),
		);

		expect(result.success).toBe(true);
		expect(reconcileStoryTerminalStatus).toHaveBeenCalledTimes(1);
		const reconcileArg = reconcileStoryTerminalStatus.mock.calls[0]![0];
		// Proves state→raw→normalize: rest-gitlab normalize maps state "closed"
		// → item.isClosed:true (and statusString stays null for GitLab).
		expect(reconcileArg.item.isClosed).toBe(true);
		expect(reconcileArg.item.labels).toEqual(["bug"]);
		expect(reconcileArg.autoCloseEnabled).toBe(true);
		expect(reconcileArg.fabricItem).toMatchObject({
			entityType: "STORY",
			entityId: "story-1",
			draftingStage: "DRAFT",
			pmAutoHidden: false,
		});
		// Default terminal set (project has none configured) is the lowercase
		// ["Closed","Done","Removed"] fallback.
		expect(reconcileArg.terminalLc.has("closed")).toBe(true);
		expect(reconcileArg.terminalLc.has("done")).toBe(true);
		expect(reconcileArg.terminalLc.has("removed")).toBe(true);
		// Lifecycle fields are threaded into the success return.
		expect(result.terminalApplied).toBe(true);
		expect(result.lifecycleAction).toBe("auto-hidden");
		expect(result.lifecycleReconciled).toBe(true);
		expect(result.terminalStatusLabel).toBe("closed");
	});

	it("reconcile failure is non-fatal — the REST content pull still succeeds", async () => {
		getStoryById.mockResolvedValue(
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
				draftingStage: "DRAFT",
				pmAutoHidden: false,
			}),
		);
		projectFindUnique.mockResolvedValue({
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: true,
			organizationId: "org-1",
			userId: null,
		});
		reconcileStoryTerminalStatus.mockRejectedValue(
			new Error("DB blew up during reconcile"),
		);
		callPmToolWithFallback.mockResolvedValueOnce({
			title: "Pulled Title",
			description: "Pulled Body",
			externalUrl: "https://gitlab.com/group/proj/-/issues/42",
			labels: [],
			state: "closed",
		});

		const result = await syncGitLabStoryViaRest(
			baseInput({ direction: "pull" }),
		);

		// The thrown reconcile must NOT fail the content pull.
		expect(result.success).toBe(true);
		expect(result.lifecycleReconciled).toBe(false);
		// Content was still pulled + stamped.
		expect(stampPmSyncSuccess).toHaveBeenCalledWith(
			expect.objectContaining({
				itemType: "story",
				itemId: "story-1",
			}),
		);
	});

	it("returns a UI-friendly failure (no throw) when source resolution fails", async () => {
		resolvePmSource.mockRejectedValue(
			new PMSourceNotFound("no-integration"),
		);
		getStoryById.mockResolvedValue(baseStory());

		const result = await syncGitLabStoryViaRest(baseInput());

		expect(result.success).toBe(false);
		expect(callPmToolWithFallback).not.toHaveBeenCalled();
		// Source resolution fails BEFORE the story is loaded — no item context to
		// log against, so no PmSyncLog row is written for the not-connected case.
		expect(recordPmSyncLog).not.toHaveBeenCalled();
	});

	describe("push-time conflict guard", () => {
		const linkedStory = () =>
			baseStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				externalMcpServerId: "server-1",
			});

		it("detects a conflict when the live GitLab issue has drifted from the stamped baseline", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			getPmSyncBaseline.mockResolvedValue("baseline-hash-from-last-sync");
			// First (and only) fallback call is the conflict-guard fetch — it
			// returns a GitLab issue whose content hashes to something OTHER than
			// the stamped baseline, so the guard short-circuits BEFORE the update.
			callPmToolWithFallback.mockResolvedValueOnce({
				title: "Edited in GitLab",
				description: "Someone touched this on the PM side",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				labels: [],
			});

			const result = await syncGitLabStoryViaRest(baseInput());

			expect(result.success).toBe(false);
			expect(stampPmSyncConflict).toHaveBeenCalledWith(
				"story",
				"story-1",
			);
			// The actual updateItem call must NOT have happened — only the guard
			// fetch fired.
			expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
			expect(callPmToolWithFallback.mock.calls[0]![0].call.tool).toBe(
				"fetchItem",
			);
			expect(recordPmSyncLog).toHaveBeenCalledWith(
				expect.objectContaining({
					direction: "push",
					status: "CONFLICT",
					pmTool: "gitlab",
					entityType: "STORY",
					entityId: "story-1",
					errorPayload: expect.objectContaining({
						reason: "push-time-hash-drift",
					}),
				}),
			);
			// No SUCCESS stamp on a conflict — baseline stays at the pre-drift
			// value so the next attempt also sees the conflict until resolved.
			expect(stampPmSyncSuccess).not.toHaveBeenCalled();
		});

		it("proceeds with the push when the live GitLab content matches the stamped baseline", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			// computePmHash("Body", null) — the test story has description="Body",
			// and buildStoryDescription wraps it. To make the test deterministic,
			// rely on the helper exposing computePmHash via the production code:
			// instead of recomputing, we stub the baseline to MATCH whatever the
			// live PM returns by faking baseline === computePmHash(live content).
			// Easiest: stub baseline to the exact hash the guard will compute.
			const { computePmHash } = await import(
				"../pm-integration/pm-sync-hash"
			);
			const liveTitle = "My Feature";
			const liveDescription = "Body";
			const matchingBaseline = computePmHash(liveTitle, liveDescription);
			getPmSyncBaseline.mockResolvedValue(matchingBaseline);
			callPmToolWithFallback
				.mockResolvedValueOnce({
					title: liveTitle,
					description: liveDescription,
					externalUrl: "https://gitlab.com/group/proj/-/issues/42",
					labels: [],
				})
				.mockResolvedValueOnce({
					externalId: "42",
					externalUrl: "https://gitlab.com/group/proj/-/issues/42",
					title: liveTitle,
				});

			const result = await syncGitLabStoryViaRest(baseInput());

			expect(result.success).toBe(true);
			expect(stampPmSyncConflict).not.toHaveBeenCalled();
			// Two calls: guard fetch + the actual updateItem.
			expect(callPmToolWithFallback).toHaveBeenCalledTimes(2);
			expect(callPmToolWithFallback.mock.calls[0]![0].call.tool).toBe(
				"fetchItem",
			);
			expect(callPmToolWithFallback.mock.calls[1]![0].call.tool).toBe(
				"updateItem",
			);
			// Success stamps a fresh baseline.
			expect(stampPmSyncSuccess).toHaveBeenCalledWith(
				expect.objectContaining({
					itemType: "story",
					itemId: "story-1",
				}),
			);
		});

		it("skips the conflict guard entirely when forceHashOverride is set", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			getPmSyncBaseline.mockResolvedValue("any-baseline");
			callPmToolWithFallback.mockResolvedValueOnce({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				title: "My Feature",
			});

			const result = await syncGitLabStoryViaRest(
				baseInput({ forceHashOverride: true }),
			);

			expect(result.success).toBe(true);
			// The guard never fetched — only the update fired.
			expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
			expect(callPmToolWithFallback.mock.calls[0]![0].call.tool).toBe(
				"updateItem",
			);
			expect(getPmSyncBaseline).not.toHaveBeenCalled();
			expect(stampPmSyncConflict).not.toHaveBeenCalled();
			// Force-override still stamps a fresh baseline on success.
			expect(stampPmSyncSuccess).toHaveBeenCalled();
		});

		it("skips the conflict guard when no baseline exists (first-ever sync)", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			getPmSyncBaseline.mockResolvedValue(null);
			callPmToolWithFallback.mockResolvedValueOnce({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				title: "My Feature",
			});

			const result = await syncGitLabStoryViaRest(baseInput());

			expect(result.success).toBe(true);
			// Only the update fired — guard skipped because baseline was null.
			expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
			expect(callPmToolWithFallback.mock.calls[0]![0].call.tool).toBe(
				"updateItem",
			);
			expect(stampPmSyncConflict).not.toHaveBeenCalled();
		});

		it("falls back to push when the guard fetch fails (does not block on transient errors)", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			getPmSyncBaseline.mockResolvedValue("any-baseline");
			// First call (guard fetch) throws; second call (updateItem) succeeds.
			callPmToolWithFallback
				.mockRejectedValueOnce(new Error("500 Internal Server Error"))
				.mockResolvedValueOnce({
					externalId: "42",
					externalUrl: "https://gitlab.com/group/proj/-/issues/42",
					title: "My Feature",
				});

			const result = await syncGitLabStoryViaRest(baseInput());

			expect(result.success).toBe(true);
			expect(stampPmSyncConflict).not.toHaveBeenCalled();
			expect(callPmToolWithFallback).toHaveBeenCalledTimes(2);
			expect(callPmToolWithFallback.mock.calls[1]![0].call.tool).toBe(
				"updateItem",
			);
		});

		it("create path does not trigger the conflict guard (nothing to compare against)", async () => {
			getStoryById.mockResolvedValue(baseStory());
			callPmToolWithFallback.mockResolvedValue({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				title: "My Feature",
			});

			const result = await syncGitLabStoryViaRest(baseInput());

			expect(result.success).toBe(true);
			expect(getPmSyncBaseline).not.toHaveBeenCalled();
			expect(stampPmSyncConflict).not.toHaveBeenCalled();
			// The create still stamps a baseline so subsequent pushes engage the
			// guard.
			expect(stampPmSyncSuccess).toHaveBeenCalled();
		});

		it("pull stamps the baseline against the content received from GitLab", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			callPmToolWithFallback.mockResolvedValueOnce({
				title: "Pulled Title",
				description: "Pulled Body",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				labels: [],
			});

			const result = await syncGitLabStoryViaRest(
				baseInput({ direction: "pull" }),
			);

			expect(result.success).toBe(true);
			expect(stampPmSyncSuccess).toHaveBeenCalledWith(
				expect.objectContaining({
					itemType: "story",
					itemId: "story-1",
					title: "Pulled Title",
					description: "Pulled Body",
				}),
			);
		});
	});

	describe("status-sync switch on (Fizzy #2304 §4.5)", () => {
		const K =
			"https://gitlab.com/example-group/example-project/-/issues/42";
		const T0 = new Date("2026-09-18T09:00:00.000Z");
		const UPDATED_AT = "2026-09-21T09:15:42.120Z";
		const LABEL_MAP = {
			"workflow::todo": "st-todo",
			"workflow::in-review": "st-progress",
			"workflow::done": "st-done",
			// Mapped to a status this project no longer has: never removed.
			"workflow::archived": "st-retired",
		};
		const PROJECT_ROW = {
			id: "proj-1",
			pmStatusSyncEnabled: true,
			// The STORED map the gate resolves with (R20) — the same one the
			// poll reads. Equal to the callers' snapshot unless a test says so.
			projectManagementAdditionalContext: { labelStatusMap: LABEL_MAP },
			syncAttachments: false,
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: false,
			organizationId: "org-1",
			userId: null,
		};
		const STATUS_ROWS = [
			{ id: "st-todo", name: "To Do", projectId: "proj-1" },
			{ id: "st-progress", name: "In Progress", projectId: "proj-1" },
			{ id: "st-done", name: "Done", projectId: "proj-1" },
			// A valid status with no mapped label (the __none__ case).
			{ id: "st-backlog", name: "Backlog", projectId: "proj-1" },
		];

		/**
		 * Reads-only `select` projection (pattern:
		 * publishing-shared/__tests__/contributor-names.test.ts:144-155). A
		 * dropped `pmStatusSyncEnabled` reads as a missing key, never as a
		 * silent `undefined` from a canned row.
		 */
		function selectFrom(
			row: Record<string, unknown>,
			select: Record<string, unknown> | undefined,
		): Record<string, unknown> {
			if (!select) {
				return { ...row };
			}
			const out: Record<string, unknown> = {};
			for (const [key, wanted] of Object.entries(select)) {
				if (wanted !== true) {
					continue;
				}
				if (!(key in row)) {
					throw new Error(
						`fake db: fixture row has no field "${key}"`,
					);
				}
				out[key] = row[key];
			}
			return out;
		}

		function useProject(row: Record<string, unknown>) {
			projectFindUnique.mockImplementation(
				async (args: {
					where: { id: string };
					select?: Record<string, unknown>;
				}) =>
					args.where.id === row.id
						? selectFrom(row, args.select)
						: null,
			);
		}

		/**
		 * Linked, Fabric moved to In Progress; the base still says To Do @ T0,
		 * observed while Fabric showed To Do (F = To Do).
		 */
		function linkedStory(overrides: Record<string, unknown> = {}) {
			return baseStory({
				externalId: "42",
				externalUrl: K,
				externalMcpServerId: "server-1",
				statusId: "st-progress",
				labels: ["customer-facing"],
				pmStatusSyncBaseId: "st-todo",
				pmStatusSyncBaseAt: T0,
				pmStatusSyncBaseLink: K,
				pmStatusSyncBaseFabricId: "st-todo",
				...overrides,
			});
		}

		const CREATED_URL =
			"https://gitlab.com/example-group/example-project/-/issues/43";
		const CREATED_AT = "2026-09-21T10:02:07.311Z";

		/** Routes the REST dispatcher for a create: issue 43 is born at `updatedAt`. */
		function routeGitLabCreate(opts: {
			updatedAt: string | null;
			rereadUpdatedAt?: string;
			/** The created issue's `web_url`; defaults to CREATED_URL. */
			externalUrl?: string | null;
		}) {
			callPmToolWithFallback.mockImplementation(
				async ({ call }: { call: { tool: string } }) => {
					if (call.tool === "createItem") {
						return {
							externalId: "43",
							externalUrl:
								opts.externalUrl === undefined
									? CREATED_URL
									: opts.externalUrl,
							title: "My Feature",
							updatedAt: opts.updatedAt,
						};
					}
					if (call.tool === "fetchItem") {
						return {
							title: "My Feature",
							description: "Body",
							externalUrl: CREATED_URL,
							labels: [],
							state: "opened",
							updatedAt: opts.rereadUpdatedAt,
						};
					}
					throw new Error(`unexpected REST tool ${call.tool}`);
				},
			);
		}

		function createPayload(): { labels: string[] } & Record<
			string,
			unknown
		> {
			const call = callPmToolWithFallback.mock.calls.find(
				(c) => c[0].call.tool === "createItem",
			);
			if (!call) {
				throw new Error("no createItem call was dispatched");
			}
			return call[0].call.payload as { labels: string[] } & Record<
				string,
				unknown
			>;
		}

		/** Routes the REST dispatcher the way GitLab would for issue 42. */
		function routeGitLab(opts: {
			liveLabels: string[];
			liveFails?: boolean;
			update?: { updatedAt: string | null } | Error;
			rereadUpdatedAt?: string;
		}) {
			let reads = 0;
			callPmToolWithFallback.mockImplementation(
				async ({ call }: { call: { tool: string } }) => {
					if (call.tool === "fetchItem") {
						reads++;
						if (reads === 1 && opts.liveFails) {
							throw new Error("502 Bad Gateway");
						}
						return {
							title: "My Feature",
							description: "Body",
							externalUrl: K,
							labels: opts.liveLabels,
							state: "opened",
							updatedAt:
								reads === 1
									? "2026-09-18T09:00:00.000Z"
									: opts.rereadUpdatedAt,
						};
					}
					if (call.tool === "updateItem") {
						if (opts.update instanceof Error) {
							throw opts.update;
						}
						return {
							externalId: "42",
							externalUrl: K,
							title: "My Feature",
							updatedAt:
								opts.update === undefined
									? UPDATED_AT
									: opts.update.updatedAt,
						};
					}
					throw new Error(`unexpected REST tool ${call.tool}`);
				},
			);
		}

		/**
		 * Routes the REST dispatcher to a STATEFUL issue 42, applying an update's
		 * `addLabels`/`removeLabels` the way GitLab does (removing an absent label
		 * is a no-op; adding a present one is too). `beforeWrite` runs when the
		 * PUT arrives, before GitLab applies it: a PM user's edit that lands
		 * between the push's live read and its write. GitLab has no conditional
		 * issue update, so nothing on the wire can refuse the PUT.
		 */
		function routeStatefulGitLab(
			labels: string[],
			beforeWrite?: (issue: { labels: string[] }) => void,
		): { labels: string[] } {
			const issue = { labels: [...labels] };
			callPmToolWithFallback.mockImplementation(
				async ({
					call,
				}: {
					call: {
						tool: string;
						payload?: {
							addLabels: string[];
							removeLabels: string[];
						};
					};
				}) => {
					if (call.tool === "fetchItem") {
						return {
							title: "My Feature",
							description: "Body",
							externalUrl: K,
							labels: [...issue.labels],
							state: "opened",
							updatedAt: "2026-09-18T09:00:00.000Z",
						};
					}
					if (call.tool === "updateItem" && call.payload) {
						beforeWrite?.(issue);
						const removed = new Set(call.payload.removeLabels);
						issue.labels = issue.labels.filter(
							(l) => !removed.has(l),
						);
						for (const label of call.payload.addLabels) {
							if (!issue.labels.includes(label)) {
								issue.labels.push(label);
							}
						}
						return {
							externalId: "42",
							externalUrl: K,
							title: "My Feature",
							updatedAt: UPDATED_AT,
						};
					}
					throw new Error(`unexpected REST tool ${call.tool}`);
				},
			);
			return issue;
		}

		function tools(): string[] {
			return callPmToolWithFallback.mock.calls.map((c) => c[0].call.tool);
		}

		function updatePayload(): Record<string, unknown> {
			const call = callPmToolWithFallback.mock.calls.find(
				(c) => c[0].call.tool === "updateItem",
			);
			if (!call) {
				throw new Error("no updateItem call was dispatched");
			}
			return call[0].call.payload as Record<string, unknown>;
		}

		const ON = { additionalContext: { labelStatusMap: LABEL_MAP } };

		const EXPECTED_STAMP = {
			where: {
				id: "story-1",
				projectId: "proj-1",
				pmStatusSyncBaseId: "st-todo",
				pmStatusSyncBaseAt: T0,
				pmStatusSyncBaseLink: K,
				pmStatusSyncBaseFabricId: "st-todo",
			},
			data: {
				pmStatusSyncBaseId: "st-progress",
				pmStatusSyncBaseAt: new Date(UPDATED_AT),
				pmStatusSyncBaseLink: K,
				pmStatusSyncBaseFabricId: "st-progress",
			},
		};

		/** The create stamp: CAS against the unlinked story's null base. */
		const EXPECTED_CREATE_STAMP = {
			where: {
				id: "story-1",
				projectId: "proj-1",
				pmStatusSyncBaseId: null,
				pmStatusSyncBaseAt: null,
				pmStatusSyncBaseLink: null,
				pmStatusSyncBaseFabricId: null,
			},
			data: {
				pmStatusSyncBaseId: "st-progress",
				pmStatusSyncBaseAt: new Date(CREATED_AT),
				pmStatusSyncBaseLink: CREATED_URL,
				pmStatusSyncBaseFabricId: "st-progress",
			},
		};

		beforeEach(() => {
			useProject(PROJECT_ROW);
			findManyStatuses.mockImplementation(
				async (args: {
					where: { projectId: string };
					select?: Record<string, unknown>;
				}) =>
					STATUS_ROWS.filter(
						(row) => row.projectId === args.where.projectId,
					).map((row) => selectFrom(row, args.select)),
			);
		});

		it("L≠F and R_live=P: reads the live ticket first, replaces the observed mapped label, stamps the base", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::todo", "bug"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			// No baseline → the conflict guard is skipped, yet the live read
			// still ran first: the switch needs R_live.
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			const payload = updatePayload();
			expect(payload.addLabels).toEqual(["workflow::in-review"]);
			// Only the mapped label the live read saw is removed: `workflow::done`
			// is not on the ticket, and `workflow::archived` maps to a status this
			// project lacks.
			expect(payload.removeLabels).toEqual(["workflow::todo"]);
			expect(userStoryUpdateMany).toHaveBeenCalledTimes(1);
			expect(userStoryUpdateMany.mock.calls[0]?.[0]).toEqual(
				EXPECTED_STAMP,
			);
		});

		it("L=F: a content-only push sends no mapped-label change and no stamp", async () => {
			getStoryById.mockResolvedValue(
				linkedStory({ statusId: "st-todo" }),
			);
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			const payload = updatePayload();
			expect(payload.title).toBe("My Feature");
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("no base yet: the labels are left for the poll's first observation, and nothing is stamped", async () => {
			getStoryById.mockResolvedValue(
				linkedStory({
					pmStatusSyncBaseId: null,
					pmStatusSyncBaseAt: null,
					pmStatusSyncBaseLink: null,
					pmStatusSyncBaseFabricId: null,
				}),
			);
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			// Positive control: the switch-on path ran — the live read came first.
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			const payload = updatePayload();
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("P=__none__ observed at Fabric's current status: a content-only push does not re-add the dropped labels (AC12)", async () => {
			// The ticket's workflow label was replaced by one the map does not
			// know; the poll recorded __none__ while Fabric showed In Progress.
			getStoryById.mockResolvedValue(
				linkedStory({
					pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.NONE,
					pmStatusSyncBaseFabricId: "st-progress",
				}),
			);
			routeGitLab({ liveLabels: ["workflow::blocked-upstream", "bug"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			const payload = updatePayload();
			expect(payload.title).toBe("My Feature");
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("R_live≠P: the ticket moved since the last observation → no mapped labels, no stamp (AC12)", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::done"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			const payload = updatePayload();
			expect(payload.title).toBe("My Feature");
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("replaces a stale ticket label even when story.labels already holds the target", async () => {
			const story = linkedStory({
				labels: ["workflow::in-review", "customer-facing"],
				lastSyncedStatusId: null,
			});
			// Today's delta for this story is empty — the defect: the stale
			// todo label would stay and the target would never be added.
			expect(
				computeLabelDeltaOnPush(
					null,
					"st-progress",
					["workflow::in-review", "customer-facing"],
					LABEL_MAP,
				),
			).toEqual({ addLabels: [], removeLabels: [] });
			getStoryById.mockResolvedValue(story);
			routeGitLab({ liveLabels: ["workflow::todo", "customer-facing"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			const payload = updatePayload();
			expect(payload.addLabels).toEqual(["workflow::in-review"]);
			expect(payload.removeLabels).toEqual(["workflow::todo"]);
			expect(userStoryUpdateMany).toHaveBeenCalledTimes(1);
		});

		it("L has no mapped label: removes every valid mapped label the ticket carries and stamps __none__", async () => {
			getStoryById.mockResolvedValue(
				linkedStory({ statusId: "st-backlog" }),
			);
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			const payload = updatePayload();
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual(["workflow::todo"]);
			expect(userStoryUpdateMany.mock.calls[0]?.[0]).toEqual({
				...EXPECTED_STAMP,
				data: {
					...EXPECTED_STAMP.data,
					pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.NONE,
					pmStatusSyncBaseFabricId: "st-backlog",
				},
			});
		});

		it("a mapped label a PM user adds between the gate's read and the write is not stripped: the ticket goes ambiguous for the poll instead of being reverted", async () => {
			const LIVE = ["workflow::todo", "bug"];
			const LABEL_ARGS = {
				addLabels: ["workflow::in-review"],
				removeLabels: ["workflow::todo"],
			};
			getStoryById.mockResolvedValue(linkedStory());

			// Positive control, no interleave: L's label is added, the observed
			// P label removed, and the ticket ends on exactly L.
			const calm = routeStatefulGitLab(LIVE);
			expect((await syncGitLabStoryViaRest(baseInput(ON))).success).toBe(
				true,
			);
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			expect(updatePayload()).toEqual({
				title: "My Feature",
				description: "Body",
				...LABEL_ARGS,
			});
			expect(calm.labels).toEqual(["bug", "workflow::in-review"]);
			expect(userStoryUpdateMany.mock.calls).toEqual([[EXPECTED_STAMP]]);

			// The race: the gate reads the ticket on To Do (= P) and passes; a PM
			// user then moves it to Done before the PUT lands.
			callPmToolWithFallback.mockClear();
			userStoryUpdateMany.mockClear();
			const raced = routeStatefulGitLab(LIVE, (issue) => {
				issue.labels.push("workflow::done");
			});
			expect((await syncGitLabStoryViaRest(baseInput(ON))).success).toBe(
				true,
			);
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			// The same PUT as without the race: nothing the gate did not observe
			// is removed, so the user's Done label is not stripped.
			expect(updatePayload()).toEqual({
				title: "My Feature",
				description: "Body",
				...LABEL_ARGS,
			});
			expect(raced.labels).toEqual([
				"bug",
				"workflow::done",
				"workflow::in-review",
			]);
			// The stamp is unchanged by the race…
			expect(userStoryUpdateMany.mock.calls).toEqual([[EXPECTED_STAMP]]);
			// …and the ticket now resolves ambiguous, so the next poll records
			// that (and raises its CONFLICT) instead of the push having silently
			// reverted the user's move.
			const nextPoll = decidePmStatusSync({
				resolved: toResolvedTicketStatus(
					resolveMappedStatus({
						labels: raced.labels,
						statusString: null,
						labelStatusMap: LABEL_MAP,
						statusColumnMap: {},
						projectStatuses: STATUS_ROWS,
					}),
				),
				fabricStatusId: "st-progress",
				base: {
					baseId: EXPECTED_STAMP.data.pmStatusSyncBaseId,
					baseAt: EXPECTED_STAMP.data.pmStatusSyncBaseAt,
					baseLink: EXPECTED_STAMP.data.pmStatusSyncBaseLink,
					baseFabricId: EXPECTED_STAMP.data.pmStatusSyncBaseFabricId,
				},
				linkKey: K,
				stateChangedDate: new Date("2026-09-21T09:15:43.000Z"),
				pushConflictPending: false,
			});
			expect(nextPoll.outcome).toBe("ambiguous");
		});

		it("removals cover only mapped labels observed on the live ticket, matched exactly as the resolver matches them", async () => {
			// L has no mapped label, so every valid mapped label is a removal
			// candidate. The ticket carries only one of them exactly; the other
			// differs in case, and the resolver's exact-case lookup does not map it.
			expect(
				resolveMappedStatus({
					labels: ["Workflow::Done"],
					statusString: null,
					labelStatusMap: LABEL_MAP,
					statusColumnMap: {},
					projectStatuses: STATUS_ROWS,
				}),
			).toEqual({ kind: "none" });
			getStoryById.mockResolvedValue(
				linkedStory({ statusId: "st-backlog" }),
			);
			const issue = routeStatefulGitLab([
				"workflow::todo",
				"Workflow::Done",
				"bug",
			]);

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			const payload = updatePayload();
			expect(payload.addLabels).toEqual([]);
			// Positive control: the mapped label the gate observed is removed…
			expect(payload.removeLabels).toEqual(["workflow::todo"]);
			// …and the valid mapped labels it did not observe are not, nor is
			// the case variant the resolver treated as unmapped.
			for (const unobserved of [
				"workflow::in-review",
				"workflow::done",
				"Workflow::Done",
			]) {
				expect(payload.removeLabels).not.toContain(unobserved);
			}
			expect(issue.labels).toEqual(["Workflow::Done", "bug"]);
			expect(userStoryUpdateMany.mock.calls).toEqual([
				[
					{
						...EXPECTED_STAMP,
						data: {
							...EXPECTED_STAMP.data,
							pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.NONE,
							pmStatusSyncBaseFabricId: "st-backlog",
						},
					},
				],
			]);
		});

		it("no stamp when the update fails", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({
				liveLabels: ["workflow::todo"],
				update: new Error("500 Internal Server Error"),
			});

			await expect(syncGitLabStoryViaRest(baseInput(ON))).rejects.toThrow(
				"500 Internal Server Error",
			);
			// The gate passed and the write was attempted…
			expect(updatePayload().removeLabels).toEqual(["workflow::todo"]);
			// …but it did not land, so nothing is stamped.
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("no stamp in Read-only mode", async () => {
			isProjectReadOnly.mockResolvedValueOnce(true);
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/read-only/i);
			expect(callPmToolWithFallback).not.toHaveBeenCalled();
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("no stamp on a pull-only sync", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::in-review"] });

			const result = await syncGitLabStoryViaRest(
				baseInput({ ...ON, direction: "pull" }),
			);

			expect(result.success).toBe(true);
			expect(updateStory).toHaveBeenCalled(); // the pull landed
			expect(tools()).toEqual(["fetchItem"]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("stamp race: a base changed since this push's read is kept (CAS count 0)", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::todo"] });
			userStoryUpdateMany.mockResolvedValueOnce({ count: 0 });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			expect(userStoryUpdateMany.mock.calls[0]?.[0]).toEqual(
				EXPECTED_STAMP,
			);
			expect(logger.info).toHaveBeenCalledWith(
				"[GitLab REST Sync] status-sync base changed since this push read it; newer base kept",
				{ storyId: "story-1" },
			);
		});

		it("a failed stamp write is non-fatal", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::todo"] });
			userStoryUpdateMany.mockRejectedValueOnce(
				new Error("connection reset"),
			);

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			expect(logger.warn).toHaveBeenCalledWith(
				"[GitLab REST Sync] status-sync base stamp failed (non-fatal)",
				{ storyId: "story-1", error: "connection reset" },
			);
		});

		it("no updated_at on the write: one re-read supplies the stamp time", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({
				liveLabels: ["workflow::todo"],
				update: { updatedAt: null },
				rereadUpdatedAt: "2026-09-21T09:16:00.000Z",
			});

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			expect(tools()).toEqual(["fetchItem", "updateItem", "fetchItem"]);
			expect(userStoryUpdateMany.mock.calls[0]?.[0]).toEqual({
				...EXPECTED_STAMP,
				data: {
					...EXPECTED_STAMP.data,
					pmStatusSyncBaseAt: new Date("2026-09-21T09:16:00.000Z"),
				},
			});
		});

		it("no updated_at anywhere: no stamp (a null clock would disable the stale check)", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({
				liveLabels: ["workflow::todo"],
				update: { updatedAt: null },
			});

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			expect(tools()).toEqual(["fetchItem", "updateItem", "fetchItem"]);
			expect(logger.warn).toHaveBeenCalledWith(
				"[GitLab REST Sync] GitLab returned no updated_at; status-sync base not stamped",
				{ storyId: "story-1", externalId: "42" },
			);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("live read fails: content still pushes, no mapped labels, no stamp", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::todo"], liveFails: true });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			const payload = updatePayload();
			expect(payload.title).toBe("My Feature");
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("the conflict guard's live read is the gate's read: one fetch per push", async () => {
			const { computePmHash } = await import(
				"../pm-integration/pm-sync-hash"
			);
			getStoryById.mockResolvedValue(linkedStory());
			// The live issue matches the stamped content baseline, so the guard
			// lets the push through — and hands its read to the gate.
			getPmSyncBaseline.mockResolvedValue(
				computePmHash("My Feature", "Body"),
			);
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			expect(getPmSyncBaseline).toHaveBeenCalledTimes(1);
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			expect(updatePayload().addLabels).toEqual(["workflow::in-review"]);
			expect(userStoryUpdateMany.mock.calls).toEqual([[EXPECTED_STAMP]]);
		});

		it("a failed guard read is not retried for the gate: content pushes, no mapped labels, no stamp", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			getPmSyncBaseline.mockResolvedValue("any-baseline");
			routeGitLab({ liveLabels: ["workflow::todo"], liveFails: true });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			// Positive control: the guard ran its read (and it failed)…
			expect(getPmSyncBaseline).toHaveBeenCalledTimes(1);
			// …and no second read followed it.
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			const payload = updatePayload();
			expect(payload.title).toBe("My Feature");
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("the ticket dropped its mapped label (R_live = none, P a status): no revert, no stamp", async () => {
			// L ≠ F, but the ticket moved too: its workflow label was replaced
			// by one the map does not know. Re-adding a mapped label here would
			// undo that ticket-side move.
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::blocked-upstream", "bug"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			// Positive control: the switch-on path read the live ticket.
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			const payload = updatePayload();
			expect(payload.title).toBe("My Feature");
			expect(payload.addLabels).toEqual([]);
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("P=__none__ and Fabric moved since (L≠F) while the ticket still has no mapped label: labels replaced, stamped", async () => {
			// Sentinel-aware R_live ≡ P: a no-status live ticket equals a
			// `__none__` observation, so this is a Fabric-only move.
			getStoryById.mockResolvedValue(
				linkedStory({
					pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.NONE,
				}),
			);
			routeGitLab({ liveLabels: ["workflow::blocked-upstream", "bug"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			const payload = updatePayload();
			expect(payload.addLabels).toEqual(["workflow::in-review"]);
			// The ticket carries no mapped label, so there is nothing to remove.
			expect(payload.removeLabels).toEqual([]);
			expect(userStoryUpdateMany.mock.calls).toEqual([
				[
					{
						...EXPECTED_STAMP,
						where: {
							...EXPECTED_STAMP.where,
							pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.NONE,
						},
					},
				],
			]);
		});

		it("R20: the gate resolves the live ticket with the STORED label map, not the caller's snapshot", async () => {
			// A queued push carries the map as it was when it was enqueued. The
			// user has since re-pointed `workflow::qa` from To Do to Done, and
			// the ticket moved onto it. Under the stale snapshot the live ticket
			// still reads as P (To Do), so the gate would pass and strip the
			// ticket's new label — a revert.
			const SNAPSHOT_MAP = { ...LABEL_MAP, "workflow::qa": "st-todo" };
			const STORED_MAP = { ...LABEL_MAP, "workflow::qa": "st-done" };
			const SNAPSHOT = {
				additionalContext: { labelStatusMap: SNAPSHOT_MAP },
			};
			const liveLabels = ["workflow::qa", "bug"];
			getStoryById.mockResolvedValue(linkedStory());

			// Positive control: stored map = snapshot → labels replaced as today.
			useProject({
				...PROJECT_ROW,
				projectManagementAdditionalContext: {
					labelStatusMap: SNAPSHOT_MAP,
				},
			});
			routeGitLab({ liveLabels });
			expect(
				(await syncGitLabStoryViaRest(baseInput(SNAPSHOT))).success,
			).toBe(true);
			expect(updatePayload().addLabels).toEqual(["workflow::in-review"]);
			expect(updatePayload().removeLabels).toEqual(["workflow::qa"]);
			expect(userStoryUpdateMany.mock.calls).toEqual([[EXPECTED_STAMP]]);

			// The race: the stored map moved on; the push still carries the
			// snapshot. Under the stored map the ticket moved (R_live = Done ≠ P).
			callPmToolWithFallback.mockClear();
			userStoryUpdateMany.mockClear();
			useProject({
				...PROJECT_ROW,
				projectManagementAdditionalContext: {
					labelStatusMap: STORED_MAP,
				},
			});
			routeGitLab({ liveLabels });

			const result = await syncGitLabStoryViaRest(baseInput(SNAPSHOT));

			expect(result.success).toBe(true);
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			expect(updatePayload()).toEqual({
				title: "My Feature",
				description: "Body",
				addLabels: [],
				removeLabels: [],
			});
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it("R20: a null or malformed STORED map never falls back to the caller's map", async () => {
			// P on this link (To Do), L ≠ F, and the live ticket carries a label
			// the CALLER's map resolves to P — so under that map the gate would
			// replace labels. The stored context is what counts, and it has no
			// usable map: the live ticket resolves to no status, R_live ≠ P.
			getStoryById.mockResolvedValue(linkedStory());

			// Positive control: stored context = the caller's map → replaced.
			routeGitLab({ liveLabels: ["workflow::todo", "bug"] });
			expect((await syncGitLabStoryViaRest(baseInput(ON))).success).toBe(
				true,
			);
			expect(updatePayload().addLabels).toEqual(["workflow::in-review"]);
			expect(updatePayload().removeLabels).toEqual(["workflow::todo"]);
			expect(userStoryUpdateMany.mock.calls).toEqual([[EXPECTED_STAMP]]);

			for (const storedContext of [
				null,
				// Malformed: a list where the map object belongs.
				{ labelStatusMap: ["workflow::todo", "workflow::in-review"] },
			]) {
				callPmToolWithFallback.mockClear();
				userStoryUpdateMany.mockClear();
				useProject({
					...PROJECT_ROW,
					projectManagementAdditionalContext: storedContext,
				});
				routeGitLab({ liveLabels: ["workflow::todo", "bug"] });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expect(tools()).toEqual(["fetchItem", "updateItem"]);
				expect(updatePayload()).toEqual({
					title: "My Feature",
					description: "Body",
					addLabels: [],
					removeLabels: [],
				});
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			}
		});

		describe("no revert: every row where the ticket moved or the base does not count", () => {
			/** The gate ran and declined, having resolved the live ticket as `kind`. */
			function expectGateDeclined(liveResolved: string) {
				expect(tools()).toEqual(["fetchItem", "updateItem"]);
				expect(logger.info).toHaveBeenCalledWith(
					"[GitLab REST Sync] status labels left for the poll",
					{
						storyId: "story-1",
						fabricStatusId: "st-progress",
						liveResolved,
					},
				);
			}

			/** The exact update payload a content-only push sends. */
			const CONTENT_ONLY = {
				title: "My Feature",
				description: "Body",
				addLabels: [],
				removeLabels: [],
			};

			it("(a) P=__none__, L≠F, the ticket is back on a mapped label → no replacement, no stamp", async () => {
				getStoryById.mockResolvedValue(
					linkedStory({
						pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.NONE,
					}),
				);
				routeGitLab({ liveLabels: ["workflow::todo", "bug"] });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expectGateDeclined("status");
				expect(updatePayload()).toEqual(CONTENT_ONLY);
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});

			it("(b) the live ticket is ambiguous (two mapped statuses) vs a status P → no replacement, no stamp", async () => {
				getStoryById.mockResolvedValue(linkedStory());
				routeGitLab({
					liveLabels: ["workflow::todo", "workflow::done"],
				});

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expectGateDeclined("ambiguous");
				expect(updatePayload()).toEqual(CONTENT_ONLY);
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});

			it("(c) P=__terminal__ → no replacement, no stamp", async () => {
				getStoryById.mockResolvedValue(
					linkedStory({
						pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.TERMINAL,
					}),
				);
				routeGitLab({ liveLabels: ["workflow::todo"] });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expectGateDeclined("status");
				expect(updatePayload()).toEqual(CONTENT_ONLY);
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});

			it("(d) a relinked story (non-null base link ≠ K) → no replacement, no stamp", async () => {
				getStoryById.mockResolvedValue(
					linkedStory({
						pmStatusSyncBaseLink:
							"https://gitlab.com/example-group/example-project/-/issues/7",
					}),
				);
				routeGitLab({ liveLabels: ["workflow::todo"] });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expectGateDeclined("status");
				expect(updatePayload()).toEqual(CONTENT_ONLY);
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});

			it("(e) K null (a legacy story with no externalUrl) → no replacement, no stamp", async () => {
				getStoryById.mockResolvedValue(
					linkedStory({ externalUrl: null }),
				);
				routeGitLab({ liveLabels: ["workflow::todo"] });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				// Positive control: the switch-on path read the live ticket, then
				// stopped for want of a link key.
				expect(tools()).toEqual(["fetchItem", "updateItem"]);
				expect(logger.info).toHaveBeenCalledWith(
					"[GitLab REST Sync] status labels unchanged — no live ticket or link key",
					{ storyId: "story-1", liveTicket: true, linkKey: false },
				);
				expect(updatePayload()).toEqual(CONTENT_ONLY);
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});
		});

		it("forceHashOverride skips the content guard but not the live read the gate needs", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			getPmSyncBaseline.mockResolvedValue("any-baseline");
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncGitLabStoryViaRest(
				baseInput({ ...ON, forceHashOverride: true }),
			);

			expect(result.success).toBe(true);
			expect(getPmSyncBaseline).not.toHaveBeenCalled();
			expect(tools()).toEqual(["fetchItem", "updateItem"]);
			expect(userStoryUpdateMany.mock.calls[0]?.[0]).toEqual(
				EXPECTED_STAMP,
			);
		});

		it("route 1 — manual Push: syncStoryToPM reaches the same gate", async () => {
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncStoryToPM(baseInput(ON));

			expect(result.success).toBe(true);
			expect(updatePayload().removeLabels).toEqual(["workflow::todo"]);
			expect(userStoryUpdateMany.mock.calls[0]?.[0]).toEqual(
				EXPECTED_STAMP,
			);
		});

		it("route 2 — AI update / retry: syncWorkItemToPM reaches the same gate", async () => {
			// hierarchy-sync is mocked at file scope for its baseline helpers;
			// the real syncWorkItemToPM is what the AI-update workflow runs.
			const { syncWorkItemToPM } = await vi.importActual<
				typeof import("../pm-integration/hierarchy-sync")
			>("../pm-integration/hierarchy-sync");
			getStoryById.mockResolvedValue(linkedStory());
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncWorkItemToPM({
				itemType: "story",
				itemId: "story-1",
				projectId: "proj-1",
				mcpConfigId: null,
				mcpServerId: "server-1",
				containerId: "100",
				additionalContext: ON.additionalContext as unknown as Record<
					string,
					string
				>,
				userId: "user-1",
				organizationId: "org-1",
				triggerSource: "ai-update",
			});

			expect(result.status).toBe("SUCCESS");
			expect(updatePayload().removeLabels).toEqual(["workflow::todo"]);
			expect(userStoryUpdateMany.mock.calls[0]?.[0]).toEqual(
				EXPECTED_STAMP,
			);
		});

		it("switch OFF: the update call is byte-identical to today's", async () => {
			useProject({ ...PROJECT_ROW, pmStatusSyncEnabled: false });
			getStoryById.mockResolvedValue(
				linkedStory({ labels: ["workflow::todo", "customer-facing"] }),
			);
			routeGitLab({ liveLabels: ["workflow::todo"] });

			const result = await syncGitLabStoryViaRest(baseInput(ON));

			expect(result.success).toBe(true);
			// No baseline + switch off → no live read, exactly as before.
			expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
			expect(
				JSON.stringify(callPmToolWithFallback.mock.calls[0]?.[0]),
			).toBe(
				JSON.stringify({
					source: REST_SOURCE,
					userId: "user-1",
					organizationId: "org-1",
					fabricProjectId: "proj-1",
					call: {
						tool: "updateItem",
						externalId: "42",
						payload: {
							title: "My Feature",
							description: "Body",
							addLabels: ["workflow::in-review"],
							removeLabels: [],
						},
					},
				}),
			);
			expect(findManyStatuses).not.toHaveBeenCalled();
			expect(userStoryUpdateMany).not.toHaveBeenCalled();
		});

		describe("create (§4.5 step 5)", () => {
			/** Unlinked, In Progress, carrying a stale mapped label from an earlier import. */
			function unlinkedStory(overrides: Record<string, unknown> = {}) {
				return baseStory({
					statusId: "st-progress",
					labels: [
						"workflow::todo",
						"customer-facing",
						"workflow::archived",
					],
					...overrides,
				});
			}

			it("sends exactly L's mapped status and stamps the base against the new link", async () => {
				getStoryById.mockResolvedValue(unlinkedStory());
				routeGitLabCreate({ updatedAt: CREATED_AT });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expect(tools()).toEqual(["createItem"]);
				// The stale `workflow::todo` is dropped (it would make the new
				// ticket ambiguous); `workflow::archived` maps to a status this
				// project no longer has, so it stays like any non-status label.
				expect(createPayload().labels).toEqual([
					"customer-facing",
					"workflow::archived",
					"workflow::in-review",
				]);
				expect(userStoryUpdateMany.mock.calls).toEqual([
					[EXPECTED_CREATE_STAMP],
				]);
			});

			it("L has no mapped label: every valid mapped label is dropped and __none__ is stamped", async () => {
				getStoryById.mockResolvedValue(
					unlinkedStory({ statusId: "st-backlog" }),
				);
				routeGitLabCreate({ updatedAt: CREATED_AT });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expect(createPayload().labels).toEqual([
					"customer-facing",
					"workflow::archived",
				]);
				expect(userStoryUpdateMany.mock.calls).toEqual([
					[
						{
							...EXPECTED_CREATE_STAMP,
							data: {
								...EXPECTED_CREATE_STAMP.data,
								pmStatusSyncBaseId:
									PM_STATUS_SYNC_SENTINEL.NONE,
								pmStatusSyncBaseFabricId: "st-backlog",
							},
						},
					],
				]);
			});

			it("no updated_at on the create or the one re-read: no stamp", async () => {
				getStoryById.mockResolvedValue(unlinkedStory());
				routeGitLabCreate({ updatedAt: null });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				// Positive control: the fallback re-read of the new issue ran.
				expect(tools()).toEqual(["createItem", "fetchItem"]);
				expect(logger.warn).toHaveBeenCalledWith(
					"[GitLab REST Sync] GitLab returned no updated_at; status-sync base not stamped",
					{ storyId: "story-1", externalId: "43" },
				);
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});

			it("(f) no updated_at on the create, the one re-read supplies it: the stamp uses the re-read clock", async () => {
				const REREAD_AT = "2026-09-21T10:02:09.500Z";
				getStoryById.mockResolvedValue(unlinkedStory());
				routeGitLabCreate({
					updatedAt: null,
					rereadUpdatedAt: REREAD_AT,
				});

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expect(tools()).toEqual(["createItem", "fetchItem"]);
				expect(userStoryUpdateMany.mock.calls).toEqual([
					[
						{
							...EXPECTED_CREATE_STAMP,
							data: {
								...EXPECTED_CREATE_STAMP.data,
								pmStatusSyncBaseAt: new Date(REREAD_AT),
							},
						},
					],
				]);
			});

			it("(g) the created issue has no web_url: no link key, so no stamp", async () => {
				getStoryById.mockResolvedValue(unlinkedStory());
				routeGitLabCreate({ updatedAt: CREATED_AT, externalUrl: null });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				// Positive control: the switch-on create ran — exactly L's labels.
				expect(createPayload().labels).toEqual([
					"customer-facing",
					"workflow::archived",
					"workflow::in-review",
				]);
				expect(logger.warn).toHaveBeenCalledWith(
					"[GitLab REST Sync] created issue has no web_url; status-sync base not stamped",
					{ storyId: "story-1", externalId: "43" },
				);
				// No clock was even needed: no re-read, and nothing stamped.
				expect(tools()).toEqual(["createItem"]);
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});

			it("R20: the create sends L's labels by the STORED map, not the caller's snapshot", async () => {
				// The user renamed In Progress's label to `workflow::doing`; the
				// queued push still carries the old snapshot.
				const STORED_MAP = {
					"workflow::todo": "st-todo",
					"workflow::doing": "st-progress",
					"workflow::done": "st-done",
					"workflow::archived": "st-retired",
				};
				getStoryById.mockResolvedValue(unlinkedStory());

				// Positive control: stored map = snapshot → today's switch-on labels.
				routeGitLabCreate({ updatedAt: CREATED_AT });
				await syncGitLabStoryViaRest(baseInput(ON));
				expect(createPayload().labels).toEqual([
					"customer-facing",
					"workflow::archived",
					"workflow::in-review",
				]);

				callPmToolWithFallback.mockClear();
				userStoryUpdateMany.mockClear();
				useProject({
					...PROJECT_ROW,
					projectManagementAdditionalContext: {
						labelStatusMap: STORED_MAP,
					},
				});
				routeGitLabCreate({ updatedAt: CREATED_AT });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				expect(createPayload().labels).toEqual([
					"customer-facing",
					"workflow::archived",
					"workflow::doing",
				]);
				expect(userStoryUpdateMany.mock.calls).toEqual([
					[EXPECTED_CREATE_STAMP],
				]);
			});

			it("R20: a null STORED map never falls back to the caller's map on create", async () => {
				getStoryById.mockResolvedValue(unlinkedStory());

				// Positive control: stored context = the caller's map → L's
				// mapped label is added and the stale mapped one dropped.
				routeGitLabCreate({ updatedAt: CREATED_AT });
				await syncGitLabStoryViaRest(baseInput(ON));
				expect(createPayload().labels).toEqual([
					"customer-facing",
					"workflow::archived",
					"workflow::in-review",
				]);
				expect(userStoryUpdateMany.mock.calls).toEqual([
					[EXPECTED_CREATE_STAMP],
				]);

				callPmToolWithFallback.mockClear();
				userStoryUpdateMany.mockClear();
				useProject({
					...PROJECT_ROW,
					projectManagementAdditionalContext: null,
				});
				routeGitLabCreate({ updatedAt: CREATED_AT });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				// Nothing is a status label under the (empty) stored map: the
				// story's labels go out untouched — no caller-map label added
				// or dropped.
				expect(createPayload().labels).toEqual([
					"workflow::todo",
					"customer-facing",
					"workflow::archived",
				]);
				// …and the base records what the poll concludes under the same
				// empty map (row 6): no status (`__none__`), observed at F = L.
				expect(userStoryUpdateMany.mock.calls).toEqual([
					[
						{
							...EXPECTED_CREATE_STAMP,
							data: {
								...EXPECTED_CREATE_STAMP.data,
								pmStatusSyncBaseId:
									PM_STATUS_SYNC_SENTINEL.NONE,
								pmStatusSyncBaseFabricId: "st-progress",
							},
						},
					],
				]);
			});

			it("switch OFF: the create payload is today's and nothing is stamped", async () => {
				useProject({ ...PROJECT_ROW, pmStatusSyncEnabled: false });
				getStoryById.mockResolvedValue(unlinkedStory());
				routeGitLabCreate({ updatedAt: CREATED_AT });

				const result = await syncGitLabStoryViaRest(baseInput(ON));

				expect(result.success).toBe(true);
				// Today's create: story.labels plus the delta's add, unfiltered.
				expect(createPayload().labels).toEqual([
					"workflow::todo",
					"customer-facing",
					"workflow::archived",
					"workflow::in-review",
				]);
				expect(tools()).toEqual(["createItem"]);
				expect(findManyStatuses).not.toHaveBeenCalled();
				expect(userStoryUpdateMany).not.toHaveBeenCalled();
			});

			it("create → Fabric move → poll: the created ticket is not a change, so the move stands (fabric-ahead)", async () => {
				getStoryById.mockResolvedValue(unlinkedStory());
				routeGitLabCreate({ updatedAt: CREATED_AT });
				await syncGitLabStoryViaRest(baseInput(ON));
				const stamp = userStoryUpdateMany.mock.calls[0]?.[0] as
					| typeof EXPECTED_CREATE_STAMP
					| undefined;
				expect(stamp).toEqual(EXPECTED_CREATE_STAMP);
				if (!stamp) {
					throw new Error("the create wrote no stamp");
				}

				// The user then moves the story in Fabric. The ticket still
				// carries exactly what the create sent.
				const story = {
					id: "story-1",
					title: "My Feature",
					statusId: "st-done",
					order: 3,
					pmStatusSyncBaseId: stamp.data.pmStatusSyncBaseId,
					pmStatusSyncBaseAt: stamp.data.pmStatusSyncBaseAt,
					pmStatusSyncBaseLink: stamp.data.pmStatusSyncBaseLink,
					pmStatusSyncBaseFabricId:
						stamp.data.pmStatusSyncBaseFabricId,
					lastPmSyncStatus: "SUCCESS",
					externalId: "43",
					externalUrl: CREATED_URL,
					externalMcpServerId: "server-1",
				};
				const item = {
					externalId: "43",
					state: "",
					labels: createPayload().labels,
					stateChangedDate: new Date(CREATED_AT),
					itemUrl: CREATED_URL,
				};
				const config = {
					labelStatusMap: LABEL_MAP,
					statusColumnMap: {},
					projectStatuses: STATUS_ROWS.map(({ id, name }) => ({
						id,
						name,
					})),
				};

				// Positive control: without the create stamp the same poll would
				// be a first observation and revert the Fabric move.
				expect(
					decidePmStatusSync({
						resolved: { kind: "status", statusId: "st-progress" },
						fabricStatusId: "st-done",
						base: {
							baseId: null,
							baseAt: null,
							baseLink: null,
							baseFabricId: null,
						},
						linkKey: CREATED_URL,
						stateChangedDate: new Date(CREATED_AT),
						pushConflictPending: false,
					}).outcome,
				).toBe("moved");

				const { outcome } = await reconcileStoryMappedStatus({
					projectId: "proj-1",
					tenant: { organizationId: "org-1", ownerUserId: null },
					item,
					story,
					config,
					source: {
						isRest: true,
						activeServerId: "server-1",
						pmToolKey: "gitlab-official",
						pmToolLabel: "GitLab",
						activeOrg: null,
					},
				});

				expect(outcome).toBe("fabric-ahead");
				// fabric-ahead writes nothing: the only story write is the create stamp.
				expect(userStoryUpdateMany).toHaveBeenCalledTimes(1);

				// Spec §6 trace, second half: a Fabric move after that → the push
				// sends labels. The poll left the base alone, so on the next push
				// L (Done) ≠ F (In Progress) while the ticket still shows P.
				const MOVED_AT = "2026-09-21T11:30:00.000Z";
				const createdLabels = createPayload().labels;
				callPmToolWithFallback.mockClear();
				callPmToolWithFallback.mockImplementation(
					async ({
						call,
					}: {
						call: { tool: string; externalId?: string };
					}) => {
						if (
							call.tool === "fetchItem" &&
							call.externalId === "43"
						) {
							return {
								title: "My Feature",
								description: "Body",
								externalUrl: CREATED_URL,
								labels: createdLabels,
								state: "opened",
								updatedAt: CREATED_AT,
							};
						}
						if (
							call.tool === "updateItem" &&
							call.externalId === "43"
						) {
							return {
								externalId: "43",
								externalUrl: CREATED_URL,
								title: "My Feature",
								updatedAt: MOVED_AT,
							};
						}
						throw new Error(`unexpected REST tool ${call.tool}`);
					},
				);
				getStoryById.mockResolvedValue(
					unlinkedStory({
						statusId: "st-done",
						externalId: "43",
						externalUrl: CREATED_URL,
						externalMcpServerId: "server-1",
						pmStatusSyncBaseId: stamp.data.pmStatusSyncBaseId,
						pmStatusSyncBaseAt: stamp.data.pmStatusSyncBaseAt,
						pmStatusSyncBaseLink: stamp.data.pmStatusSyncBaseLink,
						pmStatusSyncBaseFabricId:
							stamp.data.pmStatusSyncBaseFabricId,
					}),
				);

				const pushed = await syncGitLabStoryViaRest(baseInput(ON));

				expect(pushed.success).toBe(true);
				expect(tools()).toEqual(["fetchItem", "updateItem"]);
				expect(updatePayload().addLabels).toEqual(["workflow::done"]);
				// The created ticket carries In Progress's label only.
				expect(updatePayload().removeLabels).toEqual([
					"workflow::in-review",
				]);
				expect(userStoryUpdateMany.mock.calls).toEqual([
					[EXPECTED_CREATE_STAMP],
					[
						{
							where: {
								id: "story-1",
								projectId: "proj-1",
								pmStatusSyncBaseId: "st-progress",
								pmStatusSyncBaseAt: new Date(CREATED_AT),
								pmStatusSyncBaseLink: CREATED_URL,
								pmStatusSyncBaseFabricId: "st-progress",
							},
							data: {
								pmStatusSyncBaseId: "st-done",
								pmStatusSyncBaseAt: new Date(MOVED_AT),
								pmStatusSyncBaseLink: CREATED_URL,
								pmStatusSyncBaseFabricId: "st-done",
							},
						},
					],
				]);
			});
		});
	});
});
