/**
 * Backlog Context Fetcher Activities
 *
 * Phase 1 Temporal activities for the Contextual Backlog Updater.
 * Handles fetching context from various sources:
 * - Microsoft Teams messages (via project integrations)
 * - Meeting transcripts (via Microsoft Graph API)
 * - Calendar meetings (via Microsoft Graph API)
 * - Notion page content (via MCP)
 * - Project RAG context (via Qdrant vector search)
 *
 * All activities follow tenant isolation patterns, passing organizationId
 * through every call chain for proper XOR filtering.
 */

import {
	generateText,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	db,
	getLatestProjectScan,
	listArchitectureDecisions,
	listScanFindings,
} from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import { formatContextsForPrompt, retrieveProjectContexts } from "@repo/rag";
import { getBaseUrl } from "@repo/utils";
import { CacheKeys, CacheTTL, RedisCache } from "../../lib/redis-cache";
import { fetchRecentSlackMessages } from "../search-project-slack-messages";
import { fetchRecentTeamsMessages } from "../search-project-teams-messages";

// =============================================================================
// Types
// =============================================================================

export interface FetchTeamsMessagesForBacklogInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	limit?: number;
	/** Optional filter: restrict Teams fetch to these ProjectContext IDs. */
	contextIds?: string[];
	/** Optional time window in days (applies to message createdAt). */
	daysBack?: number;
}

export interface FetchTeamsMessagesForBacklogOutput {
	success: boolean;
	formattedMessages: string;
	messageCount: number;
	errors: string[];
}

export interface FetchSlackMessagesForBacklogInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	limit?: number;
}

export interface FetchSlackMessagesForBacklogOutput {
	success: boolean;
	formattedMessages: string;
	messageCount: number;
	errors: string[];
}

export interface FetchMeetingTranscriptInput {
	joinUrl: string;
	startTime?: string; // ISO date of the selected meeting instance
	userId: string;
	organizationId?: string;
	projectId?: string;
}

export interface FetchMeetingTranscriptOutput {
	success: boolean;
	transcript: string;
	meetingSubject?: string;
	wasSummarized: boolean;
	error?: string;
}

export interface ListCalendarMeetingsInput {
	userId: string;
	organizationId?: string;
}

export interface CalendarMeeting {
	id: string;
	subject: string;
	startTime?: string;
	organizer: string;
	joinUrl: string | null;
}

export interface ListCalendarMeetingsOutput {
	success: boolean;
	meetings: CalendarMeeting[];
	error?: string;
}

export interface FetchNotionPageContentInput {
	pageId: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
}

export interface FetchNotionPageContentOutput {
	success: boolean;
	content: string;
	title?: string;
	error?: string;
}

export interface RetrieveProjectRagContextInput {
	projectId: string;
	query: string;
	userId: string;
	organizationId?: string;
	topK?: number;
}

export interface RetrieveProjectRagContextOutput {
	success: boolean;
	formattedContext: string;
	chunkCount: number;
	error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum transcript length before LLM summarization kicks in */
const TRANSCRIPT_SUMMARIZATION_THRESHOLD = 50_000;

// =============================================================================
// Activities
// =============================================================================

/**
 * Fetch recent Teams messages for a project's backlog context.
 *
 * Reuses the existing fetchRecentTeamsMessages function which handles
 * both group chats and team channels linked to a project via
 * ProjectContext INTEGRATION entries.
 *
 * @param input - Project and user context
 * @returns Formatted messages string ready for LLM consumption
 */
export async function fetchTeamsMessagesForBacklog(
	input: FetchTeamsMessagesForBacklogInput,
): Promise<FetchTeamsMessagesForBacklogOutput> {
	const {
		projectId,
		userId,
		organizationId,
		limit = 20,
		contextIds,
		daysBack,
	} = input;

	logger.info("[BacklogContext] Fetching Teams messages for backlog", {
		projectId,
		userId,
		limit,
	});

	try {
		const result = await fetchRecentTeamsMessages({
			projectId,
			userId,
			organizationId,
			limit,
			contextIds,
			daysBack,
		});

		const formattedMessages =
			result.formattedContexts.length > 0
				? result.formattedContexts.join("\n\n")
				: "";

		logger.info("[BacklogContext] Teams messages fetched", {
			messageCount: result.messageCount,
			fetchedChats: result.fetchedChats,
			errorCount: result.errors.length,
		});

		return {
			success: result.messageCount > 0,
			formattedMessages,
			messageCount: result.messageCount,
			errors: result.errors,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[BacklogContext] Failed to fetch Teams messages", {
			error: errorMessage,
			projectId,
		});

		return {
			success: false,
			formattedMessages: "",
			messageCount: 0,
			errors: [`Failed to fetch Teams messages: ${errorMessage}`],
		};
	}
}

/**
 * Fetch recent Slack messages for a project's backlog context.
 *
 * Reuses the existing fetchRecentSlackMessages function which handles
 * channels linked to a project via ProjectContext INTEGRATION entries.
 *
 * @param input - Project and user context
 * @returns Formatted messages string ready for LLM consumption
 */
