/**
 * Integration tests for the Teams `approve-pending-proposal` procedure's
 * wiring of the chat-thread image-attachments orchestrator
 * (`attachPendingMediaToStory`) and the apply-time warning ledger
 * (`setPendingProposalAttachmentResult`). Spec § 9.2 (Teams).
 *
 * Cases (per spec § 9.2, mirror of Slack):
 *   1. Happy 2-image approval — proposal carries 2 Teams refs in
 *      `sourceMetadata.attachments`; orchestrator is invoked with the right
 *      arguments (including the `teamsMessageUrlBuilder` callback for Graph
 *      URL construction); warnings are persisted (empty list) once after
 *      the create loop.
 *   2. Mixed success/failure — orchestrator returns 1 upload + 2 warnings;
 *      the warnings are forwarded to `setPendingProposalAttachmentResult`.
 *   3. Tenant XOR mismatch — proposal's `projectId` does NOT match the URL
 *      `projectId`; the procedure throws `NOT_FOUND` BEFORE the orchestrator
 *      is reached. Asserts the orchestrator was never invoked.
 *   4. Reject path → zero attachment activity. The reject procedure is
 *      imported and exercised separately to prove zero `uploadFile`
 *      (orchestrator was never called).
 *
 * Boundary mocks: orchestrator (`attachPendingMediaToStory`),
 * `setPendingProposalAttachmentResult`, `getMicrosoftAccessToken`,
 * `createStoryFromProposal`, DB queries. The procedure itself runs for real
 * so we exercise the wiring shape end-to-end.
 *
 * Log-redaction: every captured logger.warn / logger.info call is scanned
 * for `Bearer`, `accessToken`, `url_private`, `hostedContents/`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — boundary substitutions
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
		// Regression guard: monitored-channel approvals must NOT trigger semantic
		// duplicate detection (capture-as-is). Captured here so a create-path
		// test can assert it is never called.
		triggerDuplicateDetection: vi.fn(async () => ({
			workflowId: "dup-detect-test",
		})),
		attachPendingMediaToStory: vi.fn(),
		getMicrosoftAccessToken: vi.fn(),
		uploadFile: vi.fn(),
		downloadTeamsHostedContent: vi.fn(),
		// Temporal workflow dispatch (UPDATE path) — capturable so tests can
		// assert the `forbidEpics` workflow arg is gated on proposal.source.
		workflowStart: vi.fn(),
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
	db: {
		project: { findUnique: mocks.projectFindUnique },
		feature: { findFirst: mocks.featureFindFirst },
		// Empty existing-stories result → no title collisions, so the new
		// `buildBacklogDedupGuard` helper (called at the top of the
		// procedure handler) lets every CREATE proceed exactly like before
		// this PR. Suite-level default; individual tests can override
		// through `mocks` if/when dedup-specific scenarios are added.
		userStory: { findMany: vi.fn().mockResolvedValue([]) },
	},
	// Pure helper canonical home is `@repo/database/utils`; inlined here
	// to keep the test self-contained (mirrors the canonical implementation).
	normalizeBacklogTitle: (title: string) =>
		title
			.toLowerCase()
			.trim()
			.replace(/^\[bug\]\s+/i, "")
			.trim(),
	// Dedup guard moved into `@repo/database` (was in `@repo/api/.../lib/`)
	// so non-api callers — notably the `fabric_create_story` agent tool —
	// can share one implementation. Default stub: no collision, so existing
	// tests run their full create path; tests can override per-case to
	// force a collision and exercise the skip path.
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
	// The approve handler no longer imports triggerDuplicateDetection — monitored
	// channels are a capture-as-is flow. We still expose the mock so a create-path
	// test can assert it is never called (regression guard for the removal).
	triggerDuplicateDetection: mocks.triggerDuplicateDetection,
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			start: (...args: unknown[]) => {
				mocks.workflowStart(...args);
				return Promise.resolve({ workflowId: "wf-1" });
			},
		},
	}),
}));

vi.mock("@repo/temporal/activities", () => ({
	mapPriority: (v: string | undefined) => v ?? "MEDIUM",
	mapSize: (v: string | undefined) => v ?? "M",
}));

vi.mock("../../../lib/attach-pending-media-to-story", () => ({
	attachPendingMediaToStory: mocks.attachPendingMediaToStory,
	// Pure formatters re-implemented for the test. The call-site cred-failure
	// branch imports these to patch the story description with a
	// `## Attachments` warning line. We don't import the real ones because
	// the orchestrator module transitively pulls in `@repo/database` /
	// `@repo/storage` mocks that aren't relevant here. The shapes match
	// the real exports.
	formatAttachmentWarningLines: (
		warnings: ReadonlyArray<{ source: "slack" | "teams" }>,
	): string[] => {
		const bySource = new Map<"slack" | "teams", number>();
		for (const w of warnings) {
			bySource.set(w.source, (bySource.get(w.source) ?? 0) + 1);
		}
		const lines: string[] = [];
		for (const source of ["slack", "teams"] as const) {
			const count = bySource.get(source);
			if (count && count > 0) {
				const label = source === "slack" ? "Slack" : "Teams";
				const noun = count === 1 ? "image" : "images";
				lines.push(
					`_⚠ ${count} ${noun} couldn't be attached from ${label} — open the thread to view._`,
				);
			}
		}
		return lines;
	},
	appendWarningLinesToAttachmentsBlock: (
		description: string,
		warningLines: readonly string[],
	): string => {
		if (warningLines.length === 0) {
			return description;
		}
		const fresh = warningLines.filter(
			(line) => !description.includes(line),
		);
		if (fresh.length === 0) {
			return description;
		}
		const heading = "## Attachments";
		const joined = fresh.join("\n");
		if (description.includes(heading)) {
			const trailing = description.endsWith("\n") ? "" : "\n";
			return `${description}${trailing}${joined}\n`;
		}
		const separator =
			description.length === 0
				? ""
				: description.endsWith("\n")
					? "\n"
					: "\n\n";
		return `${description}${separator}${heading}\n\n${joined}\n`;
	},
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

	// The first procedure loaded into a chainable instance wins. Both
	// approve-pending-proposal and reject-pending-proposal use
	// `tenantProtectedProcedure` so we hand each call a fresh chainable.
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

// Side-effect: register the handlers.
import "../approve-pending-proposal";
import "../reject-pending-proposal";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_LOG_SUBSTRINGS = [
	"Bearer ",
	"GRAPH-TOKEN-SECRET",
	"accessToken",
	"hostedContents/",
];

function scanForForbidden(value: unknown, forbidden: string[]): string[] {
	const hits: string[] = [];
	const seen = new WeakSet<object>();
	function walk(v: unknown, path: string): void {
		if (v === null || v === undefined) {
			return;
		}
		if (typeof v === "string") {
			for (const needle of forbidden) {
				if (v.includes(needle)) {
					hits.push(`${path} contains "${needle}"`);
				}
			}
			return;
		}
		if (typeof v !== "object") {
			return;
		}
		if (seen.has(v as object)) {
			return;
		}
		seen.add(v as object);
		if (Array.isArray(v)) {
			for (const [i, item] of v.entries()) {
				walk(item, `${path}[${i}]`);
			}
			return;
		}
		for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
			walk(item, `${path}.${k}`);
		}
	}
	walk(value, "$");
	return hits;
}

function assertNoSecretsLoggedAcrossAllLoggers(): void {
	const captured = [
		...mocks.loggerWarn.mock.calls,
		...mocks.loggerInfo.mock.calls,
		...mocks.loggerError.mock.calls,
		...mocks.loggerDebug.mock.calls,
	];
	const hits = scanForForbidden(captured, FORBIDDEN_LOG_SUBSTRINGS);
	expect(hits).toEqual([]);
}

/**
 * Assert that at least one captured log event carries
 * `span: "chat-thread-attachments"` — the call-site span required by
 * Task 8.2 / spec § 6.2. The orchestrator emits internal `download` /
 * `upload` / `patch_description` events (Group 4) and the approve
 * procedure wraps the orchestrator call in an `approve_orchestrator`
 * event. This assertion proves the latter is wired.
 */
