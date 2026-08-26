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
} = vi.hoisted(() => ({
	getStoryById: vi.fn(),
	updateStory: vi.fn(),
	findManyStatuses: vi.fn(),
	projectFindUnique: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
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
		},
	};
});

import { syncGitLabStoryViaRest } from "../pm-integration/gitlab-rest-story-sync";

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
});