export async function fetchSlackMessagesForBacklog(
	input: FetchSlackMessagesForBacklogInput,
): Promise<FetchSlackMessagesForBacklogOutput> {
	const { projectId, userId, organizationId, limit = 20 } = input;

	logger.info("[BacklogContext] Fetching Slack messages for backlog", {
		projectId,
		userId,
		limit,
	});

	try {
		const result = await fetchRecentSlackMessages({
			projectId,
			userId,
			organizationId,
			limit,
		});

		const formattedMessages =
			result.formattedContexts.length > 0
				? result.formattedContexts.join("\n\n")
				: "";

		logger.info("[BacklogContext] Slack messages fetched", {
			messageCount: result.messageCount,
			fetchedChannels: result.fetchedChannels,
			errorCount: result.errors.length,
		});

		return {
			success: result.messageCount > 0,
			formattedMessages,
			messageCount: result.messageCount,
			errors: result.errors,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[BacklogContext] Failed to fetch Slack messages", {
			error: errorMessage,
			projectId,
		});

		return {
			success: false,
			formattedMessages: "",
			messageCount: 0,
			errors: [`Failed to fetch Slack messages: ${errorMessage}`],
		};
	}
}

/**
 * Fetch a meeting transcript from Microsoft Teams.
 *
 * 3-step process:
 * 1. Resolve the online meeting ID from the join URL
 * 2. List available transcripts for the meeting
 * 3. Fetch the transcript content
 *
 * If the transcript exceeds 50K characters, it is summarized using an LLM
 * to keep the backlog context manageable.
 *
 * @param input - Meeting join URL and user context
 * @returns Transcript content (raw or summarized)
 */