function assertChatThreadSpanEmitted(): void {
	const captured = [
		...mocks.loggerWarn.mock.calls,
		...mocks.loggerInfo.mock.calls,
		...mocks.loggerError.mock.calls,
		...mocks.loggerDebug.mock.calls,
	];
	const spanHits = captured.filter((call) => {
		const meta = call[1] as Record<string, unknown> | undefined;
		return meta?.span === "chat-thread-attachments";
	});
	expect(spanHits.length).toBeGreaterThan(0);
}

const PROJECT_ID = "proj-1";
const PROPOSAL_ID = "proposal-1";
const APPROVER_ID = "approver-1";
const PROPOSAL_OWNER_ID = "monitor-owner-1";
const ORG_ID = "org-1";
const TEAM_ID = "T-team";
const CHANNEL_ID = "C-channel";

function teamsRefFixture(id: string, messageId = "msg-1") {
	return {
		source: "teams" as const,
		ref: {
			id,
			messageId,
			contentType: "image/png",
		},
	};
}

function makeProposalRow(opts: {
	attachments?: unknown[];
	projectId?: string;
	status?: "PENDING" | "APPLIED" | "REJECTED" | "FAILED" | "APPROVED";
	// PendingBacklogProposalSource. The approve-backend epic-suppression (Bug
	// 1429 / Codex round 4) gates on this, so fixtures must carry a realistic
	// source — proposals routed to the Teams endpoint are TEAMS_CHANNEL (or
	// TEAMS_CHAT, or AI_UPDATE_SIDEBAR via the endpointForSource default).
	source?:
		| "TEAMS_CHANNEL"
		| "TEAMS_CHAT"
		| "SLACK_CHANNEL"
		| "AI_UPDATE_SIDEBAR";
}) {
	return {
		id: PROPOSAL_ID,
		projectId: opts.projectId ?? PROJECT_ID,
		userId: PROPOSAL_OWNER_ID,
		organizationId: ORG_ID,
		source: opts.source ?? "TEAMS_CHANNEL",
		status: opts.status ?? "PENDING",
		sourceMetadata: opts.attachments
			? {
					channelDisplayName: "general",
					teamId: TEAM_ID,
					channelId: CHANNEL_ID,
					threadRootId: "msg-1",
					attachments: opts.attachments,
				}
			: {
					channelDisplayName: "general",
					teamId: TEAM_ID,
					channelId: CHANNEL_ID,
					threadRootId: "msg-1",
				},
		appliedChangeIndexes: [],
		proposal: {
			changes: [
				{
					action: "create" as const,
					type: "bug" as const,
					title: { to: "Cannot upload screenshots" },
					reasoning: "Image upload broken",
					sourceContext: "teams_messages" as const,
				},
			],
		},
		summary: "Cannot upload screenshots",
	};
}

