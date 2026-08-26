/**
 * Slack Huddle Notes Ingestion activities.
 *
 * Detect huddle AI-notes canvases (`is_huddle_canvas: true`) posted into linked
 * Slack channels, download the summary/notes canvas body, parse the quip HTML to
 * markdown, and store it as a passive `ProjectContext` of type
 * `SLACK_HUDDLE_NOTES` that flows into AI Updates like a Teams transcript.
 *
 * Mirrors `meeting-transcript-sync.ts` for the store + summarize shape, but
 * diverges on dedup: huddles are keyed on the canvas file id and updated
 * IN-PLACE (a just-posted canvas is empty, then populates). On the update path
 * the prior Qdrant vectors MUST be cleared before re-embedding so an
 * empty→populated growth leaves no orphaned chunks.
 *
 * Passive context only: this NEVER calls the analyze / PendingBacklogProposal
 * path. Per-canvas faults are isolated; the loop never aborts.
 */

import {
	db,
	updateSlackHuddleIngestLastRun as dbUpdateSlackHuddleIngestLastRun,
	getLinkedSlackHuddleChannels,
	upsertSlackHuddleNoteRecord,
} from "@repo/database";
import {
	AuthFailedError,
	computeHuddleContentHash,
	DownloadFailedError,
	downloadSlackFile,
	ExternalWorkspaceError,
	executeSlackTool,
	extractMentionUserIds,
	getSlackCredentials,
	quipHtmlToMarkdown,
	replaceMentions,
	resolveUserNames,
	ScopeMissingError,
	SlackConfigurationError,
	type SlackHuddleCanvasFile,
} from "@repo/integrations/slack";
import { logger } from "@repo/logs";
import { removeContextEmbedding } from "@repo/rag";
import { heartbeat } from "@temporalio/activity";
import { getTemporalClient } from "../../client";
import {
	NOTES_SUMMARIZATION_THRESHOLD,
	summarizeNotes,
} from "./summarize-notes";
import { recordSlackChannelFailureForKeyActivity } from "./update-slack-channel-cursor";

// Slack canvas bodies are small (timestamped summary + action items). 5 MB is a
// generous ceiling well above any real notes canvas.
const MAX_CANVAS_BYTES = 5 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

export interface GetLinkedHuddleChannelsInput {
	projectId: string;
}

export interface LinkedHuddleChannel {
	id: string;
	channelId: string;
	slackTeamId: string;
	channelName: string;
}

export interface IngestHuddleNotesForChannelInput {
	projectId: string;
	linkedChannelId: string;
	channelId: string;
	slackTeamId: string;
	channelName: string;
	userId: string;
	organizationId?: string;
	/** Forward-only lower bound (ms since epoch) — null/undefined = no bound. */
	enabledAtMs?: number;
}

export interface IngestHuddleNotesForChannelOutput {
	channelId: string;
	canvasesDetected: number;
	ingested: number;
	updated: number;
	skipped: number;
	failed: number;
}

export interface UpdateSlackHuddleIngestLastRunInput {
	projectId: string;
}

// =============================================================================
// Activity: linked channels
// =============================================================================

/**
 * Linked Slack channels for the project (huddle ingestion rides the same linked
 * channels — no separate picker). On error: log + return [] so the loop marks
 * idle and continues (mirrors getLinkedMeetingJoinUrlsActivity).
 */
export async function getLinkedHuddleChannelsActivity(
	input: GetLinkedHuddleChannelsInput,
): Promise<LinkedHuddleChannel[]> {
	const { projectId } = input;
	try {
		const channels = await getLinkedSlackHuddleChannels(projectId);
		return channels.map((c) => ({
			id: c.id,
			channelId: c.channelId,
			slackTeamId: c.slackTeamId,
			channelName: c.channelName ?? c.channelId,
		}));
	} catch (error) {
		logger.error(
			"[SlackHuddleIngest] Failed to get linked huddle channels",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId,
			},
		);
		return [];
	}
}

// =============================================================================
// Activity: last-run timestamp
// =============================================================================

export async function updateSlackHuddleIngestLastRunActivity(
	input: UpdateSlackHuddleIngestLastRunInput,
): Promise<void> {
	try {
		await dbUpdateSlackHuddleIngestLastRun(input.projectId);
	} catch (error) {
		logger.error("[SlackHuddleIngest] Failed to update last run", {
			error: error instanceof Error ? error.message : String(error),
			projectId: input.projectId,
		});
		throw error;
	}
}

// =============================================================================
// Core activity: detect + download + parse + store
// =============================================================================