export async function fetchMeetingTranscript(
	input: FetchMeetingTranscriptInput,
): Promise<FetchMeetingTranscriptOutput> {
	const { joinUrl, startTime, userId, organizationId, projectId } = input;

	logger.info("[BacklogContext] Fetching meeting transcript", {
		joinUrl: `${joinUrl.substring(0, 80)}...`,
		userId,
	});

	try {
		// Cache lookup: if the auto-sync flow already pulled this transcript
		// into ProjectContext, reuse it and skip the Graph round-trip.
		if (projectId) {
			const cached = await readCachedTranscript({
				projectId,
				joinUrl,
				startTime,
			});
			if (cached) {
				logger.info("[BacklogContext] Meeting transcript cache hit", {
					projectId,
					meetingSubject: cached.meetingSubject,
					wasSummarized: cached.wasSummarized,
					contentLength: cached.transcript.length,
				});
				return cached;
			}

			// #2170: a meeting the user imported into this project. Checked
			// second, so the team sync pipeline stays the authority for any
			// meeting it owns; an import only answers for meetings it does not.
			const imported = await readImportedTranscript({
				projectId,
				joinUrl,
				startTime,
				userId,
				organizationId,
			});
			if (imported) {
				return imported;
			}
		}

		// Redis L2 cache: a previously-fetched transcript for this exact
		// instance (per-user key). Transcripts are immutable, so this turns
		// repeat/overlapping AI Update runs over the same window into instant
		// reads instead of the 3-call Graph round-trip + re-summarization. Keyed
		// on the selected startTime, so recurring-meeting instances never
		// collide and a hit is always the right meeting.
		const transcriptCacheKey = CacheKeys.meetingTranscript(
			userId,
			joinUrl,
			startTime,
		);
		const redisCached =
			await RedisCache.get<FetchMeetingTranscriptOutput>(
				transcriptCacheKey,
			);
		if (redisCached?.success && redisCached.transcript) {
			logger.info("[BacklogContext] Meeting transcript Redis cache hit", {
				meetingSubject: redisCached.meetingSubject,
				wasSummarized: redisCached.wasSummarized,
				contentLength: redisCached.transcript.length,
			});
			return redisCached;
		}

		// Step 1: Resolve online meeting ID from join URL
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

		if (!meetingResult.meeting?.id) {
			const errorMsg =
				meetingResult.error ||
				"Could not resolve meeting from join URL. The meeting may have expired or the URL may be incorrect.";
			logger.warn("[BacklogContext] Meeting not found for join URL", {
				error: errorMsg,
			});
			return {
				success: false,
				transcript: "",
				wasSummarized: false,
				error: errorMsg,
			};
		}

		const meetingId = meetingResult.meeting.id;
		const meetingSubject = meetingResult.meeting.subject;

		logger.info("[BacklogContext] Meeting resolved", {
			meetingId,
			meetingSubject,
		});

		// Step 2: List transcripts for this meeting
		const transcriptListResult = (await executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId },
			userId,
			organizationId,
		)) as {
			transcripts?: Array<{ id: string; createdDateTime?: string }>;
			count?: number;
			error?: string;
		};

		if (
			!transcriptListResult.transcripts ||
			transcriptListResult.transcripts.length === 0
		) {
			const errorMsg =
				transcriptListResult.error ||
				"No transcripts available for this meeting. Transcription may not have been enabled.";
			logger.info("[BacklogContext] No transcripts found", {
				meetingId,
				error: errorMsg,
			});
			return {
				success: false,
				transcript: "",
				meetingSubject,
				wasSummarized: false,
				error: errorMsg,
			};
		}

		// Select transcript matching the requested date, or fall back to most recent
		let transcriptId: string;
		if (startTime && transcriptListResult.transcripts.length > 1) {
			const targetDate = new Date(startTime).getTime();
			// Find transcript with closest createdDateTime to the selected meeting date
			const sorted = [...transcriptListResult.transcripts].sort(
				(a, b) => {
					const aDiff = Math.abs(
						new Date(a.createdDateTime ?? "").getTime() -
							targetDate,
					);
					const bDiff = Math.abs(
						new Date(b.createdDateTime ?? "").getTime() -
							targetDate,
					);
					return aDiff - bDiff;
				},
			);
			transcriptId = sorted[0].id;
			logger.info("[BacklogContext] Selected transcript by date", {
				meetingId,
				targetDate: startTime,
				transcriptDate: sorted[0].createdDateTime,
				totalTranscripts: transcriptListResult.transcripts.length,
			});
		} else {
			// Fall back to most recent transcript
			transcriptId = transcriptListResult.transcripts[0].id;
		}

		// Step 3: Fetch transcript content
		const transcriptContent = (await executeMicrosoftTeamsTool(
			"get_meeting_transcript_content",
			{ meetingId, transcriptId },
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
			logger.warn("[BacklogContext] Transcript content error", {
				error: transcriptContent.error,
			});
			return {
				success: false,
				transcript: "",
				meetingSubject,
				wasSummarized: false,
				error: transcriptContent.error,
			};
		}

		// Format transcript into readable text
		let rawTranscript = "";

		if (transcriptContent.entries && transcriptContent.entries.length > 0) {
			// Structured or VTT-parsed format
			rawTranscript = transcriptContent.entries
				.map((entry) => `${entry.speaker}: ${entry.text}`)
				.join("\n");
		} else if (transcriptContent.content) {
			// Raw VTT format
			rawTranscript = transcriptContent.content;
		}

		if (!rawTranscript || rawTranscript.trim().length === 0) {
			return {
				success: false,
				transcript: "",
				meetingSubject,
				wasSummarized: false,
				error: "Transcript content was empty",
			};
		}

		logger.info("[BacklogContext] Transcript fetched", {
			meetingId,
			contentLength: rawTranscript.length,
		});

		// Summarize if transcript is too long, then write-through to the cache.
		let output: FetchMeetingTranscriptOutput;
		if (rawTranscript.length > TRANSCRIPT_SUMMARIZATION_THRESHOLD) {
			logger.info(
				"[BacklogContext] Transcript exceeds threshold, summarizing",
				{
					originalLength: rawTranscript.length,
					threshold: TRANSCRIPT_SUMMARIZATION_THRESHOLD,
				},
			);

			const summarized = await summarizeTranscript(
				rawTranscript,
				meetingSubject || "Meeting",
				userId,
				organizationId,
				projectId,
			);

			output = {
				success: true,
				transcript: summarized,
				meetingSubject,
				wasSummarized: true,
			};
		} else {
			output = {
				success: true,
				transcript: rawTranscript,
				meetingSubject,
				wasSummarized: false,
			};
		}

		// Write-through: cache the finalized transcript (per-user, per-instance)
		// so subsequent AI Update runs over an overlapping window reuse it
		// instead of paying the Graph round-trips (and re-summarization) again.
		await RedisCache.set(
			transcriptCacheKey,
			output,
			CacheTTL.meetingTranscript,
		);

		return output;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);

		// Not-connected is an expected, actionable user state (no Microsoft
		// account linked yet) — logging it at error level pollutes prod
		// error-monitoring with noise for something that isn't a fault
		// (#2525, #2255).
		if (isMicrosoftNotConnectedError(errorMessage)) {
			logger.warn("[BacklogContext] Failed to fetch meeting transcript", {
				error: errorMessage,
				joinUrl: joinUrl.substring(0, 80),
			});
		} else {
			logger.error(
				"[BacklogContext] Failed to fetch meeting transcript",
				{
					error: errorMessage,
					joinUrl: joinUrl.substring(0, 80),
				},
			);
		}

		// Provide actionable error messages for common issues
		if (
			errorMessage.includes("Microsoft not connected") ||
			errorMessage.includes("Please connect your Microsoft account")
		) {
			return {
				success: false,
				transcript: "",
				wasSummarized: false,
				error: "Microsoft account not connected. Please connect your Microsoft account in Settings > Integrations.",
			};
		}

		return {
			success: false,
			transcript: "",
			wasSummarized: false,
			error: `Failed to fetch meeting transcript: ${errorMessage}`,
		};
	}
}

