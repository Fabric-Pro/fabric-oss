/**
 * Unit tests for `autoAnalyzeMeetingTranscriptActivity`.
 *
 * Mock shape mirrors `slack-channel-monitor/__tests__/analyze-slack-thread.test.ts`:
 * partial-mock `@repo/database` (override `db.project.findUnique` + the scan-status
 * lifecycle helpers), fully mock `analyze-context` + `project-backlog-cache`, no-op
 * the heartbeat.
 *
 * The activity uses a status compare-and-set claim (NOT_SCANNED → IN_PROGRESS via
 * `claimMeetingTranscriptForAnalysis`) as the dedup lock, marks SCANNED on every
 * terminal-success path (`markMeetingTranscriptScanned`), and RELEASES the claim
 * (`releaseMeetingTranscriptAnalysisClaim`) on a retryable failure before a proposal
 * exists. A terminal failure is marked FAILED by the workflow, not here.
 *
 * Cases:
 *   - New transcript + both flags ON ⇒ claim then analyze once with expected args (AC2).
 *   - ≥1 change ⇒ createPendingBacklogProposal({source:"MONITORED_MEETING"}) +
 *     SCANNED + proposal id; sourceMetadata carries the transcript (AC3).
 *   - 0 changes ⇒ no proposal; marked SCANNED so it is never re-analyzed (AC4).
 *   - Either flag OFF ⇒ neither claim nor analyzer called (AC1).
 *   - Claim lost, already SCANNED ⇒ analyzer NOT called, no reconcile (AC5 dedup).
 *   - Claim lost, stuck IN_PROGRESS with analyzedAt ⇒ reconciled to SCANNED (AC5b).
 *   - Empty transcript ⇒ marked SCANNED, analyzer NOT called.
 *   - Analyzer throws (before a proposal exists) ⇒ claim RELEASED + propagates (AC6).
 *   - Failure AFTER the proposal is created ⇒ claim KEPT (no release) so a retry
 *     can never create a duplicate (C1 — the dedup guarantee).
 */

import type { DecisionPrecheckResult } from "@repo/agent-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectFindUnique = vi.fn();
const createPendingBacklogProposal = vi.fn();
const claimMeetingTranscriptForAnalysis = vi.fn();
const markMeetingTranscriptScanned = vi.fn();
const releaseMeetingTranscriptAnalysisClaim = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			project: {
				findUnique: (...a: unknown[]) => projectFindUnique(...a),
			},
		},
		createPendingBacklogProposal: (...a: unknown[]) =>
			createPendingBacklogProposal(...a),
		claimMeetingTranscriptForAnalysis: (...a: unknown[]) =>
			claimMeetingTranscriptForAnalysis(...a),
		markMeetingTranscriptScanned: (...a: unknown[]) =>
			markMeetingTranscriptScanned(...a),
		releaseMeetingTranscriptAnalysisClaim: (...a: unknown[]) =>
			releaseMeetingTranscriptAnalysisClaim(...a),
	};
});

const analyzeContextAndPropose = vi.fn();
vi.mock("../analyze-context", () => ({
	analyzeContextAndPropose: (...a: unknown[]) =>
		analyzeContextAndPropose(...a),
}));

