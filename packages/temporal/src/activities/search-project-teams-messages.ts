/**
 * Search Project Teams Messages Activity
 *
 * Searches Microsoft Teams messages in chats and channels configured for a project.
 * Used as a tool by the document generation agent to find relevant context.
 *
 * This activity:
 * 1. Looks up configured Teams chats/channels from ProjectContext (type=INTEGRATION)
 * 2. Searches those specific sources using Microsoft Graph API
 * 3. Returns relevant messages matching the query
 *
 * Supports both group chats (chatType="group") and team channels (chatType="channel").
 */

import {
	extractRelevantExcerpts,
	type RawExtractableMessage,
	type RelevantExcerpt,
} from "@repo/ai";
import { db, type ProjectContextType } from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
	TEAMS_TOOL_LIMITS,
} from "@repo/integrations/microsoft";
import { subDays } from "date-fns";

// Excerpt enriched with the routing IDs the agent needs for follow-ups
// (get_full_message / list_message_replies require chatId OR teamId+channelId).
export interface EnrichedRelevantExcerpt extends RelevantExcerpt {
	chatId?: string | null;
	teamId?: string | null;
	channelId?: string | null;
	chatName?: string | null;
}

// Internal type for parsed Teams contexts (both chats and channels)
interface TeamsIntegrationContext {
	type: "chat" | "channel";
	chatId?: string;
	teamId?: string;
	channelId?: string;
	displayName: string;
}

/**
 * Parse Teams integration contexts from ProjectContext metadata.
 * Handles both group chats (chatId) and team channels (teamId + channelId).
 */
function parseTeamsContexts(
	integrationContexts: Array<{ id: string; metadata: unknown }>,
): TeamsIntegrationContext[] {
	const contexts: TeamsIntegrationContext[] = [];

	for (const ctx of integrationContexts) {
		const metadata = ctx.metadata as Record<string, unknown> | null;
		if (metadata?.provider !== "MICROSOFT_TEAMS") {
			continue;
		}

		const chatType = metadata?.chatType as string;

		if (chatType === "channel" && metadata?.teamId && metadata?.channelId) {
			contexts.push({
				type: "channel",
				teamId: metadata.teamId as string,
				channelId: metadata.channelId as string,
				displayName: (metadata.chatTopic as string) || "Teams Channel",
			});
		} else if (metadata?.chatId) {
			contexts.push({
				type: "chat",
				chatId: metadata.chatId as string,
				displayName: (metadata.chatTopic as string) || "Teams Chat",
			});
		}
	}

	return contexts;
}

/**
 * Filter an array of messages to those within the last `daysBack` days.
 * Messages with no `createdAt` are dropped when the filter is active.
 * When `daysBack` is undefined, the original array is returned.
 * `now` is injectable for testing; defaults to `new Date()`.
 */
export function filterMessagesByDaysBack<T extends { createdAt?: string }>(
	messages: T[],
	daysBack: number | undefined,
	now: Date = new Date(),
): T[] {
	if (daysBack === undefined) {
		return messages;
	}
	const cutoff = subDays(now, daysBack).getTime();
	return messages.filter(
		(m) =>
			m.createdAt !== undefined &&
			new Date(m.createdAt).getTime() >= cutoff,
	);
}

/**
 * Input for the search activity
 */
export interface SearchProjectTeamsMessagesInput {
	/** The project to search Teams messages for */
	projectId: string;
	/** Search query - keywords, phrases, or topics */
	query: string;
	/**
	 * Optional second query for a parallel search pass. When supplied, the
	 * activity runs both Graph searches concurrently and merges the
	 * relevance-extracted excerpts (dedup by messageId, keep higher score).
	 * Skipped when identical to `query` or empty.
	 */
	alternateQuery?: string;
	/**
	 * Optional stage-specific prompt (e.g., the user's custom prompt for
	 * the current feature stage). Passed to the relevance extractor as a
	 * secondary lens so excerpts align with the active workflow step.
	 */
	stagePrompt?: string;
	/** User ID for OAuth credentials */
	userId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** Maximum number of messages to return (default: 15) */
	limit?: number;
}