/**
 * List calendar meetings from the last 30 days that have online meeting
 * join URLs (Teams meetings with potential transcripts).
 *
 * @param input - User context
 * @returns Array of meetings with their join URLs
 */
export async function listCalendarMeetings(
	input: ListCalendarMeetingsInput,
): Promise<ListCalendarMeetingsOutput> {
	const { userId, organizationId } = input;

	logger.info("[BacklogContext] Listing calendar meetings", { userId });

	try {
		const result = (await executeMicrosoftTeamsTool(
			"list_calendar_meetings",
			{},
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
			logger.warn("[BacklogContext] Calendar meetings error", {
				error: result.error,
			});
			return {
				success: false,
				meetings: [],
				error: result.error,
			};
		}

		const meetings: CalendarMeeting[] = (result.meetings || []).map(
			(m) => ({
				id: m.id,
				subject: m.subject || "Untitled Meeting",
				startTime: m.start,
				organizer: m.organizer || "Unknown",
				joinUrl: m.joinUrl || null,
			}),
		);

		logger.info("[BacklogContext] Calendar meetings listed", {
			count: meetings.length,
		});

		return {
			success: true,
			meetings,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);

		// Not-connected is an expected, actionable user state (no Microsoft
		// account linked yet) — logging it at error level pollutes prod
		// error-monitoring with noise for something that isn't a fault
		// (#2525, #2255).
		if (isMicrosoftNotConnectedError(errorMessage)) {
			logger.warn("[BacklogContext] Failed to list calendar meetings", {
				error: errorMessage,
			});
		} else {
			logger.error("[BacklogContext] Failed to list calendar meetings", {
				error: errorMessage,
			});
		}

		if (
			errorMessage.includes("Microsoft not connected") ||
			errorMessage.includes("Please connect your Microsoft account")
		) {
			return {
				success: false,
				meetings: [],
				error: "Microsoft account not connected. Please connect your Microsoft account in Settings > Integrations.",
			};
		}

		return {
			success: false,
			meetings: [],
			error: `Failed to list calendar meetings: ${errorMessage}`,
		};
	}
}

/**
 * Fetch Notion page content via MCP.
 *
 * Uses the cached MCP client pattern shared across connector-backed context fetchers
 * to the user's Notion MCP server and fetch page content as markdown.
 *
 * @param input - Notion page ID, MCP config, and user context
 * @returns Page content as markdown string
 */
export async function fetchNotionPageContent(
	input: FetchNotionPageContentInput,
): Promise<FetchNotionPageContentOutput> {
	const { pageId, mcpConfigId, userId, organizationId } = input;

	logger.info("[BacklogContext] Fetching Notion page content", {
		pageId,
		mcpConfigId,
	});

	try {
		// Build redirect URI for OAuth2 token refresh
		const baseUrl = getBaseUrl();
		const redirectUri = `${baseUrl}/api/mcp/oauth/callback`;

		// Get MCP client - organizationId is critical for tenant isolation
		const { client } = await getCachedMcpClientForConfig({
			configId: mcpConfigId,
			userId,
			organizationId,
			redirectUri,
		});

		// Get available tools from the MCP server
		const tools = await client.tools();

		// Try common Notion MCP tool names for fetching a page
		const fetchToolNames = [
			"notion_retrieve_page",
			"get_page",
			"fetch_page",
			"retrieve_page",
			"notion_get_page",
		];

		let toolDef: unknown = null;
		let selectedToolName = "";

		for (const toolName of fetchToolNames) {
			if (tools[toolName]) {
				toolDef = tools[toolName];
				selectedToolName = toolName;
				break;
			}
		}

		if (!toolDef) {
			// Log available tools for debugging
			const availableTools = Object.keys(tools).join(", ");
			logger.warn(
				"[BacklogContext] No Notion page fetch tool found on MCP server",
				{ availableTools },
			);
			return {
				success: false,
				content: "",
				error: `No Notion page fetch tool found. Available tools: ${availableTools}`,
			};
		}

		logger.info("[BacklogContext] Using Notion tool", {
			toolName: selectedToolName,
		});

		// Execute the tool to fetch page content
		const tool = toolDef as unknown as {
			execute: (
				args: Record<string, unknown>,
				context: { toolCallId: string; messages: unknown[] },
			) => Promise<unknown>;
		};

		const result = await tool.execute(
			{ page_id: pageId },
			{
				toolCallId: `notion-backlog-${Date.now()}`,
				messages: [],
			},
		);

		// Parse the result - MCP tools return various formats
		let content = "";
		let title = "";

		if (result && typeof result === "object") {
			const resultObj = result as Record<string, unknown>;

			// Handle content array format (common MCP response)
			if (Array.isArray(resultObj.content)) {
				const textContent = resultObj.content.find(
					(c: unknown) =>
						typeof c === "object" &&
						c !== null &&
						(c as Record<string, unknown>).type === "text",
				) as { text?: string } | undefined;
				if (textContent?.text) {
					content = textContent.text;
				}
			}
			// Handle direct string result
			else if (typeof resultObj.result === "string") {
				content = resultObj.result;
			}
			// Handle nested content string
			else if (
				resultObj.content &&
				typeof resultObj.content === "string"
			) {
				content = resultObj.content;
			}

			// Try to extract title
			if (typeof resultObj.title === "string") {
				title = resultObj.title;
			} else if (typeof resultObj.name === "string") {
				title = resultObj.name;
			}
		} else if (typeof result === "string") {
			content = result;
		}

		// Extract title from markdown if not found
		if (!title && content) {
			const titleMatch = content.match(/^#\s+(.+)/m);
			if (titleMatch) {
				title = titleMatch[1];
			}
		}

		if (!content) {
			return {
				success: false,
				content: "",
				error: "No content returned from Notion page",
			};
		}

		logger.info("[BacklogContext] Notion page content fetched", {
			pageId,
			contentLength: content.length,
			hasTitle: !!title,
		});

		return {
			success: true,
			content,
			title,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[BacklogContext] Failed to fetch Notion page content", {
			error: errorMessage,
			pageId,
			mcpConfigId,
		});

		return {
			success: false,
			content: "",
			error: `Failed to fetch Notion page: ${errorMessage}`,
		};
	}
}

/**
 * Retrieve relevant context from the project's RAG knowledge base.
 *
 * Searches the project's Qdrant vector store using the provided query
 * and returns formatted context chunks suitable for LLM consumption.
 *
 * @param input - Project ID, query, and user context
 * @returns Formatted context chunks string
 */
export async function retrieveProjectRagContext(
	input: RetrieveProjectRagContextInput,
): Promise<RetrieveProjectRagContextOutput> {
	const { projectId, query, userId, organizationId, topK = 10 } = input;

	logger.info("[BacklogContext] Retrieving project RAG context", {
		projectId,
		queryPreview: query.substring(0, 80),
		topK,
	});

	try {
		// Use the project context retrieval with RAG settings
		const contexts = await retrieveProjectContexts({
			projectId,
			query,
			userId,
			organizationId,
			topK,
		});

		if (contexts.length === 0) {
			logger.info(
				"[BacklogContext] No relevant RAG context found for query",
				{
					projectId,
				},
			);
			return {
				success: true,
				formattedContext: "",
				chunkCount: 0,
			};
		}

		// Format contexts for prompt injection
		const formattedContext = formatContextsForPrompt(contexts);

		logger.info("[BacklogContext] RAG context retrieved", {
			projectId,
			chunkCount: contexts.length,
			formattedLength: formattedContext.length,
		});

		return {
			success: true,
			formattedContext,
			chunkCount: contexts.length,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[BacklogContext] Failed to retrieve RAG context", {
			error: errorMessage,
			projectId,
		});

		return {
			success: false,
			formattedContext: "",
			chunkCount: 0,
			error: `Failed to retrieve project context: ${errorMessage}`,
		};
	}
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Recurring meetings share a single joinUrl across all instances. If the user
 * picks an instance whose transcript hasn't synced yet, the closest cached
 * transcript is for a *different* instance — analyzing it would feed the LLM
 * the wrong meeting. Only trust the cache when the picked instance and the
 * cached instance are within this window of each other; otherwise fall
 * through to the live Graph path which authoritatively picks the right one.
 *
 * 12 hours is well below the typical recurring cadence (daily/weekly) and
 * comfortably above any clock skew between the meeting's `startTime` (from
 * the calendar event) and the transcript's `meetingDate` (from Graph).
 */
