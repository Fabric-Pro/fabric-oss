/**
 * Meeting Transcript Sync Activities
 *
 * Activities for periodically syncing meeting transcripts from Microsoft Teams
 * into a project's RAG context. Follows the same scheduled resync pattern as other connector-backed project sync flows.
 *
 * The workflow links Teams meetings to projects, then periodically fetches
 * new transcripts from those meetings and stores them as ProjectContext
 * entries for RAG retrieval.
 */

import { generateText, getAIModelWithMetadata } from "@repo/ai";
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	clearMeetingSyncFailures,
	createMeetingTranscriptRecord,
	db,
	updateMeetingTranscriptSyncLastRun as dbUpdateMeetingTranscriptSyncLastRun,
	getLinkedMeetingJoinUrls,
	hasTranscriptNearOccurrence,
	isTranscriptAlreadySynced,
	recordMeetingSyncFailure,
} from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	extractChannelThreadId,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { getTemporalClient } from "../client";

// =============================================================================
// Types
// =============================================================================

export interface GetLinkedMeetingJoinUrlsInput {
	projectId: string;
}

export interface LinkedMeetingJoinUrl {
	id: string;
	joinUrl: string;
	subject: string | null;
}

export interface ListRecentMeetingInstancesInput {
	userId: string;
	organizationId?: string;
	linkedJoinUrls: string[];
	daysBack?: number;
	/**
	 * Needed only to record or clear this project's sync failure state — the
	 * fetch itself is keyed on the user's token, not the project (#2355).
	 */
	projectId?: string;
}

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 180;

/** Pure: clamp the calendar lookback and derive the startDate the Teams tool reads. */
export function resolveLookbackWindow(
	daysBack: number | undefined,
	now: Date,
): { daysBack: number; startDate: string } {
	const clamped = Math.min(
		MAX_LOOKBACK_DAYS,
		Math.max(1, Math.floor(daysBack ?? DEFAULT_LOOKBACK_DAYS)),
	);
	return {
		daysBack: clamped,
		startDate: new Date(
			now.getTime() - clamped * 24 * 60 * 60 * 1000,
		).toISOString(),
	};
}

export interface MeetingInstance {
	id: string;
	subject: string;
	startTime: string;
	joinUrl: string;
	organizer: string;
}

export interface CheckTranscriptAlreadySyncedInput {
	projectId: string;
	meetingId: string;
	transcriptId: string;
}

export interface FetchAndStoreMeetingTranscriptInput {
	projectId: string;
	linkedMeetingId: string;
	userId: string;
	organizationId?: string;
	joinUrl: string;
	meetingSubject: string;
	meetingDate: string;
}

export interface FetchAndStoreMeetingTranscriptOutput {
	success: boolean;
	contextId?: string;
	transcriptRecordId?: string;
	wasSummarized: boolean;
	error?: string;
	transcriptsFetched: number;
}

export interface UpdateMeetingTranscriptSyncLastRunInput {
	projectId: string;
}

/**
 * One transcript waiting to be ingested, from either source.
 *
 * `recording` is set only for transcripts found on a meeting recording; its
 * presence is what routes the content fetch, and its absence means Graph served
 * the listing and will serve the content too.
 */
interface PendingTranscript {
	transcriptId: string;
	createdDateTime?: string;
	recording?: {
		driveId: string;
		recordingItemId: string;
		recordingWebUrl: string;
	};
}

export interface DescribeMissingTranscriptsInput {
	graphError?: string;
	/** Why Graph refused to resolve the meeting at all, when it did. */
	lookupError?: string;
	isChannelMeeting: boolean;
	fallbackDiagnostic?: string;
}

/**
 * Say why a meeting yielded no transcript.
 *
 * Graph reports "there are none" and "you may not see these" identically — an
 * HTTP 200 carrying an empty collection — and for a channel meeting it is always
 * the latter. Collapsing both into a bare "No transcripts available for this
 * meeting" is what let a tenant-wide outage read as ordinary quiet for days.
 *
 * The leading sentence is load-bearing beyond its wording: the sync workflow
 * classifies a meeting as skipped-rather-than-failed by matching on it, and a
 * meeting that simply was not recorded is a skip. So the phrasing stays and the
 * real cause is appended to it.
 *
 * Exported for testing.
 */