/**
 * A Teams message from search results
 */
export interface TeamsSearchMessage {
	id: string;
	content: string;
	from: string;
	fromEmail?: string;
	createdAt?: string;
	chatId?: string;
	teamId?: string;
	channelId?: string;
	chatName?: string;
	webLink?: string;
}

/**
 * Result of the search activity
 */
export interface SearchProjectTeamsMessagesResult {
	messages: TeamsSearchMessage[];
	totalCount: number;
	query: string;
	searchedChats: string[];
	errors: string[];
	/**
	 * Relevance-extracted excerpts. Present when the caller supplied a
	 * query (always true via the agent path). Each excerpt carries
	 * chatId/teamId/channelId so the agent can drill down with
	 * get_full_message / list_message_replies without re-fetching.
	 */
	excerpts?: EnrichedRelevantExcerpt[];
	/** Whether a second search pass ran. */
	twoPass?: boolean;
}

/**
 * Check if a project has Microsoft Teams integration configured.
 * Used by the workflow to decide whether to use iterative Teams search.
 */
export async function checkProjectHasTeamsIntegration(params: {
	projectId: string;
}): Promise<boolean> {
	const { projectId } = params;

	const integrationCount = await db.projectContext.count({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
		},
	});

	return integrationCount > 0;
}

/**
 * Search Microsoft Teams messages in chats and channels configured for a project.
 *
 * This activity is designed to be used as a tool by the document generation agent.
 * It searches only the Teams chats/channels that have been linked to the project
 * as INTEGRATION contexts.
 */