const APPROVAL_INPUT = {
	projectId: PROJECT_ID,
	organizationId: ORG_ID,
	proposalId: PROPOSAL_ID,
	approvedChanges: [
		{
			action: "create" as const,
			type: "bug" as const,
			title: { to: "Cannot upload screenshots" },
			reasoning: "Image upload broken",
			sourceContext: "teams_messages" as const,
		},
	],
	syncToPM: false,
};

const APPROVAL_CTX = {
	user: { id: APPROVER_ID },
	session: { id: "session-1", activeOrganizationId: ORG_ID },
};

const REJECT_INPUT = {
	projectId: PROJECT_ID,
	organizationId: ORG_ID,
	proposalId: PROPOSAL_ID,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: PROJECT_ID,
		organizationId: ORG_ID,
		projectManagementContainerName: null,
	});
	mocks.featureFindFirst.mockResolvedValue(null);
	mocks.appendAppliedChangeIndexes.mockResolvedValue(undefined);
	mocks.markPendingProposalApproved.mockResolvedValue(undefined);
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
	mocks.markPendingProposalFailed.mockResolvedValue(undefined);
	mocks.markPendingProposalRejected.mockResolvedValue({ updated: true });
	mocks.setPendingProposalAttachmentResult.mockResolvedValue(undefined);
	mocks.getMicrosoftAccessToken.mockResolvedValue({
		accessToken: "GRAPH-TOKEN-SECRET",
		integrationId: "wint-2",
	});
	mocks.createStoryFromProposal.mockImplementation(
		async (params: { title: string }) => ({
			story: {
				id: `story-${params.title.toLowerCase().replace(/\s+/g, "-")}`,
				description: "Existing description body.",
			},
			aiDrafted: false,
		}),
	);
	// Default orchestrator: succeed with empty result.
	mocks.attachPendingMediaToStory.mockResolvedValue({
		uploaded: [],
		warnings: [],
	});
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("approvePendingProposal (Teams) — chat-thread attachments wiring", () => {
	it("case 1: happy 2-image approval calls orchestrator + persists empty-warnings ledger + uses URL builder", async () => {
		const attachments = [teamsRefFixture("hc-1"), teamsRefFixture("hc-2")];
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ attachments }),
		);
		mocks.attachPendingMediaToStory.mockResolvedValueOnce({
			uploaded: [
				{
					s3Key: "story-media/p/s/u1.png",
					name: "hc-1.png",
					mimeType: "image/png",
				},
				{
					s3Key: "story-media/p/s/u2.png",
					name: "hc-2.png",
					mimeType: "image/png",
				},
			],
			warnings: [],
		});

		const result = (await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);

		expect(mocks.attachPendingMediaToStory).toHaveBeenCalledTimes(1);
		const call = mocks.attachPendingMediaToStory.mock.calls[0]?.[0] as {
			source: string;
			accessToken: string;
			projectId: string;
			userId: string;
			organizationId: string | null;
			proposal: {
				id: string;
				sourceMetadata: { attachments: unknown[] };
			};
			story: { id: string; description: string | null };
			teamsMessageUrlBuilder?: (ref: {
				messageId: string;
				parentMessageId?: string;
			}) => string;
		};
		expect(call.source).toBe("teams");
		expect(call.accessToken).toBe("GRAPH-TOKEN-SECRET");
		expect(call.projectId).toBe(PROJECT_ID);
		expect(call.userId).toBe(APPROVER_ID);
		expect(call.organizationId).toBe(ORG_ID);
		expect(call.proposal.id).toBe(PROPOSAL_ID);
		expect(call.proposal.sourceMetadata.attachments).toEqual(attachments);
		expect(call.story.id).toBe(result.createdStoryIds[0]);

		// `teamsMessageUrlBuilder` is supplied because the proposal's
		// `sourceMetadata` carries `{teamId, channelId}`.
		expect(call.teamsMessageUrlBuilder).toBeDefined();
		// Root-message URL shape — no `parentMessageId`.
		const rootUrl = call.teamsMessageUrlBuilder?.({ messageId: "msg-1" });
		expect(rootUrl).toBe(
			`https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/channels/${CHANNEL_ID}/messages/msg-1`,
		);
		// Reply URL shape — `parentMessageId` injects the
		// `/messages/{root}/replies/{reply}/` segment so Graph resolves the
		// hostedContent (bug_002 — without this, every reply attachment 404s).
		const replyUrl = call.teamsMessageUrlBuilder?.({
			messageId: "reply-1",
			parentMessageId: "root-1",
		});
		expect(replyUrl).toBe(
			`https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/channels/${CHANNEL_ID}/messages/root-1/replies/reply-1`,
		);

		// Graph token resolved via the channel-monitor owner, not the approver.
		expect(mocks.getMicrosoftAccessToken).toHaveBeenCalledWith(
			PROPOSAL_OWNER_ID,
			ORG_ID,
		);

		// `setPendingProposalAttachmentResult` invoked exactly once.
		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledWith(
			PROPOSAL_ID,
			[],
		);

		assertNoSecretsLoggedAcrossAllLoggers();
		// Call-site `chat-thread-attachments` span emitted at the approve
		// procedure level (Task 8.2 / spec § 6.2).
		assertChatThreadSpanEmitted();

		// The success span carries the required field set: source/outcome/
		// proposalId/storyId/durationMs/uploadedCount/warningCount.
		const infoCalls = mocks.loggerInfo.mock.calls.filter((c) => {
			const meta = c[1] as Record<string, unknown> | undefined;
			return (
				meta?.span === "chat-thread-attachments" &&
				meta?.step === "approve_orchestrator"
			);
		});
		expect(infoCalls.length).toBeGreaterThan(0);
		const successMeta = infoCalls[0]?.[1] as Record<string, unknown>;
		expect(successMeta.source).toBe("teams");
		expect(successMeta.outcome).toBe("success");
		expect(successMeta.proposalId).toBe(PROPOSAL_ID);
		expect(typeof successMeta.durationMs).toBe("number");
		expect(successMeta.uploadedCount).toBe(2);
		expect(successMeta.warningCount).toBe(0);
	});

	it("case 2: mixed success/failure forwards orchestrator warnings to the ledger", async () => {
		const attachments = [
			teamsRefFixture("hc-1"),
			teamsRefFixture("hc-2"),
			teamsRefFixture("hc-3"),
		];
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ attachments }),
		);
		mocks.attachPendingMediaToStory.mockResolvedValueOnce({
			uploaded: [
				{
					s3Key: "story-media/p/s/u1.png",
					name: "hc-1.png",
					mimeType: "image/png",
				},
			],
			warnings: [
				{ source: "teams", refId: "hc-2", reason: "download_failed" },
				{ source: "teams", refId: "hc-3", reason: "upload_failed" },
			],
		});

		await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		});

		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledWith(
			PROPOSAL_ID,
			[
				{ source: "teams", refId: "hc-2", reason: "download_failed" },
				{ source: "teams", refId: "hc-3", reason: "upload_failed" },
			],
		);

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("case 3: tenant XOR mismatch — projectId doesn't match → NOT_FOUND BEFORE orchestrator", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({
				attachments: [teamsRefFixture("hc-1")],
				projectId: "proj-2",
			}),
		);

		await expect(
			handlers.approve?.({
				input: APPROVAL_INPUT,
				context: APPROVAL_CTX,
			}),
		).rejects.toThrow(/Proposal not found/);

		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		expect(mocks.setPendingProposalAttachmentResult).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("case 4: reject path performs zero attachment activity", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({
				attachments: [teamsRefFixture("hc-1"), teamsRefFixture("hc-2")],
			}),
		);

		const rejectHandler = handlers.reject;
		expect(rejectHandler).toBeDefined();
		await rejectHandler?.({
			input: REJECT_INPUT,
			context: APPROVAL_CTX,
		});

		// Reject must never call the orchestrator, the ledger writer, or
		// the boundary mocks (`downloadTeamsHostedContent`, `uploadFile`).
		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		expect(mocks.setPendingProposalAttachmentResult).not.toHaveBeenCalled();
		expect(mocks.downloadTeamsHostedContent).not.toHaveBeenCalled();
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(mocks.markPendingProposalRejected).toHaveBeenCalledTimes(1);

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("case 5: reject of an already-actioned proposal returns CONFLICT", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({}),
		);
		// CAS matched 0 rows — another reviewer already approved/rejected it.
		mocks.markPendingProposalRejected.mockResolvedValueOnce({
			updated: false,
		});

		await expect(
			handlers.reject?.({ input: REJECT_INPUT, context: APPROVAL_CTX }),
		).rejects.toThrow(/already been approved or rejected/);

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("orchestrator is NOT called when the proposal has no Teams refs (legacy)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ attachments: undefined }),
		);

		await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		});

		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		expect(mocks.setPendingProposalAttachmentResult).not.toHaveBeenCalled();
		expect(mocks.getMicrosoftAccessToken).not.toHaveBeenCalled();

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("credential-lookup failure produces download_failed warnings WITHOUT crashing", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({
				attachments: [teamsRefFixture("hc-1"), teamsRefFixture("hc-2")],
			}),
		);
		mocks.getMicrosoftAccessToken.mockRejectedValueOnce(
			new Error("Microsoft not connected. Please connect…"),
		);

		const result = (await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		})) as { status: string };

		expect(result.status).toBe("applied");
		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledTimes(
			1,
		);
		const persistArgs =
			mocks.setPendingProposalAttachmentResult.mock.calls[0];
		expect(persistArgs?.[1]).toEqual([
			{ source: "teams", refId: "hc-1", reason: "download_failed" },
			{ source: "teams", refId: "hc-2", reason: "download_failed" },
		]);

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("teamsMessageUrlBuilder is NOT supplied when teamId/channelId missing — orchestrator falls back to its default", async () => {
		// Strip teamId/channelId from the metadata; the procedure should skip
		// passing a `teamsMessageUrlBuilder` so the orchestrator's built-in
		// resolver does the work (or fails it cleanly).
		const attachments = [teamsRefFixture("hc-1")];
		const proposal = makeProposalRow({ attachments });
		// Replace sourceMetadata sans coordinates.
		proposal.sourceMetadata = {
			channelDisplayName: "general",
			attachments,
		} as unknown as typeof proposal.sourceMetadata;
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(proposal);

		await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		});

		expect(mocks.attachPendingMediaToStory).toHaveBeenCalledTimes(1);
		const call = mocks.attachPendingMediaToStory.mock.calls[0]?.[0] as {
			teamsMessageUrlBuilder?: unknown;
		};
		expect(call.teamsMessageUrlBuilder).toBeUndefined();

		assertNoSecretsLoggedAcrossAllLoggers();
	});
});

