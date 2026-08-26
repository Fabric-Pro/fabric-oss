/**
 * Integration tests for the Slack `approve-pending-proposal` procedure's
 * wiring of the chat-thread image-attachments orchestrator
 * (`attachPendingMediaToStory`) and the apply-time warning ledger
 * (`setPendingProposalAttachmentResult`). Spec § 9.2 (Slack).
 *
 * Cases (per spec § 9.2):
 *   1. Happy 2-image approval — proposal carries 2 Slack refs in
 *      `sourceMetadata.attachments`; orchestrator is invoked with the right
 *      arguments; warnings are persisted (empty list) once after the create
 *      loop.
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
 * `setPendingProposalAttachmentResult`, `getSlackCredentials`,
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
		featureFindMany: vi.fn(),
		// External services
		createStoryFromProposal: vi.fn(),
		// Regression guard: monitored-channel approvals must NOT trigger semantic
		// duplicate detection (capture-as-is). Captured here so a create-path
		// test can assert it is never called.
		triggerDuplicateDetection: vi.fn(async () => ({
			workflowId: "dup-detect-test",
		})),
		attachPendingMediaToStory: vi.fn(),
		getSlackCredentials: vi.fn(),
		uploadFile: vi.fn(),
		downloadSlackFile: vi.fn(),
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
		feature: { findMany: mocks.featureFindMany },
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
	// can share one implementation. Default stub: no collision, so
	// existing tests run their full create path.
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
		workflow: { start: vi.fn() },
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
	"xoxb-test-secret",
	"accessToken",
	"url_private",
	"urlPrivate",
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

function slackRefFixture(id: string, size = 200 * 1024) {
	return {
		source: "slack" as const,
		file: {
			id,
			name: `${id}.png`,
			title: `Slack file ${id}`,
			mimetype: "image/png",
			urlPrivate: `https://files.slack.com/${id}/url_private`,
			size,
		},
		messageTs: "1690000000.123",
	};
}

function makeProposalRow(opts: {
	attachments?: unknown[];
	projectId?: string;
	status?: "PENDING" | "APPLIED" | "REJECTED" | "FAILED" | "APPROVED";
	// PendingBacklogProposalSource. The approve-backend epic-suppression (Bug
	// 1429 / Codex round 4) gates on this; the Slack endpoint only ever serves
	// SLACK_CHANNEL proposals.
	source?:
		| "SLACK_CHANNEL"
		| "TEAMS_CHANNEL"
		| "TEAMS_CHAT"
		| "AI_UPDATE_SIDEBAR";
}) {
	return {
		id: PROPOSAL_ID,
		projectId: opts.projectId ?? PROJECT_ID,
		userId: PROPOSAL_OWNER_ID,
		organizationId: ORG_ID,
		source: opts.source ?? "SLACK_CHANNEL",
		status: opts.status ?? "PENDING",
		sourceMetadata: opts.attachments
			? {
					channelId: "C-channel",
					threadTs: "1690000000.123",
					slackTeamId: "T-team",
					attachments: opts.attachments,
				}
			: {
					channelId: "C-channel",
					threadTs: "1690000000.123",
					slackTeamId: "T-team",
				},
		appliedChangeIndexes: [],
		proposal: {
			changes: [
				{
					action: "create" as const,
					type: "bug" as const,
					title: { to: "Login fails on Friday" },
					reasoning: "users hit error",
					sourceContext: "slack_messages" as const,
				},
			],
		},
		summary: "Login fails",
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
			title: { to: "Login fails on Friday" },
			reasoning: "users hit error",
			sourceContext: "slack_messages" as const,
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
	mocks.featureFindMany.mockResolvedValue([]);
	mocks.appendAppliedChangeIndexes.mockResolvedValue(undefined);
	mocks.markPendingProposalApproved.mockResolvedValue(undefined);
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
	mocks.markPendingProposalFailed.mockResolvedValue(undefined);
	mocks.markPendingProposalRejected.mockResolvedValue({ updated: true });
	mocks.setPendingProposalAttachmentResult.mockResolvedValue(undefined);
	mocks.getSlackCredentials.mockResolvedValue({
		accessToken: "xoxb-test-secret",
		integrationId: "wint-1",
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

describe("approvePendingProposal (Slack) — chat-thread attachments wiring", () => {
	it("case 1: happy 2-image approval calls orchestrator + persists empty-warnings ledger", async () => {
		const attachments = [slackRefFixture("F1"), slackRefFixture("F2")];
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ attachments }),
		);
		// Mimic the orchestrator's contract: 2 successful uploads, no warnings.
		mocks.attachPendingMediaToStory.mockResolvedValueOnce({
			uploaded: [
				{
					s3Key: "story-media/p/s/u1.png",
					name: "F1.png",
					mimeType: "image/png",
				},
				{
					s3Key: "story-media/p/s/u2.png",
					name: "F2.png",
					mimeType: "image/png",
				},
			],
			warnings: [],
		});

		const result = (await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		})) as {
			status: string;
			createdStoryIds: string[];
		};

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);

		// Orchestrator invoked exactly once for the one CREATE change.
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
		};
		expect(call.source).toBe("slack");
		expect(call.accessToken).toBe("xoxb-test-secret");
		expect(call.projectId).toBe(PROJECT_ID);
		expect(call.userId).toBe(APPROVER_ID);
		expect(call.organizationId).toBe(ORG_ID);
		expect(call.proposal.id).toBe(PROPOSAL_ID);
		// `sourceMetadata.attachments` filtered to Slack refs only.
		expect(call.proposal.sourceMetadata.attachments).toEqual(attachments);
		expect(call.story.id).toBe(result.createdStoryIds[0]);

		// Slack creds resolved via the channel-monitor owner, not the approver.
		expect(mocks.getSlackCredentials).toHaveBeenCalledWith(
			PROPOSAL_OWNER_ID,
			ORG_ID,
		);

		// `setPendingProposalAttachmentResult` invoked exactly once at the end
		// of the create loop with the empty warning array.
		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledWith(
			PROPOSAL_ID,
			[],
		);

		// No secrets ever leaked into any log call.
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
		expect(successMeta.source).toBe("slack");
		expect(successMeta.outcome).toBe("success");
		expect(successMeta.proposalId).toBe(PROPOSAL_ID);
		expect(typeof successMeta.durationMs).toBe("number");
		expect(successMeta.uploadedCount).toBe(2);
		expect(successMeta.warningCount).toBe(0);
	});

	it("case 2: mixed success/failure forwards orchestrator warnings to the ledger", async () => {
		const attachments = [
			slackRefFixture("F1"),
			slackRefFixture("F2"),
			slackRefFixture("F3"),
		];
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ attachments }),
		);
		mocks.attachPendingMediaToStory.mockResolvedValueOnce({
			uploaded: [
				{
					s3Key: "story-media/p/s/u1.png",
					name: "F1.png",
					mimeType: "image/png",
				},
			],
			warnings: [
				{ source: "slack", refId: "F2", reason: "download_failed" },
				{ source: "slack", refId: "F3", reason: "upload_failed" },
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
				{ source: "slack", refId: "F2", reason: "download_failed" },
				{ source: "slack", refId: "F3", reason: "upload_failed" },
			],
		);

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("case 3: tenant XOR mismatch — projectId doesn't match → NOT_FOUND BEFORE orchestrator", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({
				attachments: [slackRefFixture("F1")],
				// Proposal belongs to a DIFFERENT project.
				projectId: "proj-2",
			}),
		);

		await expect(
			handlers.approve?.({
				input: APPROVAL_INPUT,
				context: APPROVAL_CTX,
			}),
		).rejects.toThrow(/Proposal not found/);

		// Critical: orchestrator + ledger writers must never run on a tenant
		// mismatch. The procedure throws BEFORE the create loop.
		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		expect(mocks.setPendingProposalAttachmentResult).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("case 4: reject path performs zero attachment activity", async () => {
		// The reject procedure shape — exercise the registered handler.
		// `markPendingProposalRejected` is the only DB write we expect.
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({
				attachments: [slackRefFixture("F1"), slackRefFixture("F2")],
			}),
		);

		const rejectHandler = handlers.reject;
		expect(rejectHandler).toBeDefined();
		await rejectHandler?.({
			input: REJECT_INPUT,
			context: APPROVAL_CTX,
		});

		// Reject must never call the orchestrator, the ledger writer, or
		// the boundary mocks (`downloadSlackFile`, `uploadFile`).
		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		expect(mocks.setPendingProposalAttachmentResult).not.toHaveBeenCalled();
		expect(mocks.downloadSlackFile).not.toHaveBeenCalled();
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		// Proposal status flipped to REJECTED.
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

	it("orchestrator is NOT called when the proposal has no Slack refs (legacy)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ attachments: undefined }),
		);

		await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		});

		// Empty-input short-circuit — neither the orchestrator nor the ledger
		// write fires. Saves a DB round-trip for legacy proposals.
		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		expect(mocks.setPendingProposalAttachmentResult).not.toHaveBeenCalled();
		expect(mocks.getSlackCredentials).not.toHaveBeenCalled();

		assertNoSecretsLoggedAcrossAllLoggers();
	});

	it("credential-lookup failure produces scope_missing warnings WITHOUT crashing", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({
				attachments: [slackRefFixture("F1"), slackRefFixture("F2")],
			}),
		);
		mocks.getSlackCredentials.mockRejectedValueOnce(
			new Error("Slack not connected. Please connect…"),
		);

		const result = (await handlers.approve?.({
			input: APPROVAL_INPUT,
			context: APPROVAL_CTX,
		})) as { status: string };

		// Approval still succeeds — the user-facing response must not crash on
		// integration outages (FR-23).
		expect(result.status).toBe("applied");
		// Orchestrator never invoked because credentials couldn't be resolved.
		expect(mocks.attachPendingMediaToStory).not.toHaveBeenCalled();
		// Per-ref scope_missing warnings persisted so the inbox UI reflects
		// the failure with the same shape the orchestrator would emit.
		expect(mocks.setPendingProposalAttachmentResult).toHaveBeenCalledTimes(
			1,
		);
		const persistArgs =
			mocks.setPendingProposalAttachmentResult.mock.calls[0];
		expect(persistArgs?.[1]).toEqual([
			{ source: "slack", refId: "F1", reason: "scope_missing" },
			{ source: "slack", refId: "F2", reason: "scope_missing" },
		]);

		assertNoSecretsLoggedAcrossAllLoggers();
	});
});

// ---------------------------------------------------------------------------
// Bug 1429 — epic→feature suppression on the CREATE path (Slack mirror)
// ---------------------------------------------------------------------------
//
// See the Teams equivalent for the full rationale. CREATE changes are
// materialized synchronously here via `createStoryFromProposal`; the
// `forbidEpics: true` flag only guards the UPDATE workflow path. The
// channel-monitor approve procedure is inherently epic-forbidden, so an
// `epic`-typed approved change is normalized to `feature` before the
// create/update split.

describe("approvePendingProposal (Slack) — Bug 1429 epic→feature on CREATE", () => {
	function epicCreateProposalRow() {
		const row = makeProposalRow({ attachments: undefined });
		row.proposal = {
			changes: [
				{
					action: "create" as const,
					type: "epic" as unknown as "bug",
					title: { to: "Mobile launch initiative" },
					reasoning: "Large strategic initiative",
					sourceContext: "slack_messages" as const,
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
					sourceContext: "slack_messages" as const,
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

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			kind?: string;
			title: string;
		};
		expect(callArgs.title).toBe("Mobile launch initiative");
		expect(callArgs.kind).not.toBe("EPIC");
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
		// Codex P2 (A) — see Teams mirror. The parentEpic bypass must fire only
		// for a stored `epic`, never for genuine features.
		const baseFeature = {
			action: "create" as const,
			type: "feature" as const,
			title: { to: "Shared capability" },
			parentFeatureIdentifier: "F-PARENT",
			reasoning: "feature under different epics",
			sourceContext: "slack_messages" as const,
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
// Bug 1429 / Codex round 7 — index matcher must be CONSUMED-INDEX-AWARE (Slack)
// ---------------------------------------------------------------------------
//
// Mirror of the Teams round-7 test. Slack only serves SLACK_CHANNEL
// (forbidEpics always true), so the epic-tolerant collapse applies: a legacy
// proposal with an epic + feature sharing action+title+parentFeature must
// still assign two DISTINCT stored indices when both are approved, not collide
// on the same index (which would leave the other replay-eligible).

describe("approvePendingProposal (Slack) — consumed-index matcher (Codex round 7)", () => {
	it("two same-title approved changes (epic+feature) claim DISTINCT stored indexes {0,1}", async () => {
		const row = makeProposalRow({
			attachments: undefined,
			source: "SLACK_CHANNEL",
		});
		const shared = {
			action: "create" as const,
			title: { to: "Shared title" },
			parentFeatureIdentifier: "F-PARENT",
			reasoning: "shared",
			sourceContext: "slack_messages" as const,
		};
		row.proposal = {
			changes: [
				{ ...shared, type: "epic" as unknown as "bug" },
				{ ...shared, type: "feature" as const },
			],
		};
		row.summary = "Shared title";
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(row);

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
		const flatIndexes = mocks.appendAppliedChangeIndexes.mock.calls
			.flatMap((c) => c[1] as number[])
			.sort();
		expect(flatIndexes).toEqual([0, 1]);

		assertNoSecretsLoggedAcrossAllLoggers();
	});
});