export async function searchProjectTeamsMessages(
	input: SearchProjectTeamsMessagesInput,
): Promise<SearchProjectTeamsMessagesResult> {
	const {
		projectId,
		query,
		alternateQuery,
		stagePrompt,
		userId,
		organizationId,
		limit = 15,
	} = input;
	const errors: string[] = [];
	const searchedChats: string[] = [];

	console.log(
		`[SearchProjectTeamsMessages] Searching for "${query}" in project ${projectId}`,
	);

	// Fetch INTEGRATION type contexts for this project
	const integrationContexts = await db.projectContext.findMany({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
		},
		select: {
			id: true,
			content: true,
			metadata: true,
		},
	});

	if (integrationContexts.length === 0) {
		console.log(
			"[SearchProjectTeamsMessages] No Teams contexts configured for this project",
		);
		return {
			messages: [],
			totalCount: 0,
			query,
			searchedChats: [],
			errors: [
				"No Microsoft Teams chats or channels are linked to this project. The user needs to add Teams chats or channels in the project's Contexts tab.",
			],
		};
	}

	// Parse both chat and channel contexts
	const teamsContexts = parseTeamsContexts(integrationContexts);

	if (teamsContexts.length === 0) {
		return {
			messages: [],
			totalCount: 0,
			query,
			searchedChats: [],
			errors: [
				"No valid Microsoft Teams chat or channel configurations found.",
			],
		};
	}

	// Build lookup sets for filtering search results
	const configuredChatIds = new Set(
		teamsContexts
			.filter((c) => c.type === "chat" && c.chatId)
			// biome-ignore lint/style/noNonNullAssertion: chatId exists due to .filter(c => c.chatId) above
			.map((c) => c.chatId!),
	);
	const configuredChannels = new Map(
		teamsContexts
			.filter((c) => c.type === "channel" && c.teamId && c.channelId)
			.map((c) => [`${c.teamId}:${c.channelId}`, c.displayName]),
	);
	const chatIdToName = new Map(
		teamsContexts
			.filter((c) => c.type === "chat")
			// biome-ignore lint/style/noNonNullAssertion: chatId exists due to .filter(c => c.type === 'chat') above
			.map((c) => [c.chatId!, c.displayName]),
	);

	for (const ctx of teamsContexts) {
		searchedChats.push(ctx.displayName);
	}

	console.log(
		`[SearchProjectTeamsMessages] Searching ${teamsContexts.length} Teams contexts (${configuredChatIds.size} chats, ${configuredChannels.size} channels)`,
	);

	// Use Microsoft Graph search API
	// The search_messages method searches across all accessible chats and channels,
	// so we'll filter results to only include messages from our configured sources
	const runSearchPass = async (
		passQuery: string,
	): Promise<TeamsSearchMessage[]> => {
		const searchResult = (await executeMicrosoftTeamsTool(
			"search_messages",
			{
				query: passQuery,
				limit: Math.min(limit * 2, 100), // Get extra to filter
			},
			userId,
			organizationId,
		)) as {
			messages: Array<{
				id: string;
				content: string;
				from: string;
				fromEmail?: string;
				createdAt?: string;
				chatId?: string;
				teamId?: string;
				channelId?: string;
				webLink?: string;
			}>;
			count: number;
			totalHits?: number;
		};

		const filtered: TeamsSearchMessage[] = [];
		for (const msg of searchResult.messages || []) {
			const matchesChat = msg.chatId && configuredChatIds.has(msg.chatId);
			const channelKey =
				msg.teamId && msg.channelId
					? `${msg.teamId}:${msg.channelId}`
					: null;
			const matchesChannel =
				channelKey && configuredChannels.has(channelKey);

			if (matchesChat || matchesChannel) {
				filtered.push({
					id: msg.id,
					content: msg.content,
					from: msg.from,
					fromEmail: msg.fromEmail,
					createdAt: msg.createdAt,
					chatId: msg.chatId,
					teamId: msg.teamId,
					channelId: msg.channelId,
					chatName: matchesChat
						? // biome-ignore lint/style/noNonNullAssertion: chatId is non-null since it's used as the map key
							chatIdToName.get(msg.chatId!)
						: channelKey
							? configuredChannels.get(channelKey)
							: undefined,
					webLink: msg.webLink,
				});
				if (filtered.length >= limit * 2) {
					break;
				}
			}
		}
		return filtered;
	};

	const toRawExtractable = (
		msgs: TeamsSearchMessage[],
	): RawExtractableMessage[] =>
		msgs.map((m) => ({
			messageId: m.id,
			from: m.from,
			createdAt: m.createdAt,
			webLink: m.webLink,
			content: m.content,
		}));

	const normalizedAlt =
		alternateQuery?.trim() && alternateQuery.trim() !== query.trim()
			? alternateQuery.trim()
			: undefined;

	try {
		const passPromises: Promise<TeamsSearchMessage[]>[] = [
			runSearchPass(query),
		];
		if (normalizedAlt) {
			passPromises.push(runSearchPass(normalizedAlt));
		}
		const passes = await Promise.all(passPromises);
		const pass1Filtered = passes[0] ?? [];
		const pass2Filtered = passes[1] ?? [];

		// Merged raw list for callers that still expect the legacy `messages` field
		const mergedById = new Map<string, TeamsSearchMessage>();
		for (const m of [...pass1Filtered, ...pass2Filtered]) {
			if (!mergedById.has(m.id)) {
				mergedById.set(m.id, m);
			}
		}
		const mergedMessages = Array.from(mergedById.values()).slice(0, limit);

		// Run the extractor per pass (different query) so each pass surfaces
		// its own most-relevant subset, then dedupe by messageId keeping the
		// higher relevance score.
		const extractorPasses = await Promise.all([
			extractRelevantExcerpts({
				rawMessages: toRawExtractable(pass1Filtered),
				query,
				stagePrompt,
				userId,
				organizationId,
				maxExcerpts: TEAMS_TOOL_LIMITS.EXCERPTS_PER_PASS,
				maxCharsPerExcerpt: TEAMS_TOOL_LIMITS.MAX_CHARS_PER_EXCERPT,
				timeoutMs: TEAMS_TOOL_LIMITS.EXTRACTOR_TIMEOUT_MS,
				toolName: "search_teams_messages:pass1",
			}),
			normalizedAlt
				? extractRelevantExcerpts({
						rawMessages: toRawExtractable(pass2Filtered),
						query: normalizedAlt,
						stagePrompt,
						userId,
						organizationId,
						maxExcerpts: TEAMS_TOOL_LIMITS.EXCERPTS_PER_PASS,
						maxCharsPerExcerpt:
							TEAMS_TOOL_LIMITS.MAX_CHARS_PER_EXCERPT,
						timeoutMs: TEAMS_TOOL_LIMITS.EXTRACTOR_TIMEOUT_MS,
						toolName: "search_teams_messages:pass2",
					})
				: Promise.resolve(null),
		]);

		const dedupedExcerpts = new Map<string, RelevantExcerpt>();
		for (const result of extractorPasses) {
			if (!result) {
				continue;
			}
			for (const e of result.excerpts) {
				const existing = dedupedExcerpts.get(e.messageId);
				if (
					!existing ||
					(e.relevance ?? 0) > (existing.relevance ?? 0)
				) {
					dedupedExcerpts.set(e.messageId, e);
				}
			}
		}
		const mergedExcerpts: EnrichedRelevantExcerpt[] = Array.from(
			dedupedExcerpts.values(),
		)
			.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
			.slice(0, TEAMS_TOOL_LIMITS.MAX_EXCERPTS_MERGED)
			.map((e) => {
				const src = mergedById.get(e.messageId);
				return {
					...e,
					chatId: src?.chatId ?? null,
					teamId: src?.teamId ?? null,
					channelId: src?.channelId ?? null,
					chatName: src?.chatName ?? null,
				};
			});

		console.log(
			`[SearchProjectTeamsMessages] pass1=${pass1Filtered.length} pass2=${pass2Filtered.length} excerpts=${mergedExcerpts.length} twoPass=${!!normalizedAlt}`,
		);

		return {
			messages: mergedMessages,
			totalCount: mergedMessages.length,
			query,
			searchedChats,
			errors,
			excerpts: mergedExcerpts,
			twoPass: !!normalizedAlt,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		// Not-connected is an expected, actionable user state (no Microsoft
		// account linked yet) — logging it at error level pollutes prod
		// error-monitoring with noise for something that isn't a fault (#2525).
		if (isMicrosoftNotConnectedError(errorMessage)) {
			console.warn(
				`[SearchProjectTeamsMessages] Search failed: ${errorMessage}`,
			);
		} else {
			console.error(
				`[SearchProjectTeamsMessages] Search failed: ${errorMessage}`,
			);
		}

		// Check for common OAuth issues
		if (
			errorMessage.includes("Microsoft not connected") ||
			errorMessage.includes("Please connect your Microsoft account")
		) {
			errors.push(
				"Microsoft account not connected. Please connect your Microsoft account in Settings > Integrations.",
			);
		} else if (
			errorMessage.includes("expired") ||
			errorMessage.includes("refresh failed")
		) {
			errors.push(
				"Microsoft session expired. Please reconnect your Microsoft account in Settings > Integrations.",
			);
		} else {
			errors.push(`Failed to search Teams messages: ${errorMessage}`);
		}

		return {
			messages: [],
			totalCount: 0,
			query,
			searchedChats,
			errors,
		};
	}
}