export async function ingestHuddleNotesForChannelActivity(
	input: IngestHuddleNotesForChannelInput,
): Promise<IngestHuddleNotesForChannelOutput> {
	const {
		projectId,
		linkedChannelId,
		channelId,
		slackTeamId,
		channelName,
		userId,
		organizationId,
		enabledAtMs,
	} = input;

	const result: IngestHuddleNotesForChannelOutput = {
		channelId,
		canvasesDetected: 0,
		ingested: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
	};

	heartbeat("resolving slack credentials");
	const { accessToken } = await getSlackCredentials(userId, organizationId);

	// Forward-only lower bound. files.list `ts_from` is in seconds.
	const tsFrom =
		typeof enabledAtMs === "number" && enabledAtMs > 0
			? Math.floor(enabledAtMs / 1000)
			: undefined;

	heartbeat("listing candidate canvases");
	// This call sits outside the per-canvas try/catch below, so before this it
	// escaped the activity uncaught: Temporal retried it, the workflow counted a
	// failure, and the next poll fifteen minutes later did the same. For a
	// permanent state like the bot not being in the channel that repeats
	// forever, invisibly — the failure counter this activity feeds has no
	// reader, so the only trace was a worker log nobody watches.
	let canvases: Awaited<ReturnType<typeof listCandidateHuddleCanvases>>;
	try {
		canvases = await listCandidateHuddleCanvases({
			accessToken,
			channelId,
			userId,
			organizationId,
			tsFrom,
		});
	} catch (error) {
		if (error instanceof SlackConfigurationError) {
			// Only a person can clear this. Record it against the channel so the
			// settings page shows why ingestion stopped, and return without
			// throwing so the activity does not retry a state it cannot change.
			logger.warn(
				"[SlackHuddleIngest] Channel is not readable; ingestion skipped",
				{
					projectId,
					channelId,
					slackError: error.slackError,
				},
			);
			await recordSlackChannelFailureForKeyActivity({
				projectId,
				channelId,
				errorMessage: error.message,
			});
			return result;
		}
		throw error;
	}

	result.canvasesDetected = canvases.length;

	for (const canvas of canvases) {
		heartbeat(`processing canvas ${canvas.id}`);
		try {
			const outcome = await processCanvas({
				canvas,
				accessToken,
				projectId,
				linkedChannelId,
				channelId,
				slackTeamId,
				channelName,
				userId,
				organizationId,
			});
			result[outcome] += 1;
		} catch (error) {
			if (error instanceof ScopeMissingError) {
				// Decision #7: structured reconnect error (NO token / url), skip.
				logger.error(
					"[SlackHuddleIngest] Missing Slack scope — reconnect required",
					{
						projectId,
						channelId,
						canvasId: canvas.id,
						reason: "missing_scope",
					},
				);
				result.skipped += 1;
				continue;
			}
			if (
				error instanceof AuthFailedError ||
				error instanceof ExternalWorkspaceError ||
				error instanceof DownloadFailedError
			) {
				logger.warn("[SlackHuddleIngest] Canvas download failed", {
					projectId,
					channelId,
					canvasId: canvas.id,
					errorClass: error.constructor.name,
				});
				result.failed += 1;
				continue;
			}
			logger.error("[SlackHuddleIngest] Canvas processing failed", {
				projectId,
				channelId,
				canvasId: canvas.id,
				error: error instanceof Error ? error.message : String(error),
			});
			result.failed += 1;
		}
	}

	return result;
}

// =============================================================================
// Internal helpers
// =============================================================================

type CanvasOutcome = "ingested" | "updated" | "skipped";

interface ListCandidateParams {
	accessToken: string;
	channelId: string;
	userId: string;
	organizationId?: string;
	tsFrom?: number;
}

/**
 * List huddle canvases in a channel, falling back to `get_file_info` per
 * candidate when `files.list` returns a leaner object (no huddle markers /
 * no url_private). Spec §7 linchpin — validated live in Task 8.1.
 */