export function describeMissingTranscripts(
	input: DescribeMissingTranscriptsInput,
): string {
	const { graphError, lookupError, isChannelMeeting, fallbackDiagnostic } =
		input;

	if (graphError) {
		return graphError;
	}
	if (!isChannelMeeting) {
		return "No transcripts available for this meeting.";
	}

	return [
		"No transcripts available for this meeting.",
		lookupError
			? `Microsoft Graph would not look this channel meeting up (${lookupError}), so the meeting recording was checked instead.`
			: "Microsoft Graph does not serve transcripts for channel meetings, so the meeting recording was checked instead.",
		fallbackDiagnostic,
	]
		.filter(Boolean)
		.join(" ");
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum transcript length before LLM summarization kicks in */
const TRANSCRIPT_SUMMARIZATION_THRESHOLD = 50_000;

/**
 * How far a stored transcript may sit from a calendar occurrence and still count as covering it.
 *
 * Generous on purpose. The stored `meetingDate` is the transcript's or recording's own timestamp,
 * which trails the occurrence being compared against, and these values are currently written ~3h
 * behind real UTC. Six hours absorbs both and stays well inside the 24h between two occurrences of
 * a daily meeting, so it can never match a neighbouring one.
 */
const OCCURRENCE_COVERAGE_TOLERANCE_MS = 6 * 60 * 60 * 1000;

// =============================================================================
// Activities
// =============================================================================

/**
 * Get the join URLs for all meetings linked to a project.
 *
 * Queries the ProjectLinkedMeeting table for the given project and returns
 * the id, joinUrl, and subject for each linked meeting.
 */
export async function getLinkedMeetingJoinUrlsActivity(
	input: GetLinkedMeetingJoinUrlsInput,
): Promise<LinkedMeetingJoinUrl[]> {
	const { projectId } = input;

	logger.info("[MeetingTranscriptSync] Getting linked meeting join URLs", {
		projectId,
	});

	try {
		const linkedMeetings = await getLinkedMeetingJoinUrls(projectId);

		logger.info("[MeetingTranscriptSync] Found linked meetings", {
			projectId,
			count: linkedMeetings.length,
		});

		return linkedMeetings;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(
			"[MeetingTranscriptSync] Failed to get linked meeting join URLs",
			{
				error: errorMessage,
				projectId,
			},
		);
		return [];
	}
}

/**
 * List recent meeting instances from the user's calendar and filter to only
 * those whose joinUrl matches one of the linked meeting URLs.
 *
 * Calls the Microsoft Teams integration to fetch calendar meetings from the
 * lookback window (default 30 days, clamped to 180), then filters to meetings
 * whose joinUrl is in the provided set. The tool only reads startDate/endDate,
 * so the window must be passed as an explicit startDate.
 */
export async function listRecentMeetingInstancesForLinkedUrls(
	input: ListRecentMeetingInstancesInput,
): Promise<MeetingInstance[]> {
	const { userId, organizationId, linkedJoinUrls, projectId } = input;
	const window = resolveLookbackWindow(input.daysBack, new Date());

	logger.info(
		"[MeetingTranscriptSync] Listing recent meeting instances for linked URLs",
		{
			userId,
			linkedUrlCount: linkedJoinUrls.length,
			daysBack: window.daysBack,
		},
	);

	try {
		const result = (await executeMicrosoftTeamsTool(
			"list_calendar_meetings",
			{ daysBack: window.daysBack, startDate: window.startDate },
			userId,
			organizationId,
		)) as {
			meetings?: Array<{
				id: string;
				subject?: string;
				start?: string;
				organizer?: string;
				joinUrl?: string | null;
			}>;
			count?: number;
			error?: string;
		};

		if (result.error) {
			if (isMicrosoftNotConnectedError(result.error)) {
				logger.warn(
					"[MeetingTranscriptSync] Microsoft is not connected for the syncing account",
					{ userId, error: result.error },
				);
				return [];
			}
			throw new Error(
				`Could not read the calendar to match linked meetings: ${result.error}`,
			);
		}

		// The calendar answered, so whatever was wrong with this project's
		// Microsoft connection is over. Clearing here rather than on a
		// transcript arriving means a project that recovers while genuinely
		// quiet does not keep its banner forever (#2311's bug, on meetings).
		if (projectId) {
			await clearMeetingSyncFailures(projectId);
		}

		// Build a set for efficient lookup (normalize URLs to lowercase for comparison)
		const joinUrlSet = new Set(
			linkedJoinUrls.map((url) => url.toLowerCase()),
		);

		const filtered: MeetingInstance[] = (result.meetings || [])
			.filter((m) => {
				if (!m.joinUrl) {
					return false;
				}
				return joinUrlSet.has(m.joinUrl.toLowerCase());
			})
			.map((m) => ({
				id: m.id,
				subject: m.subject || "Untitled Meeting",
				startTime: m.start || new Date().toISOString(),
				joinUrl: m.joinUrl as string,
				organizer: m.organizer || "Unknown",
			}));

		logger.info(
			"[MeetingTranscriptSync] Filtered meeting instances for linked URLs",
			{
				totalMeetings: result.meetings?.length ?? 0,
				matchedMeetings: filtered.length,
			},
		);

		return filtered;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);

		// A disconnected Microsoft account is a settled state, not a fault:
		// there is genuinely nothing to match against until someone reconnects,
		// and failing the sync every hour over it helps no one.
		if (isMicrosoftNotConnectedError(errorMessage)) {
			logger.warn(
				"[MeetingTranscriptSync] Microsoft is not connected for the syncing account",
				{ userId, error: errorMessage },
			);
			// Still not a workflow failure — hourly failures over a settled
			// state help no one. But it must stop looking HEALTHY: before
			// this, the throw was swallowed, `[]` came back, and the run
			// stamped a clean lastRun, so a project whose syncing account had
			// left showed no sign of it anywhere (#2355).
			if (projectId) {
				await recordMeetingSyncFailure({
					projectId,
					errorMessage:
						"Microsoft is not connected for the account this sync runs on. Reconnect it to resume.",
				});
			}
			return [];
		}

		logger.error(
			"[MeetingTranscriptSync] Failed to list recent meeting instances",
			{
				error: errorMessage,
				userId,
			},
		);

		// Deliberately fatal. Returning [] here is indistinguishable from "the
		// calendar has no matching meetings", so a Graph outage used to read as
		// a clean, empty sync — and still stamped the project as freshly synced
		// on the way out. Let it fail: the activity retries, and a run that
		// cannot see the calendar must not be mistaken for a run that saw an
		// empty one.
		throw error instanceof Error ? error : new Error(errorMessage);
	}
}