// ============================================================================
// FETCH RECENT TEAMS MESSAGES
// ============================================================================

/**
 * Input for fetching recent Teams messages
 */
export interface FetchRecentTeamsMessagesInput {
	/** The project to fetch Teams messages for */
	projectId: string;
	/** User ID for OAuth credentials */
	userId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** Maximum number of messages to return (default: 10) */
	limit?: number;
	/**
	 * Optional filter: restrict to these ProjectContext IDs. When provided and
	 * non-empty, only these contexts are queried. When omitted or empty, all
	 * INTEGRATION contexts for the project are queried (legacy behavior).
	 */
	contextIds?: string[];
	/**
	 * Optional time window. When set, messages older than `now - daysBack` days
	 * are dropped. Messages with no createdAt are dropped when this is set.
	 */
	daysBack?: number;
}

/**
 * Result of fetching recent Teams messages
 */
export interface FetchRecentTeamsMessagesResult {
	/** Formatted messages ready to add to contexts[] */
	formattedContexts: string[];
	/** Number of messages fetched */
	messageCount: number;
	/** Names of chats/channels that were fetched from */
	fetchedChats: string[];
	/** Any errors encountered (non-fatal) */
	errors: string[];
}

/**
 * Fetch recent Teams messages for a project.
 *
 * Unlike searchProjectTeamsMessages (which requires a query), this fetches the
 * last N messages chronologically. Used to provide Teams context to BOTH
 * workflow paths (iterative and non-iterative), ensuring custom prompt users
 * also get Teams context.
 *
 * Supports both group chats (via get_chat_messages) and team channels
 * (via list_messages).
 *
 * This is called in Step 2.6 of the document generation workflow, BEFORE the
 * path decision (shouldUseIterativePattern), so both paths receive the messages.
 */
