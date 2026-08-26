/**
 * Wiring test: the Teams approve procedure writes the server-authoritative
 * `decision.override_accepted` audit record when the accepted proposal carries
 * unresolved decision-contradiction findings in
 * `sourceMetadata.decisionPrecheck`. The real override-audit helper runs; only
 * `recordAuditFromRequest`, the DB queries, Temporal, and the oRPC chain are
 * boundary-mocked. Proves the override fires on the success path and does not
 * fire when there are no findings.
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
		projectFindUnique: vi.fn(),
		userStoryUpdate: vi.fn(),
		createStoryFromProposal: vi.fn(),
		triggerDuplicateDetection: vi.fn(),
		resolveMeetingTranscriptForProposal: vi.fn(),
		recordAuditFromRequest: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	appendAppliedChangeIndexes: mocks.appendAppliedChangeIndexes,
	buildBacklogDedupGuard: vi.fn().mockResolvedValue({
		findCollision: () => null,
		recordCreated: () => {},
	}),
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: { update: mocks.userStoryUpdate },
	},
	getPendingBacklogProposal: mocks.getPendingBacklogProposal,
	inferDedupFamily: () => "FEATURE",
	markPendingProposalApplied: mocks.markPendingProposalApplied,
	markPendingProposalApproved: mocks.markPendingProposalApproved,
	markPendingProposalFailed: mocks.markPendingProposalFailed,
	setPendingProposalAttachmentResult:
		mocks.setPendingProposalAttachmentResult,
	setProposalApplyWorkflowId: mocks.setProposalApplyWorkflowId,
	updateStory: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
	triggerDuplicateDetection: mocks.triggerDuplicateDetection,
	unwrapPmSyncError: (err: unknown) => ({
		errorClass: "Error",
		message: err instanceof Error ? err.message : "error",
	}),
}));

vi.mock("@repo/temporal/activities", () => ({
	mapPriority: (v: string | undefined) => v ?? "MEDIUM",
	mapSize: (v: string | undefined) => v ?? "M",
}));

vi.mock("@repo/integrations/microsoft", () => ({
	getMicrosoftAccessToken: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../lib/attach-pending-media-to-story", () => ({
	attachPendingMediaToStory: vi.fn(),
	appendWarningLinesToAttachmentsBlock: (d: string) => d,
	formatAttachmentWarningLines: () => [],
}));

vi.mock("../../../lib/channel-monitor-source", () => ({
	isChannelMonitorSource: () => true,
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn(),
}));

vi.mock("../../../lib/meeting-provenance", () => ({
	resolveMeetingTranscriptForProposal:
		mocks.resolveMeetingTranscriptForProposal,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mocks.recordAuditFromRequest(...args),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["approve"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../approve-pending-proposal");

const context = {
	user: { id: "user-1", email: "reviewer@example.com", name: "Reviewer" },
	session: { id: "sess-1" },
};

const change = {
	type: "feature" as const,
	action: "create" as const,
	title: { to: "Add Mongo store" },
	description: { to: "Use MongoDB for persistence" },
	reasoning: "requested",
	sourceContext: "teams_messages" as const,
};

const conflictsPrecheck = {
	checkedAt: "2020-01-01T00:00:00.000Z",
	status: "conflicts",
	findings: [
		{
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres",
			natureOfConflict: "Reintroduces MongoDB",
			conflictType: "violates_accepted",
			confidence: 0.8,
			// The judge stamps the change title on every backlog changeRef; the
			// override paths correlate findings to approved changes by that title
			// so a deselected change logs no override.
			changeRef: { index: 0, title: "Add Mongo store" },
		},
	],
};

function proposalRow(
	sourceMetadata: Record<string, unknown>,
	changes: unknown[] = [change],
	appliedChangeIndexes: number[] = [],
) {
	return {
		id: "proposal-1",
		projectId: "proj-1",
		status: "PENDING",
		source: "TEAMS_CHANNEL",
		summary: "s",
		proposal: { changes },
		sourceMetadata,
		appliedChangeIndexes,
		userId: "owner-1",
		organizationId: "org-1",
	};
}

const input = {
	projectId: "proj-1",
	organizationId: "org-1",
	proposalId: "proposal-1",
	approvedChanges: [change],
};

function overrideCalls() {
	return mocks.recordAuditFromRequest.mock.calls.filter(
		(call) =>
			(call[1] as { action?: string }).action ===
			"decision.override_accepted",
	);
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		if (typeof m === "function" && "mockReset" in m) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.projectFindUnique.mockResolvedValue({
		id: "proj-1",
		organizationId: "org-1",
		projectManagementContainerName: null,
		projectManagementMcpConfigId: null,
		projectManagementContainerId: null,
	});
	mocks.markPendingProposalApproved.mockResolvedValue(undefined);
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
	mocks.appendAppliedChangeIndexes.mockResolvedValue(undefined);
	mocks.resolveMeetingTranscriptForProposal.mockResolvedValue(null);
	mocks.triggerDuplicateDetection.mockResolvedValue({ workflowId: "dup" });
	mocks.createStoryFromProposal.mockResolvedValue({
		story: {
			id: "story-1",
			identifier: "F-1",
			description: "Use MongoDB for persistence",
			kind: "FEATURE",
		},
	});
});

describe("Teams approve — decision override write", () => {
	it("writes one override record per conflicting decision on the success path", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(
			proposalRow({ decisionPrecheck: conflictsPrecheck }),
		);

		await handlers.approve({ input, context });

		const calls = overrideCalls();
		expect(calls).toHaveLength(1);
		const auditInput = calls[0]?.[1] as {
			metadata: {
				surface: string;
				artifactId: string;
				outputSnapshot: string;
			};
			resource: { id: string; type: string };
			organizationId?: string;
		};
		expect(auditInput.metadata.surface).toBe("backlog_proposal");
		expect(auditInput.metadata.artifactId).toBe("proposal-1");
		expect(auditInput.resource).toMatchObject({
			type: "architecture_decision",
			id: "dec-1",
		});
		expect(auditInput.organizationId).toBe("org-1");
		expect(auditInput.metadata.outputSnapshot).toContain("Add Mongo store");
	});

	it("writes no override record when the proposal carries no findings", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(proposalRow({}));
		await handlers.approve({ input, context });
		expect(overrideCalls()).toHaveLength(0);
	});

	it("writes NO override when the reviewer deselected the conflicting change (partial approval)", async () => {
		// The stored proposal has two changes: the MongoDB change the precheck
		// flags, and a benign export change. The reviewer approves ONLY the benign
		// change (deselecting the conflict), so `approvedChanges` omits the Mongo
		// change and no override may be logged for it.
		const benignChange = {
			type: "feature" as const,
			action: "create" as const,
			title: { to: "Add export button" },
			description: { to: "CSV export" },
			reasoning: "requested",
			sourceContext: "teams_messages" as const,
		};
		mocks.getPendingBacklogProposal.mockResolvedValue(
			proposalRow({ decisionPrecheck: conflictsPrecheck }, [
				change,
				benignChange,
			]),
		);

		await handlers.approve({
			input: { ...input, approvedChanges: [benignChange] },
			context,
		});

		expect(overrideCalls()).toHaveLength(0);
	});
});