const CACHE_FRESHNESS_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Look up a previously-synced transcript for this project + joinUrl.
 *
 * Returns the cached `ProjectContext.content` directly so the backlog
 * analyzer can skip the Graph API round-trip (resolve meeting → list
 * transcripts → fetch content → maybe summarize). The auto-sync flow
 * (meeting-transcript-sync.ts) already did all of that.
 *
 * Returns null on cache miss so the caller falls back to the live path.
 * Never throws — a DB error here just degrades to the live path.
 *
 * Authorization: ProjectLinkedMeeting and ProjectMeetingTranscript both
 * scope by projectId; the caller has already proven access to the project.
 */
async function readCachedTranscript(args: {
	projectId: string;
	joinUrl: string;
	startTime?: string;
}): Promise<FetchMeetingTranscriptOutput | null> {
	const { projectId, joinUrl, startTime } = args;

	try {
		const linkedMeeting = await db.projectLinkedMeeting.findUnique({
			where: { projectId_joinUrl: { projectId, joinUrl } },
			include: {
				transcripts: {
					orderBy: { meetingDate: "desc" },
				},
			},
		});

		if (!linkedMeeting || linkedMeeting.transcripts.length === 0) {
			return null;
		}

		// Pick the transcript closest to the requested startTime, otherwise
		// fall back to the most recent.
		let chosen = linkedMeeting.transcripts[0];
		if (startTime && linkedMeeting.transcripts.length > 1) {
			const target = new Date(startTime).getTime();
			chosen = linkedMeeting.transcripts.reduce((best, t) => {
				const bestDelta = Math.abs(
					(best.meetingDate?.getTime() ?? 0) - target,
				);
				const tDelta = Math.abs(
					(t.meetingDate?.getTime() ?? 0) - target,
				);
				return tDelta < bestDelta ? t : best;
			}, chosen);
		}

		// Recurring-meeting safety: if the closest cached transcript isn't
		// for the instance the user actually picked, skip the cache and let
		// the live Graph path fetch the right one. Without this, picking
		// today's standup when only yesterday's is cached would silently
		// analyze the wrong meeting.
		if (startTime) {
			const target = new Date(startTime).getTime();
			const chosenDate = chosen.meetingDate?.getTime();
			if (
				chosenDate === undefined ||
				Math.abs(chosenDate - target) > CACHE_FRESHNESS_WINDOW_MS
			) {
				logger.info(
					"[BacklogContext] Cached transcript outside freshness window — falling through to live fetch",
					{
						projectId,
						selectedStartTime: startTime,
						closestCachedDate: chosen.meetingDate?.toISOString(),
					},
				);
				return null;
			}
		}

		if (!chosen.contextId) {
			return null;
		}

		const context = await db.projectContext.findUnique({
			where: { id: chosen.contextId },
			select: { content: true },
		});

		if (!context?.content) {
			return null;
		}

		return {
			success: true,
			transcript: context.content,
			meetingSubject: chosen.meetingSubject ?? undefined,
			wasSummarized: chosen.wasSummarized,
		};
	} catch (error) {
		logger.warn("[BacklogContext] Cache lookup failed, falling through", {
			error: error instanceof Error ? error.message : String(error),
			projectId,
		});
		return null;
	}
}