export async function fetchRecentTeamsMessages(
	input: FetchRecentTeamsMessagesInput,
): Promise<FetchRecentTeamsMessagesResult> {
	const {
		projectId,
		userId,
		organizationId,
		limit = 10,
		contextIds,
		daysBack,
	} = input;
	const errors: string[] = [];
	const fetchedChats: string[] = [];

	console.log(
		`[FetchRecentTeamsMessages] Fetching recent messages for project ${projectId}`,
	);

	// Fetch INTEGRATION type contexts for this project
	const integrationContexts = await db.projectContext.findMany({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
			...(contextIds && contextIds.length > 0
				? { id: { in: contextIds } }
				: {}),
		},
		select: {
			id: true,
			metadata: true,
		},
	});

	if (integrationContexts.length === 0) {
		console.log(
			"[FetchRecentTeamsMessages] No Teams contexts configured for this project",
		);
		return {
			formattedContexts: [],
			messageCount: 0,
			fetchedChats: [],
			errors: [],
		};
	}

	// Parse both chat and channel contexts
	const teamsContexts = parseTeamsContexts(integrationContexts);

	if (teamsContexts.length === 0) {
		return {
			formattedContexts: [],
			messageCount: 0,
			fetchedChats: [],
			errors: [],
		};
	}

	console.log(
		`[FetchRecentTeamsMessages] Fetching from ${teamsContexts.length} Teams contexts`,
	);

	// Fetch recent messages from each context (chats and channels)
	interface TeamsMessage {
		content: string;
		from: string;
		createdAt?: string;
		chatName: string;
	}

	const messagesPerContext = Math.ceil(limit / teamsContexts.length);

	interface ContextFetchResult {
		messages: TeamsMessage[];
		displayName: string;
	}

	// Emitted at most once per invocation — every configured context can fail
	// not-connected in the same call (one Microsoft account backs them all), and
	// without this a single polling cycle logs the same not-connected line 5-7
	// times (#2255). Genuine errors are still logged per context, unsuppressed.
	let notConnectedWarned = false;

	const perContext = await Promise.allSettled(
		teamsContexts.map(async (ctx): Promise<ContextFetchResult | null> => {
			let result: {
				messages: Array<{
					id: string;
					content: string;
					from: string;
					createdAt?: string;
				}>;
				count: number;
			};

			if (ctx.type === "chat" && ctx.chatId) {
				result = (await executeMicrosoftTeamsTool(
					"get_chat_messages",
					{ chatId: ctx.chatId, limit: messagesPerContext },
					userId,
					organizationId,
				)) as typeof result;
			} else if (ctx.type === "channel" && ctx.teamId && ctx.channelId) {
				result = (await executeMicrosoftTeamsTool(
					"list_messages",
					{
						teamId: ctx.teamId,
						channelId: ctx.channelId,
						limit: messagesPerContext,
					},
					userId,
					organizationId,
				)) as typeof result;
			} else {
				return null;
			}

			const messages: TeamsMessage[] = [];
			for (const msg of result.messages || []) {
				if (msg.content && msg.content.trim().length > 0) {
					messages.push({
						content: msg.content,
						from: msg.from,
						createdAt: msg.createdAt,
						chatName: ctx.displayName,
					});
				}
			}
			return { messages, displayName: ctx.displayName };
		}),
	);

	const allMessages: TeamsMessage[] = [];
	for (let i = 0; i < perContext.length; i++) {
		const settled = perContext[i];
		const ctx = teamsContexts[i];
		if (settled.status === "fulfilled") {
			if (!settled.value) {
				continue;
			}
			allMessages.push(...settled.value.messages);
			fetchedChats.push(settled.value.displayName);
		} else {
			const errorMessage =
				settled.reason instanceof Error
					? settled.reason.message
					: String(settled.reason);
			if (isMicrosoftNotConnectedError(errorMessage)) {
				if (!notConnectedWarned) {
					console.warn(
						`[FetchRecentTeamsMessages] Error fetching from ${ctx.displayName}:`,
						errorMessage,
					);
					notConnectedWarned = true;
				}
			} else {
				console.error(
					`[FetchRecentTeamsMessages] Error fetching from ${ctx.displayName}:`,
					errorMessage,
				);
			}
			errors.push(
				`Failed to fetch from ${ctx.displayName}: ${errorMessage}`,
			);
		}
	}

	if (allMessages.length === 0) {
		console.log("[FetchRecentTeamsMessages] No messages found");
		return {
			formattedContexts: [],
			messageCount: 0,
			fetchedChats,
			errors,
		};
	}

	// Narrow to the requested time window (if any) before sorting
	const windowedMessages = filterMessagesByDaysBack(allMessages, daysBack);

	if (windowedMessages.length === 0) {
		console.log("[FetchRecentTeamsMessages] No messages in time window");
		return {
			formattedContexts: [],
			messageCount: 0,
			fetchedChats,
			errors,
		};
	}

	// Sort by createdAt (most recent first) and limit
	windowedMessages.sort((a, b) => {
		if (!a.createdAt || !b.createdAt) {
			return 0;
		}
		return (
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		);
	});

	const limitedMessages = windowedMessages.slice(0, limit);

	// Format messages for context
	const formattedContexts: string[] = [];

	// Create a single formatted context string with all messages
	const messageLines: string[] = [
		"## Recent Microsoft Teams Discussions\n",
		"The following are recent messages from Teams chats and channels linked to this project:\n",
	];

	for (const msg of limitedMessages) {
		const timestamp = msg.createdAt
			? new Date(msg.createdAt).toLocaleString("en-US", {
					month: "short",
					day: "numeric",
					year: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				})
			: "Unknown time";

		messageLines.push(`[${msg.chatName} - ${timestamp}]`);
		messageLines.push(`From: ${msg.from}`);
		messageLines.push(`${msg.content}\n`);
	}

	formattedContexts.push(messageLines.join("\n"));

	console.log(
		`[FetchRecentTeamsMessages] Formatted ${limitedMessages.length} messages from ${fetchedChats.length} contexts`,
	);

	return {
		formattedContexts,
		messageCount: limitedMessages.length,
		fetchedChats,
		errors,
	};
}