/**
 * Check if a specific transcript has already been synced for a project.
 *
 * Uses the composite unique index (projectId, meetingId, transcriptId)
 * to deduplicate transcript fetches.
 */
export async function checkTranscriptAlreadySynced(
	input: CheckTranscriptAlreadySyncedInput,
): Promise<boolean> {
	const { projectId, meetingId, transcriptId } = input;

	try {
		return await isTranscriptAlreadySynced(
			projectId,
			meetingId,
			transcriptId,
		);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(
			"[MeetingTranscriptSync] Failed to check transcript sync status",
			{
				error: errorMessage,
				projectId,
				meetingId,
				transcriptId,
			},
		);
		// Default to false so we attempt the fetch
		return false;
	}
}

/**
 * Fetch and store a meeting transcript from Microsoft Teams.
 *
 * This is the core activity that:
 * 1. Resolves the online meeting ID from the join URL
 * 2. Lists available transcripts for the meeting
 * 3. Checks each transcript for deduplication
 * 4. Fetches transcript content
 * 5. Formats and optionally summarizes the content
 * 6. Creates a ProjectContext record with type MEETING_TRANSCRIPT
 * 7. Creates a ProjectMeetingTranscript tracking record
 * 8. Starts contextEmbeddingWorkflow to embed into Qdrant
 */
