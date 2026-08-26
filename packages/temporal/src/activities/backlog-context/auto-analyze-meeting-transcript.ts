/**
 * Auto-Analyze Meeting Transcript — single LLM-analysis activity for the
 * monitored-meeting auto-scan feature.
 *
 * Mirrors `analyzeSlackThreadActivity` (`../slack-channel-monitor/analyze-slack-thread.ts`)
 * closely. The dedicated `autoAnalyzeMeetingTranscriptWorkflow` proxies this
 * single activity, which performs `claim → analyze → persist → mark scanned`:
 *
 *  1. Re-confirm BOTH project flags (`meetingTranscriptSyncEnabled &&
 *     meetingTranscriptAutoAnalyzeEnabled`); if either is OFF, early-return
 *     WITHOUT claiming (re-enabling later still works for future transcripts).
 *  2. Claim — compare-and-set the `ProjectMeetingTranscript` row from
 *     NOT_SCANNED → IN_PROGRESS. If the CAS loses (already SCANNED, or a crashed
 *     prior attempt), reconcile and skip. Combined with the deterministic,
 *     reject-duplicates workflowId from the ingest hook, a transcript is
 *     analyzed at most once.
 *  3. Build context — `getCachedProjectBacklog(projectId)` (60s TTL) and the
 *     formatted transcript text as `fetchedContext.meetingTranscripts`.
 *  4. Analyze — `analyzeContextAndPropose({ allowEpics:false, allowUpdates:false })`,
 *     the same "capture-as-is" posture the Slack/Teams monitors use.
 *  5. Persist (≥1 change) — `createPendingBacklogProposal({ source:
 *     "MONITORED_MEETING", … })`, then `markMeetingTranscriptScanned(
 *     transcriptRecordId, pending.id)` → SCANNED + `analyzedAt` + `analyzedProposalId`.
 *  6. Zero changes / empty transcript — create no proposal; mark SCANNED so the
 *     transcript is never re-analyzed and the scan-status view stays accurate.
 *
 * On a retryable failure the claim is released (→ NOT_SCANNED). A terminal
 * failure (retries exhausted) is marked FAILED by the workflow.
 *
 * Per-item fault isolation: any failure inside this activity is contained to
 * the dedicated workflow and does NOT touch the meeting-transcript sync
 * pipeline (the ingest hook starts this workflow fire-and-forget).
 *
 * `userId` / `organizationId` provenance: the user who enabled sync / the org
 * context threaded into `fetchAndStoreMeetingTranscript`. Stamping the proposal
 * with these keeps it inside the correct tenant (XOR), exactly like Slack/Teams.
 */

import {
	claimMeetingTranscriptForAnalysis,
	createPendingBacklogProposal,
	db,
	markMeetingTranscriptAnalysisFailed,
	markMeetingTranscriptScanned,
	releaseMeetingTranscriptAnalysisClaim,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import {
	analyzeContextAndPropose,
	type ChangeProposal,
} from "./analyze-context";
import { getCachedProjectBacklog } from "./project-backlog-cache";

// =============================================================================
// Types
// =============================================================================

export interface AutoAnalyzeMeetingTranscriptInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** `ProjectMeetingTranscript.id` — the per-transcript dedup anchor row. */
	transcriptRecordId: string;
	/** `ProjectContext.id` created for this transcript (deep-link metadata). */
	contextId: string;
	/** Microsoft Graph online-meeting id. */
	meetingId: string;
	/** Microsoft Graph transcript id. */
	transcriptId: string;
	/** `ProjectLinkedMeeting.id`. */
	linkedMeetingId: string;
	/** Human-readable meeting subject (drives the inbox badge label). */
	meetingSubject: string;
	/** Meeting/occurrence date as an ISO string (logging + metadata only). */
	meetingDate?: string;
	/** The fully-formatted transcript text (header + body) to analyze. */
	transcriptText: string;
	/**
	 * Set by the explicit "Create feature proposals" button (#1814 FR7) to skip
	 * the Step 1 `meetingTranscriptSyncEnabled`/`meetingTranscriptAutoAnalyzeEnabled`
	 * gate below. That gate exists to keep the *automatic* ingestion-triggered
	 * path off for projects that haven't opted in (AC1); it does not apply to a
	 * one-off, user-initiated request against a transcript that already exists.
	 * Omitted/false for the auto-analyze ingest hook — unchanged behavior there.
	 */
	userInitiated?: boolean;
}