/**
 * Pick the entry whose date sits closest to the selected occurrence, or null if
 * even the closest one is outside the recurring-meeting freshness window.
 *
 * Used by the IMPORTED lookup only. The linked-meeting path above still carries
 * its own inline copy of this rule and was deliberately not converted: the two
 * differ in their no-`startTime` fallback (that one takes the newest
 * `meetingDate`, this one the newest import), and rewriting the team path to
 * match would change behaviour on a flow this card does not touch. So this is
 * the same RULE expressed twice, not one implementation shared — if you tune the
 * freshness window or the tie-break here, check whether the copy at
 * `readCachedTranscript` needs the same edit.
 *
 * An entry with no date can never win: it would be indistinguishable from the
 * right occurrence, and analyzing the wrong meeting is worse than paying for a
 * live fetch.
 */
function chooseOccurrence<T>(
	entries: T[],
	dateOf: (entry: T) => number | undefined,
	startTime?: string,
): T | null {
	if (entries.length === 0) {
		return null;
	}
	if (!startTime) {
		return entries[0];
	}

	const target = new Date(startTime).getTime();
	if (Number.isNaN(target)) {
		return entries[0];
	}

	const distance = (entry: T): number => {
		const at = dateOf(entry);
		return at === undefined
			? Number.POSITIVE_INFINITY
			: Math.abs(at - target);
	};

	const chosen = entries.reduce((best, entry) =>
		distance(entry) < distance(best) ? entry : best,
	);

	return distance(chosen) > CACHE_FRESHNESS_WINDOW_MS ? null : chosen;
}

/**
 * Look up a personal meeting the user deliberately imported into this project
 * (#2170).
 *
 * Separate from `readCachedTranscript` because an imported meeting has no
 * `ProjectLinkedMeeting` on purpose — linking would enroll a private recurring
 * meeting in ongoing auto-sync — so the linked lookup structurally cannot find
 * one. Without this, selecting an imported meeting in the feature-proposals
 * flow would pay for a fresh Graph round-trip every run, and would fail
 * outright once the user's Graph transcript access changed, even though the
 * project already holds the content.
 *
 * Never throws: a DB error here just degrades to the live path, like the lookup
 * above.
 */