export async function fetchAndStoreMeetingTranscript(
	input: FetchAndStoreMeetingTranscriptInput,
): Promise<FetchAndStoreMeetingTranscriptOutput> {
	const {
		projectId,
		linkedMeetingId,
		userId,
		organizationId,
		joinUrl,
		meetingSubject,
		meetingDate,
	} = input;

	logger.info("[MeetingTranscriptSync] Fetching and storing transcript", {
		projectId,
		linkedMeetingId,
		joinUrl: `${joinUrl.substring(0, 80)}...`,
		meetingSubject,
	});

	// A channel meeting has a second route to its transcript — the recording in
	// the channel's SharePoint library — and that route is resolved from the
	// join URL alone. Knowing this up front is what lets a refusal from Graph
	// below be non-fatal.
	const channelThreadId = extractChannelThreadId(joinUrl);
	const isChannelMeeting = channelThreadId !== null;

	try {
		// Steps 1 and 2: resolve the online meeting from its join URL, then ask
		// Graph for its transcripts.
		//
		// Delegated resolution is organizer-scoped: an attendee of a channel
		// meeting gets `403 "3003: User does not have access to lookup meeting"`.
		// That used to end the sync right here, which left the channel-meeting
		// recording fallback — the one path that needs no meeting id at all —
		// sitting behind the very call an attendee can never make. So for a
		// channel meeting, every way Graph can decline (a 403, a thrown
		// transport error, or the empty 200 it returns to the organizer) leads
		// to the same place: try the recording.
		let meetingId: string | null = null;
		let graphError: string | undefined;
		let pendingTranscripts: PendingTranscript[] = [];

		try {
			heartbeat("resolving meeting from join URL");
			const meetingResult = (await executeMicrosoftTeamsTool(
				"get_meeting_by_join_url",
				{ joinWebUrl: joinUrl },
				userId,
				organizationId,
			)) as {
				meeting?: {
					id: string;
					subject?: string;
				} | null;
				error?: string;
			};

			meetingId = meetingResult.meeting?.id ?? null;
			graphError = meetingResult.error;

			if (meetingId) {
				heartbeat("listing transcripts");
				const transcriptListResult = (await executeMicrosoftTeamsTool(
					"list_meeting_transcripts",
					{ meetingId },
					userId,
					organizationId,
				)) as {
					transcripts?: Array<{
						id: string;
						createdDateTime?: string;
					}>;
					count?: number;
					error?: string;
				};

				graphError = transcriptListResult.error;
				pendingTranscripts = (
					transcriptListResult.transcripts ?? []
				).map((transcript) => ({
					transcriptId: transcript.id,
					createdDateTime: transcript.createdDateTime,
				}));
			}
		} catch (error) {
			// An ordinary meeting has nowhere else to look, so its failure is
			// still the caller's to report.
			if (!isChannelMeeting) {
				throw error;
			}
			graphError = error instanceof Error ? error.message : String(error);
		}

		const lookupError = meetingId ? undefined : graphError;

		if (!meetingId && !isChannelMeeting) {
			const errorMsg =
				graphError || "Could not resolve meeting from join URL.";
			logger.warn(
				"[MeetingTranscriptSync] Meeting not found for join URL",
				{
					error: errorMsg,
				},
			);
			return {
				success: false,
				wasSummarized: false,
				error: errorMsg,
				transcriptsFetched: 0,
			};
		}

		if (!meetingId) {
			logger.info(
				"[MeetingTranscriptSync] Graph would not look this channel meeting up; going straight to its recording",
				{ meetingSubject, error: lookupError },
			);
		}

		// The key a transcript is filed under. Graph's online-meeting id when we
		// have one; otherwise the channel's thread id, which is stable across
		// every occurrence of that channel meeting and so preserves exactly the
		// grouping the Graph id provided.
		const meetingKey = meetingId ?? `channel:${channelThreadId}`;

		let fallbackDiagnostic: string | undefined;

		if (pendingTranscripts.length === 0 && isChannelMeeting) {
			// Only look for a recording if this occurrence is not already
			// covered. Graph withholds channel transcripts *retroactively*, so
			// without this the fallback re-fetches every occurrence in the
			// lookback window on its first run — including the ones Graph
			// delivered normally months ago — and stores each a second time
			// under a recording-keyed id. That doubles the RAG context for
			// those meetings and fires auto-analyze twice per occurrence.
			const occurrence = new Date(meetingDate);
			const alreadyCovered =
				Number.isFinite(occurrence.getTime()) &&
				(await hasTranscriptNearOccurrence({
					projectId,
					linkedMeetingId,
					occurrence,
					toleranceMs: OCCURRENCE_COVERAGE_TOLERANCE_MS,
				}));

			if (alreadyCovered) {
				logger.info(
					"[MeetingTranscriptSync] Occurrence already has a transcript, not looking for a recording",
					{ meetingKey, meetingSubject, meetingDate },
				);
				return {
					success: false,
					wasSummarized: false,
					transcriptsFetched: 0,
				};
			}

			heartbeat("looking for a channel meeting recording");
			const recordingResult = (await executeMicrosoftTeamsTool(
				"list_recording_transcripts",
				{ joinUrl, meetingSubject, meetingDate },
				userId,
				organizationId,
			)) as {
				transcripts?: Array<{
					id: string;
					createdDateTime: string;
					driveId: string;
					recordingItemId: string;
					recordingWebUrl: string;
				}>;
				diagnostic?: string;
			};

			pendingTranscripts = (recordingResult.transcripts ?? []).map(
				(transcript) => ({
					transcriptId: transcript.id,
					createdDateTime: transcript.createdDateTime,
					recording: {
						driveId: transcript.driveId,
						recordingItemId: transcript.recordingItemId,
						recordingWebUrl: transcript.recordingWebUrl,
					},
				}),
			);
			fallbackDiagnostic = recordingResult.diagnostic;

			if (pendingTranscripts.length > 0) {
				logger.info(
					"[MeetingTranscriptSync] Channel meeting transcript recovered from its recording",
					{ meetingKey, meetingSubject },
				);
			}
		}

		if (pendingTranscripts.length === 0) {
			const errorMsg = describeMissingTranscripts({
				graphError: meetingId ? graphError : undefined,
				lookupError,
				isChannelMeeting,
				fallbackDiagnostic,
			});
			logger.info("[MeetingTranscriptSync] No transcripts found", {
				meetingKey,
				isChannelMeeting,
				error: errorMsg,
			});
			return {
				success: false,
				wasSummarized: false,
				error: errorMsg,
				transcriptsFetched: 0,
			};
		}

		let transcriptsFetched = 0;
		let lastContextId: string | undefined;
		let lastTranscriptRecordId: string | undefined;
		let lastWasSummarized = false;

		// Step 3: Process each transcript
		for (const transcript of pendingTranscripts) {
			const transcriptId = transcript.transcriptId;

			// Use the transcript's createdDateTime as the occurrence date
			// instead of the series-level meetingDate. For recurring meetings,
			// each transcript has its own createdDateTime matching the actual
			// occurrence, while the passed-in meetingDate is the same for all.
			const occurrenceDate = transcript.createdDateTime || meetingDate;

			// Check if already synced (deduplication)
			const alreadySynced = await isTranscriptAlreadySynced(
				projectId,
				meetingKey,
				transcriptId,
			);
			if (alreadySynced) {
				logger.info(
					"[MeetingTranscriptSync] Transcript already synced, skipping",
					{
						meetingKey,
						transcriptId,
					},
				);
				continue;
			}

			// Step 4: Fetch transcript content — from the recording when that is
			// where this transcript was found, otherwise from Graph. Only Graph
			// can hand us a transcript without a recording, so `meetingId` is
			// always resolved on that branch.
			heartbeat(`fetching transcript ${transcriptId}`);
			const transcriptContent = (await executeMicrosoftTeamsTool(
				transcript.recording
					? "get_recording_transcript_content"
					: "get_meeting_transcript_content",
				transcript.recording ?? { meetingId, transcriptId },
				userId,
				organizationId,
			)) as {
				format?: string;
				content?: string;
				entries?: Array<{
					speaker: string;
					text: string;
					start?: string;
					end?: string;
				}>;
				error?: string;
			};

			if (transcriptContent.error) {
				logger.warn(
					"[MeetingTranscriptSync] Transcript content error",
					{
						error: transcriptContent.error,
						meetingKey,
						transcriptId,
					},
				);
				continue;
			}

			// Format transcript into readable text
			let rawTranscript = "";
			const speakerNames = new Set<string>();

			if (
				transcriptContent.entries &&
				transcriptContent.entries.length > 0
			) {
				// Structured or VTT-parsed format
				rawTranscript = transcriptContent.entries
					.map((entry) => {
						if (entry.speaker) {
							speakerNames.add(entry.speaker);
						}
						return `${entry.speaker}: ${entry.text}`;
					})
					.join("\n");
			} else if (transcriptContent.content) {
				// Raw VTT format
				rawTranscript = transcriptContent.content;
			}

			if (!rawTranscript || rawTranscript.trim().length === 0) {
				logger.warn(
					"[MeetingTranscriptSync] Transcript content was empty",
					{
						meetingKey,
						transcriptId,
					},
				);
				continue;
			}

			// Step 5: Format transcript with header
			const formattedDate = occurrenceDate
				? new Date(occurrenceDate).toLocaleString()
				: "Unknown date";
			const speakerList = Array.from(speakerNames);
			const header = [
				`## Meeting Transcript: ${meetingSubject}`,
				`**Date:** ${formattedDate}`,
				speakerList.length > 0
					? `**Participants:** ${speakerList.join(", ")}`
					: "",
				"---",
				"",
			]
				.filter(Boolean)
				.join("\n");

			// The verbatim transcript, always. A summary is generated alongside it
			// for long meetings (below) but never replaces it: the body is the
			// only record of what was actually said, and re-ingesting it later is
			// possible only while the source recording still exists.
			const finalContent = `${header}${rawTranscript}`;
			// Means "the verbatim original was destroyed", which is now only true
			// of rows written before this behaviour changed. It is the flag the
			// Transcript tab reads to warn that it is showing a summary, so it
			// stays false here rather than tracking whether a summary was made —
			// `summary != null` answers that.
			const wasSummarized = false;
			// Stored as the row's initial summary — the FULL LLM summary, header-
			// and prefix-free (a 2000-char substring of header+body used to live
			// here and surfaced as a truncated blob in the Meeting Digest). Stays
			// unset for meetings short enough not to need one. The on-demand
			// insights extraction later replaces it with a digest-focused summary.
			let summaryText: string | undefined;

			// Step 6: Summarize alongside the transcript once it gets long enough
			// to be worth reading in digest form. The Meeting Digest, the Daily
			// Brief and the sync settings pane all read this column.
			heartbeat("processing transcript content");
			if (finalContent.length > TRANSCRIPT_SUMMARIZATION_THRESHOLD) {
				logger.info(
					"[MeetingTranscriptSync] Transcript exceeds threshold, summarizing alongside it",
					{
						originalLength: finalContent.length,
						threshold: TRANSCRIPT_SUMMARIZATION_THRESHOLD,
					},
				);

				summaryText =
					(await summarizeTranscript(
						rawTranscript,
						meetingSubject,
						userId,
						organizationId,
						projectId,
					)) ?? undefined;
			}

			// Step 7: Create ProjectContext record
			heartbeat("storing context record");
			const newContext = await db.projectContext.create({
				data: {
					projectId,
					type: "MEETING_TRANSCRIPT",
					content: finalContent,
					sourceTitle: `Meeting Transcript: ${meetingSubject} (${formattedDate})`,
					userId,
					organizationId,
					metadata: {
						provider: "microsoft-teams",
						meetingId: meetingKey,
						transcriptId,
						meetingSubject,
						meetingDate: occurrenceDate,
						joinUrl,
						speakerNames: speakerList,
						wasSummarized,
						transcriptSource: transcript.recording
							? "recording"
							: "graph",
					},
					extractionStatus: "COMPLETED",
					extractedAt: new Date(),
				},
			});

			// Step 8: Create ProjectMeetingTranscript tracking record
			const transcriptRecord = await createMeetingTranscriptRecord({
				projectId,
				linkedMeetingId,
				meetingId: meetingKey,
				transcriptId,
				meetingSubject,
				meetingDate: occurrenceDate
					? new Date(occurrenceDate)
					: undefined,
				contextId: newContext.id,
				summary: summaryText,
				keywords: [],
				speakerNames: speakerList,
				contentLength: finalContent.length,
				wasSummarized,
				userId,
				organizationId,
			});

			// Step 9: Start contextEmbeddingWorkflow to embed into Qdrant
			heartbeat("starting embedding workflow");
			try {
				const client = await getTemporalClient();
				await client.workflow.start("contextEmbeddingWorkflow", {
					taskQueue: "project-documents",
					workflowId: `context-embedding-${newContext.id}-${Date.now()}`,
					args: [
						{
							// Deliberately no `content`: a transcript is stored
							// whole now, and an inline body would put the
							// workflow input at the mercy of the meeting's
							// length. The activity reads it back by contextId.
							contextId: newContext.id,
							projectId,
							userId,
							organizationId,
							type: "MEETING_TRANSCRIPT",
							metadata: {
								sourceTitle: `Meeting Transcript: ${meetingSubject}`,
								provider: "microsoft-teams",
								meetingId: meetingKey,
								transcriptId,
							},
						},
					],
				});
			} catch (embeddingError) {
				logger.error(
					"[MeetingTranscriptSync] Failed to start embedding workflow",
					{
						error:
							embeddingError instanceof Error
								? embeddingError.message
								: String(embeddingError),
						contextId: newContext.id,
					},
				);
				// Non-fatal: the context is stored, just not embedded yet
			}

			// Step 10: auto-analyze this fresh transcript for feature proposals
			// when BOTH the sync flag and the opt-in auto-analyze flag are ON.
			// Fire-and-forget a dedicated workflow (mirrors the embedding start
			// above) so the ~300s LLM analysis + retries are decoupled from this
			// ingest activity's 10-min timeout and `meetingTranscriptSyncWorkflow`
			// stays untouched. A failed start is NON-FATAL — it must not fail
			// transcript ingest/embedding or abort the loop / per-meeting fetch.
			try {
				const project = await db.project.findUnique({
					where: { id: projectId },
					select: {
						meetingTranscriptSyncEnabled: true,
						meetingTranscriptAutoAnalyzeEnabled: true,
					},
				});

				if (
					project?.meetingTranscriptSyncEnabled &&
					project?.meetingTranscriptAutoAnalyzeEnabled
				) {
					const client = await getTemporalClient();
					await client.workflow.start(
						"autoAnalyzeMeetingTranscriptWorkflow",
						{
							taskQueue: "ai-chat",
							// Deterministic, transcript-keyed id (no timestamp
							// suffix) paired with reject-duplicates so two starts
							// for the same transcript cannot both run.
							workflowId: `auto-analyze-meeting-transcript:${transcriptRecord.id}`,
							workflowIdReusePolicy: "REJECT_DUPLICATE",
							workflowIdConflictPolicy: "FAIL",
							args: [
								{
									projectId,
									userId,
									organizationId,
									transcriptRecordId: transcriptRecord.id,
									contextId: newContext.id,
									meetingId: meetingKey,
									transcriptId,
									linkedMeetingId,
									meetingSubject,
									meetingDate: occurrenceDate,
									transcriptText: finalContent,
								},
							],
						},
					);
				}
			} catch (autoAnalyzeError) {
				logger.error(
					"[MeetingTranscriptSync] Failed to start auto-analyze workflow",
					{
						error:
							autoAnalyzeError instanceof Error
								? autoAnalyzeError.message
								: String(autoAnalyzeError),
						transcriptRecordId: transcriptRecord.id,
					},
				);
				// Non-fatal: the transcript is stored + embedding kicked off;
				// auto-analysis simply did not start for this transcript.
			}

			// Step 11 (#1814): fire-and-forget insights extraction so summaries/
			// decisions/actions/questions are ready before anyone opens the
			// digest. Same workflowId scheme as the sheet-open trigger
			// (extract-insights procedure) — ALLOW_DUPLICATE + FAIL collapses
			// the race between ingest and a concurrent open. Gated only by the
			// sync flag: insights are core digest content, not proposal-gated.
			// Non-fatal like the starts above.
			try {
				const client = await getTemporalClient();
				await client.workflow.start(
					"extractMeetingInsightsOnDemandWorkflow",
					{
						taskQueue: "project-documents",
						workflowId: `meeting-digest-insights:${transcriptRecord.id}`,
						workflowIdReusePolicy: "ALLOW_DUPLICATE",
						workflowIdConflictPolicy: "FAIL",
						args: [
							{
								projectId,
								organizationId,
								userId,
								transcriptCuid: transcriptRecord.id,
							},
						],
					},
				);
			} catch (insightsError) {
				logger.error(
					"[MeetingTranscriptSync] Failed to start insights extraction workflow",
					{
						error:
							insightsError instanceof Error
								? insightsError.message
								: String(insightsError),
						transcriptRecordId: transcriptRecord.id,
					},
				);
				// Non-fatal: the sheet-open path self-populates as before.
			}

			transcriptsFetched++;
			lastContextId = newContext.id;
			lastTranscriptRecordId = transcriptRecord.id;
			lastWasSummarized = wasSummarized;

			logger.info(
				"[MeetingTranscriptSync] Transcript stored successfully",
				{
					meetingKey,
					transcriptId,
					contextId: newContext.id,
					transcriptRecordId: transcriptRecord.id,
					wasSummarized,
					contentLength: finalContent.length,
				},
			);
		}

		return {
			success: transcriptsFetched > 0,
			contextId: lastContextId,
			transcriptRecordId: lastTranscriptRecordId,
			wasSummarized: lastWasSummarized,
			transcriptsFetched,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(
			"[MeetingTranscriptSync] Failed to fetch and store transcript",
			{
				error: errorMessage,
				projectId,
				joinUrl: joinUrl.substring(0, 80),
			},
		);

		return {
			success: false,
			wasSummarized: false,
			error: `Failed to fetch meeting transcript: ${errorMessage}`,
			transcriptsFetched: 0,
		};
	}
}

/**
 * Update the meetingTranscriptSyncLastRun timestamp on the project.
 *
 * The field describes the *scheduled* sync, so a project whose scheduled sync is
 * off must not have it moved. One-shot runs are allowed on such a project by
 * design (`trigger-sync-now` has no enabled-guard, and deduplication makes a
 * double-run harmless), and every one of those clicks used to stamp a project
 * that has no workflow at all — leaving its settings page reporting a recent
 * sync indefinitely.
 *
 * The stamp means "a pass completed without error", not "transcripts arrived".
 * A pass where every meeting was already synced is a healthy pass, and gating on
 * new transcripts would let the timestamp rot on exactly the projects that are
 * working.
 */
export async function updateMeetingTranscriptSyncLastRunActivity(
	input: UpdateMeetingTranscriptSyncLastRunInput,
): Promise<void> {
	const { projectId } = input;

	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { meetingTranscriptSyncEnabled: true },
		});

		if (!project?.meetingTranscriptSyncEnabled) {
			logger.info(
				"[MeetingTranscriptSync] Scheduled sync is off for this project; leaving the last-run timestamp alone",
				{ projectId },
			);
			return;
		}

		await dbUpdateMeetingTranscriptSyncLastRun(projectId);
		logger.info("[MeetingTranscriptSync] Updated last run timestamp", {
			projectId,
		});
	} catch (error) {
		logger.error(
			"[MeetingTranscriptSync] Failed to update last run timestamp",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId,
			},
		);
		throw error;
	}
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Summarize a long transcript using an LLM.
 *
 * Used when meeting transcripts exceed 50K characters to keep
 * the project context size manageable.
 */
