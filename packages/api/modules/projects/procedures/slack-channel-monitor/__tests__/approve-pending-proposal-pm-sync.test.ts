/**
 * Focused tests for the Slack `approve-pending-proposal` procedure's NEW
 * PM-sync auto-enqueue behavior. Mirror of the Teams test — Slack handler is
 * structurally identical (per PRs #1232 / #1238).
 *
 * Bug fix: approving a Slack channel-monitor proposal called
 * `createStoryFromProposal` directly in a loop but never enqueued PM sync,
 * so approved proposals never reached Fizzy/Jira/etc.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
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
		createStoryFromProposal: vi.fn(),
		attachPendingMediaToStory: vi.fn(),
		getSlackCredentials: vi.fn(),
		uploadFile: vi.fn(),
		enqueuePmSync: vi.fn(),
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

vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: mocks.getSlackCredentials,
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

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

import "../approve-pending-proposal";

const PROJECT_ID = "proj-slack-pm-1";
const PROPOSAL_ID = "proposal-slack-pm-1";
const APPROVER_ID = "approver-slack-pm-1";
const PROPOSAL_OWNER_ID = "monitor-owner-slack-pm-1";
const ORG_ID = "org-slack-pm-1";
const PM_CONFIG_ID = "mcp-cfg-jira-1";
const PM_CONTAINER_ID = "container-jira-1";

const CHANGE_BUG = {
	action: "create" as const,
	type: "bug" as const,
	title: { to: "Payments failing in checkout" },
	reasoning: "Reported in #cs-alerts",
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
			workspaceDomain: "fabricorg",
			channelId: "C0001",
			threadTs: "1234567890.123456",
			channelName: "cs-alerts",
		},
		appliedChangeIndexes: [],
		proposal: { changes: opts.changes },
		summary: opts.changes[0]?.title.to ?? "Sample",
	};
}

const APPROVAL_CTX = {
	user: { id: APPROVER_ID },
	session: { id: "session-slack-pm-1", activeOrganizationId: ORG_ID },
};

beforeEach(() => {
	vi.clearAllMocks();

	mocks.projectFindUnique.mockResolvedValue({
		id: PROJECT_ID,
		organizationId: ORG_ID,
		projectManagementContainerName: "Sprint 12",
		projectManagementMcpConfigId: PM_CONFIG_ID,
		projectManagementContainerId: PM_CONTAINER_ID,
	});
	mocks.featureFindFirst.mockResolvedValue(null);
	mocks.appendAppliedChangeIndexes.mockResolvedValue(undefined);
	mocks.markPendingProposalApproved.mockResolvedValue(undefined);
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
	mocks.markPendingProposalFailed.mockResolvedValue(undefined);

	mocks.createStoryFromProposal.mockImplementation(
		async (params: { title: string }) => ({
			story: {
				id: `story-${params.title.toLowerCase().replace(/\s+/g, "-")}`,
				identifier: "F-300",
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
		workflowId: "wf-test-slack",
	});
});

describe("approvePendingProposal (Slack) — PM sync auto-enqueue on CREATE", () => {
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

		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBe(true);

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

	it("enqueues PM sync when syncToPM is OMITTED and PM is configured (default-on behavior)", async () => {
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
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBeUndefined();
	});

	it("does NOT enqueue when project has no PM configured", async () => {
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

	it("logs and continues when enqueuePmSync throws", async () => {
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