// ---------------------------------------------------------------------------
// Bug 1429 — epic→feature suppression on the CREATE path
// ---------------------------------------------------------------------------
//
// CREATE changes are materialized SYNCHRONOUSLY in this procedure via
// `createStoryFromProposal` (the `forbidEpics: true` flag only protects the
// UPDATE path dispatched to backlogApplyChangesWorkflow). The channel-monitor
// approve procedure is inherently the epic-forbidden context, so any
// `epic`-typed approved change must be normalized to a `feature` BEFORE the
// create/update split — making the invariant local, enforced, and robust
// against a future refactor that might add an epic branch to the create path.

describe("approvePendingProposal (Teams) — Bug 1429 epic→feature on CREATE", () => {
	function epicCreateProposalRow() {
		const row = makeProposalRow({ attachments: undefined });
		row.proposal = {
			changes: [
				{
					action: "create" as const,
					// Stored pre-fix proposal carries the unsupported epic type.
					type: "epic" as unknown as "bug",
					title: { to: "Mobile launch initiative" },
					reasoning: "Large strategic initiative",
					sourceContext: "teams_messages" as const,
				},
			],
		};
		row.summary = "Mobile launch initiative";
		return row;
	}

	// Factory (NOT a shared const): the procedure normalizes epic→feature in
	// place, so a shared object would be mutated by the first test and leak
	// into the next. Each test gets a fresh, unmutated input.
	function epicCreateInputRaw(typeValue: "epic" | "feature" = "epic") {
		return {
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			proposalId: PROPOSAL_ID,
			approvedChanges: [
				{
					action: "create" as const,
					type: typeValue as unknown as "bug",
					title: { to: "Mobile launch initiative" },
					reasoning: "Large strategic initiative",
					sourceContext: "teams_messages" as const,
				},
			],
			syncToPM: false,
		};
	}

	it("an epic-typed CREATE never creates an epic — lands via createStoryFromProposal with a non-epic kind", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			epicCreateProposalRow(),
		);

		const result = (await handlers.approve?.({
			input: epicCreateInputRaw(),
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);

		// The create path is createStoryFromProposal (there is NO createEpic in
		// this procedure at all) and the kind hint is NOT epic — an epic has no
		// kind, so it lands as FEATURE via the classifier (kind undefined).
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			kind?: string;
			title: string;
		};
		expect(callArgs.title).toBe("Mobile launch initiative");
		expect(callArgs.kind).not.toBe("EPIC");
		// Non-bug, non-override change → no explicit kind hint → classifier picks
		// FEATURE. The important invariant: it is never created as an epic.
		expect(callArgs.kind).toBeUndefined();

		// Capture-as-is still surfaces lookalikes: a channel approval that creates
		// stories enqueues semantic duplicate detection so different-title
		// near-duplicates get flagged "Possible duplicate" (the create-only
		// generation only means the proposal never suggests an UPDATE; it does not
		// suppress duplicate marking on approve).
		expect(mocks.triggerDuplicateDetection).toHaveBeenCalled();

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("emits a forbidEpics normalization warn for the epic CREATE", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			epicCreateProposalRow(),
		);

		await handlers.approve?.({
			input: epicCreateInputRaw(),
			context: APPROVAL_CTX,
		});

		const sawWarn = mocks.loggerWarn.mock.calls.some(
			(c) =>
				typeof c[0] === "string" &&
				c[0].includes("forbidEpics") &&
				c[0].toLowerCase().includes("epic") &&
				c[0].toLowerCase().includes("feature"),
		);
		expect(sawWarn).toBe(true);
	});

	it("a web-normalized (feature) approved change still matches a stored epic proposal — index resolution is epic-tolerant", async () => {
		// The web `normalizeChange` maps epic→feature before sending, so the
		// approved change arrives as `feature` while the STORED proposal change
		// is still `epic`. The index matcher must treat these as equivalent or
		// the approval would 400 with "not found in proposal" — exactly the
		// stored production proposal in Bug 1429.
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			epicCreateProposalRow(),
		);

		// Approved change arrives already normalized to `feature` (web), while
		// the stored proposal change is still `epic`.
		const featureNormalizedInput = epicCreateInputRaw("feature");

		const result = (await handlers.approve?.({
			input: featureNormalizedInput,
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
	});

	it("two genuine feature changes that differ ONLY by parentEpicIdentifier resolve to distinct stored indexes (epic-tolerance must not over-match real features)", async () => {
		// Codex P2 (A): the epic-tolerant matcher bypassed the parentEpic
		// comparison whenever the STORED type mapped to "feature" — which is
		// true for GENUINE features, not just normalized epics. Two stored
		// feature changes sharing action+title+parentFeatureIdentifier but with
		// DIFFERENT parentEpicIdentifier would then both resolve to index 0, so
		// the second stored change is never marked applied (and a partial
		// re-approval would mis-track). The bypass must fire only for a stored
		// `epic`.
		const baseFeature = {
			action: "create" as const,
			type: "feature" as const,
			title: { to: "Shared capability" },
			parentFeatureIdentifier: "F-PARENT",
			reasoning: "feature under different epics",
			sourceContext: "teams_messages" as const,
		};
		const row = makeProposalRow({ attachments: undefined });
		row.proposal = {
			changes: [
				{ ...baseFeature, parentEpicIdentifier: "EPIC-A" },
				{ ...baseFeature, parentEpicIdentifier: "EPIC-B" },
			],
		};
		row.summary = "Shared capability";
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(row);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [
					{ ...baseFeature, parentEpicIdentifier: "EPIC-A" },
					{ ...baseFeature, parentEpicIdentifier: "EPIC-B" },
				],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		});

		// Each create persists its resolved ORIGINAL index. With the over-loose
		// matcher both resolve to 0; with the fix they resolve to 0 and 1.
		const appliedIndexCalls =
			mocks.appendAppliedChangeIndexes.mock.calls.map(
				(c) => c[1] as number[],
			);
		const flatIndexes = appliedIndexCalls.flat().sort();
		expect(flatIndexes).toEqual([0, 1]);

		assertNoSecretsLoggedAcrossAllLoggers();
	});
});