async function readImportedTranscript(args: {
	projectId: string;
	joinUrl: string;
	startTime?: string;
	userId: string;
	organizationId?: string;
}): Promise<FetchMeetingTranscriptOutput | null> {
	const { projectId, joinUrl, startTime, userId, organizationId } = args;

	try {
		// Metadata first, content second. A recurring series can accumulate many
		// imported occurrences under one join URL, and transcripts run to
		// hundreds of kilobytes — selecting every body just to discard all but
		// one would pull the whole series across the wire on every analysis run.
		// `createdAt desc` makes the no-startTime case deterministic (newest
		// import wins) rather than dependent on Postgres' row order.
		const imported = await db.projectContext.findMany({
			where: {
				projectId,
				type: "MEETING_TRANSCRIPT",
				metadata: { path: ["joinUrl"], equals: joinUrl },
			},
			select: { id: true, metadata: true },
			orderBy: { createdAt: "desc" },
		});

		const chosen = chooseOccurrence(
			imported,
			(row) => {
				const meetingDate = (
					row.metadata as { meetingDate?: string } | null
				)?.meetingDate;
				if (!meetingDate) {
					return undefined;
				}
				const at = new Date(meetingDate).getTime();
				return Number.isNaN(at) ? undefined : at;
			},
			startTime,
		);

		if (!chosen) {
			return null;
		}

		const context = await db.projectContext.findUnique({
			where: { id: chosen.id },
			select: { content: true },
		});

		if (!context?.content) {
			return null;
		}

		const metadata = chosen.metadata as {
			meetingSubject?: string;
			wasSummarized?: boolean;
		} | null;

		logger.info("[BacklogContext] Imported meeting transcript cache hit", {
			projectId,
			meetingSubject: metadata?.meetingSubject,
			contentLength: context.content.length,
		});

		// Summarise on the way OUT, above the same threshold every other
		// producer of this function respects — the live path summarises before
		// returning, and the linked path returns content the sync activity had
		// already summarised at ingest.
		//
		// The import deliberately stores the transcript whole (a stored
		// fragment is data loss, and the Context tab is meant to hold the real
		// thing), which left this the only producer that could hand the
		// analyzer a 1M-character section. That is not merely large:
		// `applyTokenBudget` allocates greedily in priority order and ranks
		// `meetingTranscripts` ahead of `notionContent` and `ragContext`, so one
		// oversized import would consume the whole 80k-token budget and silently
		// drop the project's other context — a worse analysis than if the
		// meeting had never been imported.
		if (context.content.length > TRANSCRIPT_SUMMARIZATION_THRESHOLD) {
			logger.info(
				"[BacklogContext] Imported transcript exceeds threshold, summarizing",
				{
					projectId,
					originalLength: context.content.length,
					threshold: TRANSCRIPT_SUMMARIZATION_THRESHOLD,
				},
			);
			return {
				success: true,
				transcript: await summarizeTranscript(
					context.content,
					metadata?.meetingSubject || "Meeting",
					userId,
					organizationId,
					projectId,
				),
				meetingSubject: metadata?.meetingSubject,
				wasSummarized: true,
			};
		}

		return {
			success: true,
			transcript: context.content,
			meetingSubject: metadata?.meetingSubject,
			wasSummarized: metadata?.wasSummarized ?? false,
		};
	} catch (error) {
		logger.warn(
			"[BacklogContext] Imported transcript lookup failed, falling through",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId,
			},
		);
		return null;
	}
}

/**
 * Summarize a long transcript using an LLM.
 *
 * Used when meeting transcripts exceed 50K characters to keep
 * the backlog context size manageable.
 */
async function summarizeTranscript(
	transcript: string,
	meetingSubject: string,
	userId: string,
	organizationId?: string,
	projectId?: string,
): Promise<string> {
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{
				taskType: "SIMPLE",
				complexity: "simple",
			},
			{ userId, organizationId, featureKey: "backlog-update" },
		);

		const generationStart = Date.now();
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
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType: "SIMPLE",
			usage: response.usage,
			latencyMs: Date.now() - generationStart,
			projectId,
		});

		const summary = response.text || "";

		if (summary.trim().length === 0) {
			logger.warn(
				"[BacklogContext] LLM returned empty summary, using truncated transcript",
			);
			return transcript.substring(0, TRANSCRIPT_SUMMARIZATION_THRESHOLD);
		}

		logger.info("[BacklogContext] Transcript summarized", {
			originalLength: transcript.length,
			summaryLength: summary.length,
		});

		return `## Meeting Summary: ${meetingSubject}\n\n${summary}`;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[BacklogContext] Failed to summarize transcript", {
			error: errorMessage,
		});

		// Fall back to truncated transcript
		return transcript.substring(0, TRANSCRIPT_SUMMARIZATION_THRESHOLD);
	}
}

// =============================================================================
// Architecture Decisions Fetcher
// =============================================================================

const MAX_DECISIONS_FOR_BACKLOG = 50;

export interface FetchDecisionsForBacklogInput {
	projectId: string;
}

export interface FetchDecisionsForBacklogOutput {
	success: boolean;
	formattedDecisions: string;
	decisionCount: number;
}

/**
 * Fetch ACCEPTED and PROPOSED architecture decisions for the backlog analysis
 * prompt. ACCEPTED decisions are binding architectural constraints the LLM
 * must respect when proposing changes. PROPOSED ones are under active
 * discussion and may also inform proposals. Returns an empty string when there
 * are no relevant decisions so the caller can skip the context section.
 */