async function summarizeTranscript(
	transcript: string,
	meetingSubject: string,
	userId: string,
	organizationId?: string,
	projectId?: string,
): Promise<string | null> {
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{
				taskType: "SIMPLE",
				complexity: "simple",
			},
			{
				userId,
				organizationId,
				projectId,
				jobType: "meeting-transcript-sync",
			},
		);

		const summarySystem = `You are a meeting summarizer. Create a concise, structured summary of the meeting transcript.
Focus on:
- Key decisions made
- Action items and who is responsible
- Important discussion topics and conclusions
- Any deadlines or commitments mentioned

Keep the summary under 3000 words. Use bullet points and clear headings.`;
		const summaryPrompt = `Meeting: ${meetingSubject}

Transcript:
${transcript}

Provide a structured summary of this meeting.`;

		// Bounded ~3,000-word summary — but that still exceeds the 4,096 Anthropic
		// unrecognized-model fallback and can clip under Databricks' 8,192 default.
		// Scaled mode with inputChars 0 requests the floor (16,384), clamped to the
		// provider cap and context window. `undefined` leaves other providers on
		// their SDK defaults.
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: 0,
			promptChars: summarySystem.length + summaryPrompt.length,
		});
		const response = await generateText({
			model,
			system: summarySystem,
			prompt: summaryPrompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		// Track usage (fire-and-forget)
		trackUsage();

		const summary = response.text || "";

		if (summary.trim().length === 0) {
			logger.warn(
				"[MeetingTranscriptSync] LLM returned empty summary, storing none",
			);
			// No fallback body is needed any more: the transcript itself is what
			// gets stored, so a failed summary costs the digest a convenience,
			// not the record.
			return null;
		}

		logger.info("[MeetingTranscriptSync] Transcript summarized", {
			originalLength: transcript.length,
			summaryLength: summary.length,
		});

		return summary;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[MeetingTranscriptSync] Failed to summarize transcript", {
			error: errorMessage,
		});

		return null;
	}
}