async function listCandidateHuddleCanvases(
	params: ListCandidateParams,
): Promise<SlackHuddleCanvasFile[]> {
	const { channelId, userId, organizationId, tsFrom } = params;

	const listed = (await executeSlackTool(
		"list_huddle_canvases",
		{ channelId, tsFrom },
		userId,
		organizationId,
	)) as { files: SlackHuddleCanvasFile[] };

	const candidates: SlackHuddleCanvasFile[] = [];
	for (const file of listed.files) {
		// Fast path: files.list already carried the huddle markers + url.
		if (file.isHuddleCanvas && file.urlPrivate) {
			candidates.push(file);
			continue;
		}
		// Fallback path: confirm via files.info (reads huddle markers +
		// url_private). Narrow to canvas-shaped candidates to avoid N calls.
		const looksLikeCanvas =
			file.filetype === "quip" ||
			file.mimetype === "application/vnd.slack-docs" ||
			file.isHuddleCanvas;
		if (!looksLikeCanvas) {
			continue;
		}
		try {
			const info = (await executeSlackTool(
				"get_file_info",
				{ fileId: file.id, channelId },
				userId,
				organizationId,
			)) as SlackHuddleCanvasFile;
			if (info.isHuddleCanvas && info.urlPrivate) {
				candidates.push(info);
			}
		} catch (error) {
			logger.warn("[SlackHuddleIngest] files.info fallback failed", {
				channelId,
				fileId: file.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return candidates;
}

interface ProcessCanvasParams {
	canvas: SlackHuddleCanvasFile;
	accessToken: string;
	projectId: string;
	linkedChannelId: string;
	channelId: string;
	slackTeamId: string;
	channelName: string;
	userId: string;
	organizationId?: string;
}

async function processCanvas(
	params: ProcessCanvasParams,
): Promise<CanvasOutcome> {
	const {
		canvas,
		accessToken,
		projectId,
		linkedChannelId,
		channelId,
		slackTeamId,
		channelName,
		userId,
		organizationId,
	} = params;

	if (!canvas.urlPrivate) {
		// Nothing to download — treat as a transient skip (retry next cycle).
		return "skipped";
	}

	heartbeat(`downloading canvas ${canvas.id}`);
	const download = await downloadSlackFile(canvas.urlPrivate, accessToken, {
		maxBytes: MAX_CANVAS_BYTES,
	});

	const rawHtml = download.buffer.toString("utf8");

	// Parse quip HTML → markdown.
	let body = quipHtmlToMarkdown(rawHtml);

	// Empty-body guard: just-posted (or AI-notes-disabled) canvas. Skip storing,
	// leave for the next cycle. Do NOT create a context for empty content.
	if (body.trim().length === 0) {
		return "skipped";
	}

	// Resolve @U… mentions to display names via the cached users.info resolver.
	const mentionIds = extractMentionUserIds(body);
	if (mentionIds.length > 0) {
		const nameById = await resolveUserNames(mentionIds, accessToken);
		body = replaceMentions(body, nameById);
	}

	const speakerNames = mentionIds.length > 0 ? deriveSpeakers(body) : [];

	// Compute the dedup hash over the PARSED body (pre-summary, so it's stable)
	// and make the dedup decision BEFORE any LLM summarization. A canvas always
	// falls within `ts_from`, so it is re-listed every poll — summarizing before
	// the no-op check would burn an LLM call every cycle on an unchanged note.
	const contentHash = computeHuddleContentHash(body);

	const prior = await db.projectSlackHuddleNote.findUnique({
		where: {
			projectId_canvasId: { projectId, canvasId: canvas.id },
		},
		select: { id: true, contentHash: true, contextId: true },
	});

	const title = canvas.title || channelName;

	if (prior && prior.contentHash === contentHash) {
		// No-op re-poll (unchanged). Refresh tracking-row timestamps only — no
		// summarization, no context write, no embedding.
		await upsertSlackHuddleNoteRecord({
			projectId,
			linkedChannelId,
			canvasId: canvas.id,
			channelId,
			slackTeamId,
			contentHash,
			title,
			contextId: prior.contextId ?? undefined,
			contentLength: body.length,
			speakerNames,
			userId,
			organizationId,
		});
		return "skipped";
	}

	// Create or changed: build the full content (header + summarize if long).
	const huddleDate = canvas.huddleDateStart
		? new Date(canvas.huddleDateStart * 1000)
		: canvas.created
			? new Date(canvas.created * 1000)
			: undefined;
	const formattedDate = huddleDate
		? huddleDate.toLocaleString()
		: "Unknown date";

	const header = [
		`## Slack Huddle Notes: ${title}`,
		`**Date:** ${formattedDate}`,
		`**Channel:** #${channelName}`,
		speakerNames.length > 0
			? `**Participants:** ${speakerNames.join(", ")}`
			: "",
		"---",
		"",
	]
		.filter(Boolean)
		.join("\n");

	let finalContent = `${header}${body}`;
	let wasSummarized = false;

	if (finalContent.length > NOTES_SUMMARIZATION_THRESHOLD) {
		heartbeat("summarizing long notes");
		const summarized = await summarizeNotes({
			notes: body,
			title,
			userId,
			organizationId,
			projectId,
		});
		finalContent = `${header}${summarized}`;
		wasSummarized = true;
	}

	const huddleMetadata = {
		provider: "slack",
		canvasId: canvas.id,
		channelId,
		slackTeamId,
		channelName,
		huddleDateStart: canvas.huddleDateStart
			? new Date(canvas.huddleDateStart * 1000).toISOString()
			: undefined,
		huddleDateEnd: canvas.huddleDateEnd
			? new Date(canvas.huddleDateEnd * 1000).toISOString()
			: undefined,
		huddleTranscriptFileId: canvas.huddleTranscriptFileId,
		huddleSummaryId: canvas.huddleSummaryId,
		speakerNames,
		wasSummarized,
	};

	const sourceTitle = `Slack Huddle Notes: ${title} (${formattedDate})`;

	if (!prior) {
		// CREATE path: fresh context + tracking row + embedding insert.
		heartbeat("storing new context");
		const context = await db.projectContext.create({
			data: {
				projectId,
				type: "SLACK_HUDDLE_NOTES",
				content: finalContent,
				sourceTitle,
				userId,
				organizationId,
				metadata: huddleMetadata,
				extractionStatus: "COMPLETED",
				extractedAt: new Date(),
			},
		});

		await upsertSlackHuddleNoteRecord({
			projectId,
			linkedChannelId,
			canvasId: canvas.id,
			channelId,
			slackTeamId,
			contentHash,
			huddleTranscriptFileId: canvas.huddleTranscriptFileId,
			huddleSummaryId: canvas.huddleSummaryId,
			huddleDateStart: canvas.huddleDateStart
				? new Date(canvas.huddleDateStart * 1000)
				: undefined,
			huddleDateEnd: canvas.huddleDateEnd
				? new Date(canvas.huddleDateEnd * 1000)
				: undefined,
			title,
			contextId: context.id,
			contentLength: finalContent.length,
			wasSummarized,
			speakerNames,
			userId,
			organizationId,
		});

		await startEmbedding({
			contextId: context.id,
			projectId,
			userId,
			organizationId,
			content: finalContent,
			sourceTitle,
			canvasId: canvas.id,
		});

		return "ingested";
	}

	// UPDATE-IN-PLACE path (empty→populated or human edit). `prior` exists here
	// with a DIFFERENT hash (the same-hash no-op returned earlier). Update the
	// existing
	// context, refresh the tracking row, and CLEAR prior Qdrant vectors before
	// re-embedding so the grown chunk set leaves NO orphaned chunks.
	heartbeat("updating context in place");
	const contextId = prior.contextId;
	if (contextId) {
		await db.projectContext.update({
			where: { id: contextId },
			data: {
				content: finalContent,
				sourceTitle,
				metadata: huddleMetadata,
				extractionStatus: "COMPLETED",
				extractedAt: new Date(),
			},
		});
	}

	await upsertSlackHuddleNoteRecord({
		projectId,
		linkedChannelId,
		canvasId: canvas.id,
		channelId,
		slackTeamId,
		contentHash,
		huddleTranscriptFileId: canvas.huddleTranscriptFileId,
		huddleSummaryId: canvas.huddleSummaryId,
		huddleDateStart: canvas.huddleDateStart
			? new Date(canvas.huddleDateStart * 1000)
			: undefined,
		huddleDateEnd: canvas.huddleDateEnd
			? new Date(canvas.huddleDateEnd * 1000)
			: undefined,
		title,
		contextId: contextId ?? undefined,
		contentLength: finalContent.length,
		wasSummarized,
		speakerNames,
		userId,
		organizationId,
	});

	if (contextId) {
		// Clear-before-write: delete stale vectors, then re-embed fresh.
		heartbeat("clearing stale vectors");
		await removeContextEmbedding(contextId, organizationId);
		await startEmbedding({
			contextId,
			projectId,
			userId,
			organizationId,
			content: finalContent,
			sourceTitle,
			canvasId: canvas.id,
		});
	}

	return "updated";
}

interface StartEmbeddingParams {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	content: string;
	sourceTitle: string;
	canvasId: string;
}

/**
 * Kick off the standard context-embedding workflow on the project-documents
 * queue. Non-fatal: the context is already stored if this fails.
 */
async function startEmbedding(params: StartEmbeddingParams): Promise<void> {
	try {
		const client = await getTemporalClient();
		await client.workflow.start("contextEmbeddingWorkflow", {
			taskQueue: "project-documents",
			workflowId: `huddle-context-embedding-${params.contextId}-${Date.now()}`,
			args: [
				{
					contextId: params.contextId,
					projectId: params.projectId,
					userId: params.userId,
					organizationId: params.organizationId,
					content: params.content,
					type: "SLACK_HUDDLE_NOTES",
					metadata: {
						sourceTitle: params.sourceTitle,
						provider: "slack",
						canvasId: params.canvasId,
					},
				},
			],
		});
	} catch (error) {
		logger.error("[SlackHuddleIngest] Failed to start embedding workflow", {
			error: error instanceof Error ? error.message : String(error),
			contextId: params.contextId,
		});
		// Non-fatal — context is stored, embedding will be retried on next change.
	}
}

/**
 * Best-effort participant extraction: collect resolved `@name` tokens from the
 * parsed body (mentions were already resolved to display names).
 */
function deriveSpeakers(body: string): string[] {
	const names = new Set<string>();
	for (const match of body.matchAll(/@([A-Za-z0-9._-]+)/g)) {
		if (match[1]) {
			names.add(match[1]);
		}
	}
	return [...names];
}
