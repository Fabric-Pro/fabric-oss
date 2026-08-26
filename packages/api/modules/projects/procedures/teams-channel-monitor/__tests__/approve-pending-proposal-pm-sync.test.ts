/**
 * Focused tests for the Teams `approve-pending-proposal` procedure's NEW
 * PM-sync auto-enqueue behavior. Separate from the integration test so the
 * scope here stays narrow (single concern: PM sync gate + `enqueuePmSync`
 * wiring on the CREATE branch).
 *
 * The bug being fixed: approving a Teams channel-monitor proposal called
 * `createStoryFromProposal` directly in a loop but never enqueued PM sync —
 * so approved proposals landed in Fabric with `pmAutoSyncEnabled=false` and
 * never reached the configured PM tool. The CREATE row appeared as "Unsynced"
 * on the roadmap forever.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		// DB queries
		getPendingBacklogProposal: vi.fn(),
		markPendingProposalApproved: vi.fn(),
		markPendingProposalApplied: vi.fn(),
		markPendingProposalFailed: vi.fn(),
		appendAppliedChangeIndexes: vi.fn(),
		setProposalApplyWorkflowId: vi.fn(),
		setPendingProposalAttachmentResult: vi.fn(),
		markPendingProposalRejected: vi.fn(),
		projectFindUnique: vi.fn(),
		featureFindFirst: vi.fn(),
		// External services
		createStoryFromProposal: vi.fn(),
		attachPendingMediaToStory: vi.fn(),
		getMicrosoftAccessToken: vi.fn(),
		uploadFile: vi.fn(),
		// PM sync
		enqueuePmSync: vi.fn(),
		// Loggers
		loggerWarn: vi.fn(),
		loggerInfo: vi.fn(),
		loggerError: vi.fn(),
		loggerDebug: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getPendingBacklogProposal: mocks.getPendingBacklogProposal,
	markPendingProposalApproved: mocks.markPendingProposalApproved,
	markPendingProposalApplied: mocks.markPendingProposalApplied,
	markPendingProposalFailed: mocks.markPendingProposalFailed,
	appendAppliedChangeIndexes: mocks.appendAppliedChangeIndexes,
	setProposalApplyWorkflowId: mocks.setProposalApplyWorkflowId,
	setPendingProposalAttachmentResult:
		mocks.setPendingProposalAttachmentResult,
	markPendingProposalRejected: mocks.markPendingProposalRejected,
	updateStory: vi.fn().mockResolvedValue(undefined),
	db: {
		project: { findUnique: mocks.projectFindUnique },
		feature: { findFirst: mocks.featureFindFirst },
		userStory: { findMany: vi.fn().mockResolvedValue([]) },
	},
	normalizeBacklogTitle: (title: string) =>
		title
			.toLowerCase()
			.trim()
			.replace(/^\[bug\]\s+/i, "")
			.trim(),
	buildBacklogDedupGuard: vi.fn().mockResolvedValue({
		findCollision: () => null,
		recordCreated: () => {},
	}),
	inferDedupFamily: (change: {
		kindOverride?: string | null;
		type: string;
	}) =>
		change.kindOverride === "BUG" || change.type === "bug"
			? "BUG"
			: "FEATURE",
}));

vi.mock("@repo/temporal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
	// Fire-and-forget duplicate detection enqueued after the create loop (flags
	// "Possible duplicate"); stub the trigger so it's a no-op in this test.
	triggerDuplicateDetection: vi.fn(async () => ({
		workflowId: "dup-detect-test",
	})),
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: { start: vi.fn() },
	}),
}));

vi.mock("@repo/temporal/activities", () => ({
	mapPriority: (v: string | undefined) => v ?? "MEDIUM",
	mapSize: (v: string | undefined) => v ?? "M",
}));

vi.mock("../../../lib/attach-pending-media-to-story", () => ({
	attachPendingMediaToStory: mocks.attachPendingMediaToStory,
	formatAttachmentWarningLines: () => [],
	appendWarningLinesToAttachmentsBlock: (description: string) => description,
}));

vi.mock("@repo/integrations/microsoft", () => ({
	getMicrosoftAccessToken: mocks.getMicrosoftAccessToken,
}));

vi.mock("@repo/storage", () => ({
	uploadFile: mocks.uploadFile,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: mocks.loggerInfo,
		error: mocks.loggerError,
		debug: mocks.loggerDebug,
	},
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (input: unknown) => input,
}));

vi.mock("../../../../../orpc/procedures", () => {
	function makeChainable(handlerSlot: string) {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: (...args: unknown[]) => unknown) => {
				handlers[handlerSlot] = fn;
				return { _handler: fn };
			},
		});
		return chainable;
	}
	let nextSlot = "approve";
	return {
		get tenantProtectedProcedure() {
			const slot = nextSlot;
			nextSlot = nextSlot === "approve" ? "reject" : slot;
			return makeChainable(slot);
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

// Mock the new enqueue site. The procedure imports from this exact relative
// path, so the mock specifier matches what the source file consumes.
vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

// Side-effect: register the handler.
import "../approve-pending-proposal";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-pm-sync-1";
const PROPOSAL_ID = "proposal-pm-sync-1";
const APPROVER_ID = "approver-pm-1";
const PROPOSAL_OWNER_ID = "monitor-owner-pm-1";
const ORG_ID = "org-pm-1";
const PM_CONFIG_ID = "mcp-cfg-fizzy-1";
const PM_CONTAINER_ID = "container-fizzy-1";

const CHANGE_BUG = {
	action: "create" as const,
	type: "bug" as const,
	title: { to: "Cannot upload screenshots" },
	reasoning: "Image upload broken",
	sourceContext: "teams_messages" as const,
};

const CHANGE_FEATURE = {
	action: "create" as const,
	type: "feature" as const,
	title: { to: "Dark mode" },
	reasoning: "Common ask in #design",
	sourceContext: "teams_messages" as const,
};

function makeProposalRow(opts: { changes: (typeof CHANGE_BUG)[] }) {
	return {
		id: PROPOSAL_ID,
		projectId: PROJECT_ID,
		userId: PROPOSAL_OWNER_ID,
		organizationId: ORG_ID,
		status: "PENDING" as const,
		sourceMetadata: {
			channelDisplayName: "general",
			teamId: "T1",
			channelId: "C1",
			threadRootId: "msg-1",
		},
		appliedChangeIndexes: [],
		proposal: { changes: opts.changes },
		summary: opts.changes[0]?.title.to ?? "Sample",
	};
}

const APPROVAL_CTX = {
	user: { id: APPROVER_ID },
	session: { id: "session-pm-1", activeOrganizationId: ORG_ID },
};

beforeEach(() => {
	vi.clearAllMocks();

	mocks.projectFindUnique.mockResolvedValue({
		id: PROJECT_ID,
		organizationId: ORG_ID,
		projectManagementContainerName: "Fizzy Sprint 12",
		projectManagementMcpConfigId: PM_CONFIG_ID,
		projectManagementContainerId: PM_CONTAINER_ID,
	});
	mocks.featureFindFirst.mockResolvedValue(null);
	mocks.appendAppliedChangeIndexes.mockResolvedValue(undefined);
	mocks.markPendingProposalApproved.mockResolvedValue(undefined);
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
	mocks.markPendingProposalFailed.mockResolvedValue(undefined);

	// Default: the new row is a BUG so `enqueuePmSync` is called with
	// itemType: "bug" (matches the source's `story.kind === "BUG" ? "bug" : "story"`
	// derivation). Tests that need FEATURE override this.
	mocks.createStoryFromProposal.mockImplementation(
		async (params: { title: string }) => ({
			story: {
				id: `story-${params.title.toLowerCase().replace(/\s+/g, "-")}`,
				identifier: "F-100",
				kind: "BUG",
				description: null,
			},
			aiDrafted: false,
		}),
	);
	mocks.attachPendingMediaToStory.mockResolvedValue({
		uploaded: [],
		warnings: [],
	});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: true,
		workflowId: "wf-test",
	});
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("approvePendingProposal (Teams) — PM sync auto-enqueue on CREATE", () => {
	it("enqueues PM sync per CREATE when syncToPM=true and PM is configured", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: true,
				pmConfig: {
					mcpConfigId: PM_CONFIG_ID,
					containerId: PM_CONTAINER_ID,
				},
			},
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);

		// `createStoryFromProposal` got the per-row gate so future edits sync.
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBe(true);

		// `enqueuePmSync` was called for the new bug row.
		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: result.createdStoryIds[0],
				itemType: "bug",
				projectId: PROJECT_ID,
				userId: APPROVER_ID,
				forceInitialPush: true,
				triggerSource: "auto-push",
			}),
		);
	});

	it("derives itemType=story for non-BUG story kinds", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_FEATURE] }),
		);
		mocks.createStoryFromProposal.mockResolvedValueOnce({
			story: {
				id: "story-dark-mode",
				identifier: "F-200",
				kind: "FEATURE",
				description: null,
			},
			aiDrafted: false,
		});

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_FEATURE],
				syncToPM: true,
				pmConfig: {
					mcpConfigId: PM_CONFIG_ID,
					containerId: PM_CONTAINER_ID,
				},
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		const arg = mocks.enqueuePmSync.mock.calls[0]?.[0] as {
			itemType: string;
		};
		expect(arg.itemType).toBe("story");
	});

	it("enqueues PM sync when syncToPM is OMITTED and PM is configured (default-on behavior)", async () => {
		// Regression guard: the headline-bug UI today doesn't pass
		// syncToPM at all. Approvals should still reach the PM tool
		// whenever the project has it wired up.
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				// syncToPM intentionally omitted
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBe(true);
	});

	it("does NOT enqueue PM sync when syncToPM=false (explicit opt-out)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
		// And `enablePmAutoSync` is NOT set on the create call — preserves
		// the legacy default-false on the row.
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBeUndefined();
	});

	it("does NOT enqueue PM sync when project has no PM configured (even with syncToPM=true)", async () => {
		mocks.projectFindUnique.mockResolvedValueOnce({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			projectManagementContainerName: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
		});
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: true,
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("logs and continues when enqueuePmSync throws — story is still persisted, approval still succeeds", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);
		mocks.enqueuePmSync.mockRejectedValueOnce(
			new Error("Temporal unreachable"),
		);

		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: true,
				pmConfig: {
					mcpConfigId: PM_CONFIG_ID,
					containerId: PM_CONTAINER_ID,
				},
			},
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);

		// The procedure logged a warn for the throw — the source's structured
		// warn carries `errorName: "Error"`.
		const warnedAboutEnqueue = mocks.loggerWarn.mock.calls.some((call) => {
			const meta = call[1] as Record<string, unknown> | undefined;
			return (
				typeof call[0] === "string" &&
				call[0].includes("enqueuePmSync threw") &&
				meta?.storyId === result.createdStoryIds[0]
			);
		});
		expect(warnedAboutEnqueue).toBe(true);
	});
});