export interface AutoAnalyzeMeetingTranscriptOutput {
	success: boolean;
	pendingProposalId?: string;
	changeCount: number;
	/** Set when the analyze was a deliberate no-op. */
	skippedReason?:
		| "already_analyzed"
		| "auto_analyze_disabled"
		| "no_transcript_text"
		| "no_relevant_content";
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Meeting-specific capture prompt. Modeled on Slack's
 * `THREAD_ANALYSIS_USER_PROMPT` — capture-as-is, features/bugs only, ignore
 * social chatter. This is prompt text, not net-new analysis logic (the analyzer
 * and its schema are unchanged), so it stays within design decision D2.
 */
export const MEETING_CAPTURE_USER_PROMPT = `The context below is a meeting transcript. Analyze it and propose backlog changes — features or bugs — that the discussion implies.

A single meeting may yield zero, one, or several proposals. Only create a proposal when the discussion clearly describes a concrete piece of product work (a feature to build or a bug to fix). Ignore social chatter, status updates, scheduling, and off-topic tangents.

Keep each proposal concise: a short title and brief reasoning citing the discussion. Description and acceptance criteria can be minimal — they will be refined later.`;

// =============================================================================
// Activity
// =============================================================================

export async function autoAnalyzeMeetingTranscriptActivity(
	input: AutoAnalyzeMeetingTranscriptInput,
): Promise<AutoAnalyzeMeetingTranscriptOutput> {
	const {
		projectId,
		userId,
		organizationId,
		transcriptRecordId,
		contextId,
		meetingId,
		transcriptId,
		linkedMeetingId,
		meetingSubject,
		meetingDate,
		transcriptText,
		userInitiated,
	} = input;

	logger.info("[MeetingAutoAnalyze] Analyzing transcript", {
		projectId,
		meetingId,
		transcriptId,
		transcriptRecordId,
		userInitiated: Boolean(userInitiated),
	});

	// Step 1: re-confirm BOTH project flags BEFORE claiming (the toggle could
	// have been turned off between the ingest hook firing and this activity
	// running). Reading flags first means a disabled project is never marked
	// analyzed, so re-enabling later still works for future transcripts.
	//
	// Skipped entirely when `userInitiated` (the "Create feature proposals"
	// button, #1814 FR7): that flag pair governs the *automatic* ingest-time
	// scan, not an explicit one-off request against a transcript that already
	// exists — AC1 below only covers the un-flagged (auto) call shape.
	if (!userInitiated) {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				meetingTranscriptSyncEnabled: true,
				meetingTranscriptAutoAnalyzeEnabled: true,
			},
		});

		if (
			!project ||
			!project.meetingTranscriptSyncEnabled ||
			!project.meetingTranscriptAutoAnalyzeEnabled
		) {
			logger.info(
				"[MeetingAutoAnalyze] Auto-analyze not enabled for project — skipping",
				{
					projectId,
					transcriptRecordId,
					meetingTranscriptSyncEnabled:
						project?.meetingTranscriptSyncEnabled ?? null,
					meetingTranscriptAutoAnalyzeEnabled:
						project?.meetingTranscriptAutoAnalyzeEnabled ?? null,
				},
			);
			return {
				success: true,
				changeCount: 0,
				skippedReason: "auto_analyze_disabled",
			};
		}
	}

	// Step 2: ATOMIC claim — compare-and-set NOT_SCANNED → IN_PROGRESS in a
	// single conditional UPDATE. This is the dedup lock (mirrors Slack's
	// INSERT-as-lock `claimSlackMessageForAnalysis`) and MUST happen BEFORE the
	// LLM call + proposal create. That ordering is what guarantees "analyzed at
	// most once": a duplicate run re-enters here, the CAS matches 0 rows, and we
	// skip — so a retry after the proposal-create commit can never create a
	// second proposal.
	heartbeat("claiming transcript");
	const claim = await claimMeetingTranscriptForAnalysis(transcriptRecordId);

	if (!claim.claimed) {
		// Lost the claim. A row stuck at IN_PROGRESS means a PRIOR attempt of this
		// single, reject-duplicate workflow already claimed it and then either
		// created a proposal but failed to stamp SCANNED, or crashed mid-analysis.
		// Retries are sequential (no concurrent attempt), and no fresh trigger can
		// re-run analysis (the ingest hook fires once per transcript), so reconcile
		// IN_PROGRESS up to SCANNED rather than leaving the scan-status view
		// spinning on "Analyzing…" forever — matching the prior feature's "analyzed
		// at most once" posture. Any proposal that was created is already in the
		// inbox; the analyzedProposalId back-link is best-effort. SCANNED/FAILED are
		// terminal and left untouched; a deleted row is a no-op (updateMany).
		if (claim.status === "IN_PROGRESS") {
			await markMeetingTranscriptScanned(transcriptRecordId);
		}
		logger.info(
			"[MeetingAutoAnalyze] Transcript already claimed/analyzed — skipping",
			{ projectId, transcriptRecordId, analysisStatus: claim.status },
		);
		return {
			success: true,
			changeCount: 0,
			skippedReason: "already_analyzed",
		};
	}

	// The claim is now held (status IN_PROGRESS). On a failure BEFORE a proposal
	// is created we RELEASE it (back to NOT_SCANNED) so a transient failure (e.g.
	// an LLM error) can be retried. Once a proposal exists we keep the claim so a
	// retry reconciles to SCANNED and can never create a duplicate. A terminal
	// failure (retries exhausted) is marked FAILED by the workflow.
	let createdProposalId: string | undefined;
	try {
		// Empty transcript body — nothing to analyze. Mark SCANNED (terminal, no
		// proposal) so it is never retried and the status view is accurate.
		if (!transcriptText || transcriptText.trim().length === 0) {
			await markMeetingTranscriptScanned(transcriptRecordId);
			logger.warn(
				"[MeetingAutoAnalyze] Empty transcript text — skipping",
				{
					projectId,
					transcriptRecordId,
				},
			);
			return {
				success: true,
				changeCount: 0,
				skippedReason: "no_transcript_text",
			};
		}

		// Step 3: build context — flat backlog (TTL-cached) + the transcript text.
		heartbeat("fetching project backlog");
		const existingBacklog = await getCachedProjectBacklog(projectId);

		// Step 4: invoke the LLM. Capture-as-is posture: features/bugs only, no
		// epic and no update/merge suggestions (mirrors the Slack/Teams monitors).
		heartbeat("calling analyzeContextAndPropose");
		const proposal: ChangeProposal = await analyzeContextAndPropose({
			projectId,
			userId,
			organizationId,
			fetchedContext: {
				meetingTranscripts: [transcriptText],
			},
			existingBacklog,
			userPrompt: MEETING_CAPTURE_USER_PROMPT,
			// Channel/meeting feature-proposal flow is feature/bug-only — forbid epics.
			allowEpics: false,
			// Capture-as-is: the ANALYZER only creates new work items and never
			// suggests updates/merges off a truncated backlog listing.
			allowUpdates: false,
			// Enrichment is decided afterwards by the semantic routing pass, which
			// applies the project's own opt-in.
			allowRouting: true,
		});

		// Step 5: zero changes — mark SCANNED (no proposal) so the transcript is
		// never re-analyzed and the scan-status view shows "Scanned".
		if (proposal.changes.length === 0) {
			await markMeetingTranscriptScanned(transcriptRecordId);
			logger.info(
				"[MeetingAutoAnalyze] Transcript had no relevant content",
				{ projectId, transcriptRecordId },
			);
			return {
				success: true,
				changeCount: 0,
				skippedReason: "no_relevant_content",
			};
		}

		// Step 6: persist the proposal. Transcripts carry no attachments — keep
		// the inbox/approve readers happy with empty `attachments`/
		// `attachmentWarnings` (no-op). `transcript` is included so the approve-
		// time drafting LLM has the full meeting context, mirroring Slack/Teams
		// (the meeting approve path reuses their `buildThreadTranscript`, which
		// reads `sourceMetadata.transcript`).
		const sourceMetadata = {
			meetingId,
			transcriptId,
			linkedMeetingId,
			meetingSubject,
			meetingDate: meetingDate ?? null,
			contextId,
			transcript: transcriptText,
			attachments: [],
			attachmentWarnings: [],
		};
		const proposalJson = JSON.parse(JSON.stringify(proposal));
		const sourceMetadataJson = JSON.parse(JSON.stringify(sourceMetadata));

		const pending = await createPendingBacklogProposal({
			projectId,
			source: "MONITORED_MEETING",
			proposal: proposalJson,
			summary: proposal.summary,
			changeCount: proposal.changes.length,
			sourceMetadata: sourceMetadataJson,
			// Fold any decision-precheck findings that rode along on the proposal
			// into `sourceMetadata.decisionPrecheck` so the review inbox reads them
			// back durably. Undefined (flag off / no conflicts) is a no-op merge.
			decisionPrecheck: proposalJson.decisionConflicts,
			userId,
			organizationId,
		});
		createdProposalId = pending.id;

		// Mark SCANNED + back-fill the deep-link to the created proposal. A
		// failure here keeps the claim held (the proposal exists), so a retry
		// reconciles to SCANNED rather than duplicating.
		await markMeetingTranscriptScanned(transcriptRecordId, pending.id);

		logger.info("[MeetingAutoAnalyze] Pending proposal created", {
			projectId,
			transcriptRecordId,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
		});

		return {
			success: true,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
		};
	} catch (error) {
		// Release the claim ONLY if no proposal was created yet, so a transient
		// failure can be retried (status back to NOT_SCANNED). If a proposal
		// already exists, keep the claim held so a retry reconciles to SCANNED
		// and never creates a duplicate.
		if (createdProposalId === undefined) {
			try {
				await releaseMeetingTranscriptAnalysisClaim(transcriptRecordId);
			} catch (releaseError) {
				logger.error(
					"[MeetingAutoAnalyze] Failed to release transcript claim after error",
					{
						projectId,
						transcriptRecordId,
						error:
							releaseError instanceof Error
								? releaseError.message
								: String(releaseError),
					},
				);
			}
		}
		throw error;
	}
}

// =============================================================================
// Terminal-failure marker activity
// =============================================================================

export interface MarkMeetingTranscriptAnalysisFailedInput {
	transcriptRecordId: string;
	projectId: string;
	/** Human-readable failure reason, surfaced in the scan-status view. */
	error: string;
}

/**
 * Mark a transcript's auto-analysis as terminally FAILED. Called by
 * `autoAnalyzeMeetingTranscriptWorkflow` once the analyze activity has exhausted
 * its retries, so the failure is observable in the scan-status view instead of
 * the transcript silently looking unscanned. Best-effort + tolerant of a
 * deleted row (updateMany under the hood).
 */
export async function markMeetingTranscriptAnalysisFailedActivity(
	input: MarkMeetingTranscriptAnalysisFailedInput,
): Promise<void> {
	const { transcriptRecordId, projectId, error } = input;
	logger.warn("[MeetingAutoAnalyze] Marking transcript analysis FAILED", {
		projectId,
		transcriptRecordId,
		error,
	});
	await markMeetingTranscriptAnalysisFailed(transcriptRecordId, error);
}