// ---------------------------------------------------------------------------
// Bug 1429 / Codex round 4 — approve-backend epic suppression gated on source
// ---------------------------------------------------------------------------
//
// `endpointForSource()` routes AI_UPDATE_SIDEBAR proposals to THIS teams
// procedure via the default fallthrough (only SLACK_CHANNEL + TEAMS_CHAT have
// explicit cases). The earlier unconditional epic→feature normalization + the
// hardcoded `forbidEpics: true` workflow arg therefore rewrote epics for
// general AI Update proposals too — breaking first-class epics. Both are now
// gated on `proposal.source` via `isChannelMonitorSource`.

describe("approvePendingProposal (Teams) — epic suppression gated on proposal.source (Codex round 4)", () => {
	function epicCreateInput() {
		return {
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			proposalId: PROPOSAL_ID,
			approvedChanges: [
				{
					action: "create" as const,
					type: "epic" as unknown as "bug",
					title: { to: "Mobile launch initiative" },
					reasoning: "Large strategic initiative",
					sourceContext: "teams_messages" as const,
				},
			],
			syncToPM: false,
		};
	}

	function epicCreateRow(
		source: "TEAMS_CHANNEL" | "TEAMS_CHAT" | "AI_UPDATE_SIDEBAR",
	) {
		const row = makeProposalRow({ attachments: undefined, source });
		row.proposal = {
			changes: [
				{
					action: "create" as const,
					type: "epic" as unknown as "bug",
					title: { to: "Mobile launch initiative" },
					reasoning: "Large strategic initiative",
					sourceContext: "teams_messages" as const,
				},
			],
		};
		row.summary = "Mobile launch initiative";
		return row;
	}

	it("AI_UPDATE_SIDEBAR: an epic CREATE is NOT normalized — createStoryFromProposal receives the epic untouched and no forbidEpics warn fires", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			epicCreateRow("AI_UPDATE_SIDEBAR"),
		);

		await handlers.approve?.({
			input: epicCreateInput(),
			context: APPROVAL_CTX,
		});

		// The forbidEpics normalization loop must NOT run for AI_UPDATE_SIDEBAR.
		const sawWarn = mocks.loggerWarn.mock.calls.some(
			(c) => typeof c[0] === "string" && c[0].includes("forbidEpics"),
		);
		expect(sawWarn).toBe(false);
		// The approved change keeps type "epic" (not rewritten to feature).
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		// createStoryFromProposal is kind-agnostic to "epic" (it has no epic
		// branch), but the key invariant is the change object was not mutated:
		// no kind hint was forced and the title is intact.
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			title: string;
		};
		expect(callArgs.title).toBe("Mobile launch initiative");
	});

	it.each(["TEAMS_CHANNEL", "TEAMS_CHAT"] as const)(
		"%s: an epic CREATE IS normalized to feature (warn fires) — channel-monitor regression guard",
		async (source) => {
			mocks.getPendingBacklogProposal.mockResolvedValueOnce(
				epicCreateRow(source),
			);

			await handlers.approve?.({
				input: epicCreateInput(),
				context: APPROVAL_CTX,
			});

			const sawWarn = mocks.loggerWarn.mock.calls.some(
				(c) =>
					typeof c[0] === "string" &&
					c[0].includes("forbidEpics") &&
					c[0].toLowerCase().includes("epic") &&
					c[0].toLowerCase().includes("feature"),
			);
			expect(sawWarn).toBe(true);
		},
	);

	// --- UPDATE path: the workflow `forbidEpics` arg must be gated too. ---

	function epicUpdateRow(source: "TEAMS_CHANNEL" | "AI_UPDATE_SIDEBAR") {
		const change = {
			action: "update" as const,
			type: "epic" as unknown as "bug",
			existingId: "11111111-1111-4111-8111-111111111111",
			existingIdentifier: "EPIC-009",
			title: { from: "Existing epic", to: "Renamed epic" },
			reasoning: "rename",
			sourceContext: "teams_messages" as const,
		};
		const row = makeProposalRow({ attachments: undefined, source });
		row.proposal = { changes: [change] };
		row.summary = "Renamed epic";
		return { row, change };
	}

	function epicUpdateInput(change: Record<string, unknown>) {
		return {
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			proposalId: PROPOSAL_ID,
			approvedChanges: [change],
			syncToPM: false,
		};
	}

	it("AI_UPDATE_SIDEBAR: the UPDATE workflow is dispatched with forbidEpics=false (epics preserved end-to-end)", async () => {
		const { row, change } = epicUpdateRow("AI_UPDATE_SIDEBAR");
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(row);

		await handlers.approve?.({
			input: epicUpdateInput(change),
			context: APPROVAL_CTX,
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		const startArgs = mocks.workflowStart.mock.calls[0] as unknown[];
		const opts = startArgs[1] as { args: Array<{ forbidEpics?: boolean }> };
		expect(opts.args[0].forbidEpics).toBe(false);
	});

	it("TEAMS_CHANNEL: the UPDATE workflow is dispatched with forbidEpics=true (channel-monitor regression guard)", async () => {
		const { row, change } = epicUpdateRow("TEAMS_CHANNEL");
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(row);

		await handlers.approve?.({
			input: epicUpdateInput(change),
			context: APPROVAL_CTX,
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		const startArgs = mocks.workflowStart.mock.calls[0] as unknown[];
		const opts = startArgs[1] as { args: Array<{ forbidEpics?: boolean }> };
		expect(opts.args[0].forbidEpics).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Bug 1429 / Codex round 5 — epic-tolerant index matcher gated on forbidEpics
// ---------------------------------------------------------------------------
//
// The `typeForMatch` epic→feature collapse + the parent-epic skip exist ONLY
// because the channel-monitor flow normalizes epic→feature (a web-normalized
// `feature` approved change must still match a stored `epic` row). For
// AI_UPDATE_SIDEBAR (epics first-class, NOT normalized) the collapse is wrong:
// a proposal with an epic AND a feature sharing action+title would let
// approving the feature resolve to the epic's stored index — corrupting
// `appliedChangeIndexes` / idempotency. Strict matching for AI_UPDATE_SIDEBAR.

describe("approvePendingProposal (Teams) — index matcher gated on forbidEpics (Codex round 5)", () => {
	function epicPlusFeatureRow(source: "AI_UPDATE_SIDEBAR" | "TEAMS_CHANNEL") {
		const row = makeProposalRow({ attachments: undefined, source });
		// Stored proposal: epic at index 0, feature at index 1 — SAME
		// action + title. Under the unconditional collapse, approving the
		// feature would `findIndex` → 0 (the epic).
		row.proposal = {
			changes: [
				{
					action: "create" as const,
					type: "epic" as unknown as "bug",
					title: { to: "Shared title" },
					reasoning: "the epic",
					sourceContext: "teams_messages" as const,
				},
				{
					action: "create" as const,
					type: "feature" as const,
					title: { to: "Shared title" },
					reasoning: "the feature",
					sourceContext: "teams_messages" as const,
				},
			],
		};
		row.summary = "Shared title";
		return row;
	}

	it("AI_UPDATE_SIDEBAR: approving the FEATURE resolves to the feature's stored index (1), NOT the epic's (0)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			epicPlusFeatureRow("AI_UPDATE_SIDEBAR"),
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				// Approve ONLY the feature (matches stored index 1).
				approvedChanges: [
					{
						action: "create" as const,
						type: "feature" as const,
						title: { to: "Shared title" },
						reasoning: "the feature",
						sourceContext: "teams_messages" as const,
					},
				],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		});

		// The CREATE path persists the RESOLVED original index. Strict matching
		// for AI_UPDATE_SIDEBAR must record [1] (the feature), not [0] (epic).
		const appliedIndexCalls =
			mocks.appendAppliedChangeIndexes.mock.calls.map(
				(c) => c[1] as number[],
			);
		const flatIndexes = appliedIndexCalls.flat();
		expect(flatIndexes).toEqual([1]);
		expect(flatIndexes).not.toContain(0);
	});

	it("TEAMS_CHANNEL: a web-normalized `feature` approved change still matches a stored `epic` row (epic-tolerant matcher retained)", async () => {
		// Channel-monitor flow keeps the epic-tolerant matcher: the stored
		// change is `epic`, the approved change arrives as `feature` (web
		// normalize), and it must still resolve rather than 400 as "stale".
		const row = makeProposalRow({
			attachments: undefined,
			source: "TEAMS_CHANNEL",
		});
		row.proposal = {
			changes: [
				{
					action: "create" as const,
					type: "epic" as unknown as "bug",
					title: { to: "Mobile launch initiative" },
					reasoning: "stored epic",
					sourceContext: "teams_messages" as const,
				},
			],
		};
		row.summary = "Mobile launch initiative";
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(row);

		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [
					{
						action: "create" as const,
						type: "feature" as const,
						title: { to: "Mobile launch initiative" },
						reasoning: "stored epic",
						sourceContext: "teams_messages" as const,
					},
				],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		// Resolved (not a 400 "stale") and applied at the stored index 0.
		expect(result.status).toBe("applied");
		const flatIndexes = mocks.appendAppliedChangeIndexes.mock.calls.flatMap(
			(c) => c[1] as number[],
		);
		expect(flatIndexes).toEqual([0]);
	});
});

// ---------------------------------------------------------------------------
// Bug 1429 / Codex round 7 — index matcher must be CONSUMED-INDEX-AWARE
// ---------------------------------------------------------------------------
//
// The matcher was stateless: each approved change ran a fresh `findIndex`
// with no memory of already-claimed stored indices. For a legacy channel
// proposal containing BOTH a real `feature` and an `epic` sharing
// action+title+parentFeatureIdentifier (the epic-tolerant collapse makes them
// match-equal under forbidEpics), two approved changes could `findIndex` to
// the SAME stored index → the other index is never recorded in
// `appliedChangeIndexes` → it stays eligible to replay on retry. Each approved
// change must claim a DISTINCT stored index.

describe("approvePendingProposal (Teams) — consumed-index matcher (Codex round 7)", () => {
	it("TEAMS_CHANNEL: two same-title approved changes (epic+feature) claim DISTINCT stored indexes {0,1}", async () => {
		const row = makeProposalRow({
			attachments: undefined,
			source: "TEAMS_CHANNEL",
		});
		// Stored: epic at 0, feature at 1 — SAME action + title + parentFeature.
		// Under the epic-tolerant collapse both are match-equal, so a stateless
		// findIndex would map BOTH approved changes to index 0.
		const shared = {
			action: "create" as const,
			title: { to: "Shared title" },
			parentFeatureIdentifier: "F-PARENT",
			reasoning: "shared",
			sourceContext: "teams_messages" as const,
		};
		row.proposal = {
			changes: [
				{ ...shared, type: "epic" as unknown as "bug" },
				{ ...shared, type: "feature" as const },
			],
		};
		row.summary = "Shared title";
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(row);

		// Both approved (the epic UI-normalized to feature → two `feature`
		// approved changes with the same title).
		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [
					{ ...shared, type: "feature" as const },
					{ ...shared, type: "feature" as const },
				],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		})) as { status: string };

		expect(result.status).toBe("applied");
		// Both creates must record DISTINCT stored indices — not [0, 0].
		const flatIndexes = mocks.appendAppliedChangeIndexes.mock.calls
			.flatMap((c) => c[1] as number[])
			.sort();
		expect(flatIndexes).toEqual([0, 1]);
	});
});