export async function fetchDecisionsForBacklog(
	input: FetchDecisionsForBacklogInput,
): Promise<FetchDecisionsForBacklogOutput> {
	const { projectId } = input;

	const [acceptedResult, proposedResult] = await Promise.all([
		listArchitectureDecisions({
			projectId,
			status: "ACCEPTED",
			limit: MAX_DECISIONS_FOR_BACKLOG,
		}),
		listArchitectureDecisions({
			projectId,
			status: "PROPOSED",
			limit: 20,
		}),
	]);

	const accepted = acceptedResult.items;
	const proposed = proposedResult.items;

	if (accepted.length === 0 && proposed.length === 0) {
		return { success: true, formattedDecisions: "", decisionCount: 0 };
	}

	const lines: string[] = [];

	if (accepted.length > 0) {
		lines.push(
			`${accepted.length} accepted architecture decision${accepted.length === 1 ? "" : "s"} (binding constraints):`,
			"",
		);
		for (const d of accepted) {
			const domain = d.domain ? ` (${d.domain})` : "";
			const endorsed = d.vouchedAt ? " [endorsed]" : "";
			lines.push(
				`- [ACCEPTED${endorsed}] ${d.identifier}: ${d.title}${domain}`,
			);
			if (d.rationale.trim()) {
				lines.push(
					`  Rationale: ${d.rationale.trim().slice(0, 200)}${d.rationale.length > 200 ? "…" : ""}`,
				);
			}
		}
	}

	if (proposed.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push(
			`${proposed.length} proposed architecture decision${proposed.length === 1 ? "" : "s"} (awaiting review — not yet binding):`,
			"",
		);
		for (const d of proposed) {
			const domain = d.domain ? ` (${d.domain})` : "";
			lines.push(`- [PROPOSED] ${d.identifier}: ${d.title}${domain}`);
			if (d.rationale.trim()) {
				lines.push(
					`  Rationale: ${d.rationale.trim().slice(0, 150)}${d.rationale.length > 150 ? "…" : ""}`,
				);
			}
		}
	}

	const total = accepted.length + proposed.length;

	logger.info(
		"[BacklogContext] Fetched architecture decisions for backlog analysis",
		{
			projectId,
			accepted: accepted.length,
			proposed: proposed.length,
		},
	);

	return {
		success: true,
		formattedDecisions: lines.join("\n"),
		decisionCount: total,
	};
}

// =============================================================================
// Security Findings Fetcher
// =============================================================================

const MAX_FINDINGS_FOR_BACKLOG = 50;

export interface FetchSecurityFindingsForBacklogInput {
	projectId: string;
}

export interface FetchSecurityFindingsForBacklogOutput {
	success: boolean;
	formattedFindings: string;
	findingCount: number;
}

/**
 * Fetch OPEN security findings from the project's latest completed scan and
 * format them for the backlog analysis prompt. Returns an empty string when
 * there are no findings so the caller can skip the context section entirely.
 */
export async function fetchSecurityFindingsForBacklog(
	input: FetchSecurityFindingsForBacklogInput,
): Promise<FetchSecurityFindingsForBacklogOutput> {
	const { projectId } = input;

	const latestScan = await getLatestProjectScan(projectId, {
		status: "COMPLETED",
	});

	if (!latestScan) {
		return { success: true, formattedFindings: "", findingCount: 0 };
	}

	const findings = await listScanFindings(projectId, {
		scanId: latestScan.id,
		category: "SECURITY",
		status: "OPEN",
		sort: "severity",
		limit: MAX_FINDINGS_FOR_BACKLOG + 1,
	});

	if (findings.length === 0) {
		return { success: true, formattedFindings: "", findingCount: 0 };
	}

	const hasMore = findings.length > MAX_FINDINGS_FOR_BACKLOG;
	const shownFindings = findings.slice(0, MAX_FINDINGS_FOR_BACKLOG);
	const scanDate =
		latestScan.completedAt?.toISOString().slice(0, 10) ?? "unknown date";
	const header = hasMore
		? `Showing the first ${shownFindings.length} open security findings from the latest security scan (${scanDate}). More findings exist:`
		: `${shownFindings.length} open security finding${shownFindings.length === 1 ? "" : "s"} from the latest security scan (${scanDate}):`;
	const lines: string[] = [header, ""];

	for (const finding of shownFindings) {
		lines.push(
			`- [${finding.severity}] ${finding.title} (${finding.category}; rule: ${finding.ruleSource})${finding.location ? ` — ${finding.location}` : ""}${finding.story?.identifier ? ` [linked: ${finding.story.identifier}]` : ""}`,
		);
		if (finding.description) {
			lines.push(
				`  Description: ${finding.description.slice(0, 200)}${finding.description.length > 200 ? "…" : ""}`,
			);
		}
		if (finding.remediation) {
			lines.push(
				`  Remediation: ${finding.remediation.slice(0, 200)}${finding.remediation.length > 200 ? "…" : ""}`,
			);
		}
	}

	logger.info(
		"[BacklogContext] Fetched security findings for backlog analysis",
		{
			projectId,
			findingCount: shownFindings.length,
			hasMore,
			scanId: latestScan.id,
		},
	);

	return {
		success: true,
		formattedFindings: lines.join("\n"),
		findingCount: shownFindings.length,
	};
}