const getCachedProjectBacklog = vi.fn();
vi.mock("../project-backlog-cache", () => ({
	getCachedProjectBacklog: (...a: unknown[]) => getCachedProjectBacklog(...a),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import {
	autoAnalyzeMeetingTranscriptActivity,
	MEETING_CAPTURE_USER_PROMPT,
} from "../auto-analyze-meeting-transcript";

const BASE_INPUT = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
	transcriptRecordId: "tr-rec-1",
	contextId: "ctx-1",
	meetingId: "meeting-1",
	transcriptId: "transcript-1",
	linkedMeetingId: "lm-1",
	meetingSubject: "Sprint planning",
	meetingDate: "2026-06-16T10:00:00.000Z",
	transcriptText:
		"## Meeting Transcript\nAlice: build CSV export.\nBob: agreed.",
};

const EMPTY_BACKLOG = { stories: [] };

const ONE_CHANGE_PROPOSAL = {
	summary: "Add CSV export",
	changes: [
		{
			type: "feature",
			action: "create",
			title: "CSV export",
			description: "Export the backlog as CSV.",
		},
	],
};

// A pre-check that flagged one contradiction — the ride-along shape
// `analyzeContextAndPropose` attaches to a proposal as `decisionConflicts`.
const DECISION_PRECHECK_CONFLICTS: DecisionPrecheckResult = {
	checkedAt: "2026-07-10T00:00:00.000Z",
	status: "conflicts",
	findings: [
		{
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres for primary storage",
			natureOfConflict: "Proposes migrating primary storage to DynamoDB",
			conflictType: "reintroduces_rejected",
			confidence: 0.9,
		},
	],
};

describe("autoAnalyzeMeetingTranscriptActivity", () => {
	beforeEach(() => {
		projectFindUnique.mockReset();
		createPendingBacklogProposal.mockReset();
		claimMeetingTranscriptForAnalysis.mockReset();
		markMeetingTranscriptScanned.mockReset();
		releaseMeetingTranscriptAnalysisClaim.mockReset();
		analyzeContextAndPropose.mockReset();
		getCachedProjectBacklog.mockReset();

		// Default-happy path: both flags ON, claim won, backlog empty, one CREATE.
		projectFindUnique.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});
		claimMeetingTranscriptForAnalysis.mockResolvedValue({ claimed: true });
		markMeetingTranscriptScanned.mockResolvedValue({ count: 1 });
		releaseMeetingTranscriptAnalysisClaim.mockResolvedValue({ count: 1 });
		getCachedProjectBacklog.mockResolvedValue(EMPTY_BACKLOG);
		createPendingBacklogProposal.mockResolvedValue({ id: "pbp-1" });
		analyzeContextAndPropose.mockResolvedValue(ONE_CHANGE_PROPOSAL);
	});

	it("claims (NOT_SCANNED→IN_PROGRESS) then calls the analyzer once with capture-as-is args (AC2)", async () => {
		await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(claimMeetingTranscriptForAnalysis).toHaveBeenCalledTimes(1);
		expect(claimMeetingTranscriptForAnalysis).toHaveBeenCalledWith(
			"tr-rec-1",
		);

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		const arg = analyzeContextAndPropose.mock.calls[0][0] as {
			projectId: string;
			userId: string;
			organizationId?: string;
			fetchedContext: { meetingTranscripts: string[] };
			existingBacklog: unknown;
			userPrompt: string;
			allowEpics?: boolean;
			allowUpdates?: boolean;
		};
		expect(arg.projectId).toBe("proj-1");
		expect(arg.userId).toBe("user-1");
		expect(arg.organizationId).toBe("org-1");
		expect(arg.fetchedContext.meetingTranscripts).toEqual([
			BASE_INPUT.transcriptText,
		]);
		expect(arg.existingBacklog).toBe(EMPTY_BACKLOG);
		expect(arg.userPrompt).toBe(MEETING_CAPTURE_USER_PROMPT);
		expect(arg.allowEpics).toBe(false);
		expect(arg.allowUpdates).toBe(false);
	});

	it("creates a MONITORED_MEETING proposal (with transcript metadata) and marks SCANNED with the proposal id on ≥1 change (AC3)", async () => {
		const result = await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(result.success).toBe(true);
		expect(result.pendingProposalId).toBe("pbp-1");
		expect(result.changeCount).toBe(1);

		expect(createPendingBacklogProposal).toHaveBeenCalledTimes(1);
		const call = createPendingBacklogProposal.mock.calls[0][0] as {
			source: string;
			summary: string;
			changeCount: number;
			sourceMetadata: Record<string, unknown>;
			userId?: string;
			organizationId?: string;
		};
		expect(call.source).toBe("MONITORED_MEETING");
		expect(call.summary).toBe("Add CSV export");
		expect(call.changeCount).toBe(1);
		expect(call.userId).toBe("user-1");
		expect(call.organizationId).toBe("org-1");
		expect(call.sourceMetadata).toMatchObject({
			meetingId: "meeting-1",
			transcriptId: "transcript-1",
			linkedMeetingId: "lm-1",
			meetingSubject: "Sprint planning",
			contextId: "ctx-1",
			// transcript is carried so the approve-time drafting LLM has context.
			transcript: BASE_INPUT.transcriptText,
			attachments: [],
			attachmentWarnings: [],
		});

		// Marked SCANNED WITH the proposal id.
		expect(markMeetingTranscriptScanned).toHaveBeenCalledTimes(1);
		expect(markMeetingTranscriptScanned).toHaveBeenCalledWith(
			"tr-rec-1",
			"pbp-1",
		);
		expect(releaseMeetingTranscriptAnalysisClaim).not.toHaveBeenCalled();
	});

	it("creates NO proposal on a zero-change run but marks SCANNED so it is never re-analyzed (AC4)", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "nothing actionable",
			changes: [],
		});

		const result = await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(result.success).toBe(true);
		expect(result.changeCount).toBe(0);
		expect(result.skippedReason).toBe("no_relevant_content");

		expect(createPendingBacklogProposal).not.toHaveBeenCalled();
		// SCANNED with NO proposal id (zero-change).
		expect(markMeetingTranscriptScanned).toHaveBeenCalledTimes(1);
		expect(markMeetingTranscriptScanned).toHaveBeenCalledWith("tr-rec-1");
		expect(releaseMeetingTranscriptAnalysisClaim).not.toHaveBeenCalled();
	});

	it("does NOT claim or call the analyzer when auto-analyze is OFF (AC1)", async () => {
		projectFindUnique.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: false,
		});

		const result = await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(result.skippedReason).toBe("auto_analyze_disabled");
		expect(claimMeetingTranscriptForAnalysis).not.toHaveBeenCalled();
		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(createPendingBacklogProposal).not.toHaveBeenCalled();
	});

	it("does NOT claim or call the analyzer when sync is OFF (AC1)", async () => {
		projectFindUnique.mockResolvedValue({
			meetingTranscriptSyncEnabled: false,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});

		const result = await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(result.skippedReason).toBe("auto_analyze_disabled");
		expect(claimMeetingTranscriptForAnalysis).not.toHaveBeenCalled();
		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
	});

	it("#1814 FR7: userInitiated skips the project-flag gate entirely (both flags OFF) and still analyzes", async () => {
		projectFindUnique.mockResolvedValue({
			meetingTranscriptSyncEnabled: false,
			meetingTranscriptAutoAnalyzeEnabled: false,
		});

		const result = await autoAnalyzeMeetingTranscriptActivity({
			...BASE_INPUT,
			userInitiated: true,
		});

		// The flag gate never even reads the project row.
		expect(projectFindUnique).not.toHaveBeenCalled();
		expect(claimMeetingTranscriptForAnalysis).toHaveBeenCalledTimes(1);
		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(result.pendingProposalId).toBe("pbp-1");
	});

	it("early-returns without analyzing when the claim is lost and already SCANNED (AC5)", async () => {
		claimMeetingTranscriptForAnalysis.mockResolvedValue({
			claimed: false,
			status: "SCANNED",
			analyzedAt: new Date(),
		});

		const result = await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(result.skippedReason).toBe("already_analyzed");
		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(createPendingBacklogProposal).not.toHaveBeenCalled();
		// Already SCANNED ⇒ no reconcile write.
		expect(markMeetingTranscriptScanned).not.toHaveBeenCalled();
	});

	it("reconciles a stuck IN_PROGRESS row (proposal created, SCANNED stamp failed) up to SCANNED on retry (AC5b)", async () => {
		// The bug fix: analyzedAt is NULL because the stamp that would set it is
		// exactly the write that failed — so reconcile must fire on IN_PROGRESS
		// regardless of analyzedAt, or the transcript sticks on "Analyzing…".
		claimMeetingTranscriptForAnalysis.mockResolvedValue({
			claimed: false,
			status: "IN_PROGRESS",
			analyzedAt: null,
		});

		const result = await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(result.skippedReason).toBe("already_analyzed");
		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(markMeetingTranscriptScanned).toHaveBeenCalledTimes(1);
		expect(markMeetingTranscriptScanned).toHaveBeenCalledWith("tr-rec-1");
	});

	it("marks SCANNED without analyzing when the transcript text is empty", async () => {
		const result = await autoAnalyzeMeetingTranscriptActivity({
			...BASE_INPUT,
			transcriptText: "   ",
		});

		expect(result.skippedReason).toBe("no_transcript_text");
		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(markMeetingTranscriptScanned).toHaveBeenCalledTimes(1);
		expect(markMeetingTranscriptScanned).toHaveBeenCalledWith("tr-rec-1");
		expect(releaseMeetingTranscriptAnalysisClaim).not.toHaveBeenCalled();
	});

	it("releases the claim and propagates when the analyzer throws before a proposal exists (AC6)", async () => {
		analyzeContextAndPropose.mockRejectedValue(new Error("LLM 503"));

		await expect(
			autoAnalyzeMeetingTranscriptActivity(BASE_INPUT),
		).rejects.toThrow(/LLM 503/);

		expect(createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(markMeetingTranscriptScanned).not.toHaveBeenCalled();
		// Claim released so a retry can re-analyze the transient failure.
		expect(releaseMeetingTranscriptAnalysisClaim).toHaveBeenCalledTimes(1);
		expect(releaseMeetingTranscriptAnalysisClaim).toHaveBeenCalledWith(
			"tr-rec-1",
		);
	});

	it("KEEPS the claim (no release) when a failure happens AFTER the proposal is created — prevents duplicate proposals on retry (C1)", async () => {
		// The proposal create succeeds, but the SCANNED stamp throws.
		markMeetingTranscriptScanned.mockRejectedValue(
			new Error("stamp failed"),
		);

		await expect(
			autoAnalyzeMeetingTranscriptActivity(BASE_INPUT),
		).rejects.toThrow(/stamp failed/);

		// Proposal WAS created.
		expect(createPendingBacklogProposal).toHaveBeenCalledTimes(1);
		// No release — the claim stays held so a retry reconciles to SCANNED
		// instead of creating a second proposal.
		expect(releaseMeetingTranscriptAnalysisClaim).not.toHaveBeenCalled();
	});

	it("folds the proposal's decisionConflicts into the persisted proposal — omitted when the proposal carries none (finding #14)", async () => {
		// Run 1 — analyzer returns a proposal carrying a "conflicts" pre-check.
		analyzeContextAndPropose.mockResolvedValueOnce({
			...ONE_CHANGE_PROPOSAL,
			decisionConflicts: DECISION_PRECHECK_CONFLICTS,
		});
		await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		// Run 2 — default proposal (no decisionConflicts).
		await autoAnalyzeMeetingTranscriptActivity(BASE_INPUT);

		expect(createPendingBacklogProposal).toHaveBeenCalledTimes(2);
		// This fold is the only link that makes the contradiction warning durable
		// and the override loggable for the meeting monitor surface — the helper
		// takes `decisionPrecheck` top-level and merges it into
		// `sourceMetadata.decisionPrecheck`.
		expect(createPendingBacklogProposal.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				decisionPrecheck: DECISION_PRECHECK_CONFLICTS,
			}),
		);
		// No conflicts on the proposal ⇒ nothing folded in.
		expect(createPendingBacklogProposal.mock.calls[1][0]).toEqual(
			expect.objectContaining({ decisionPrecheck: undefined }),
		);
	});
});
