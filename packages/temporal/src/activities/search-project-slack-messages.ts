/**
 * Search Project Slack Messages Activity
 *
 * Searches Slack messages in channels configured for a project.
 * Used as a tool by the document generation agent to find relevant context.
 *
 * This activity:
 * 1. Looks up configured Slack channels from ProjectContext (type=INTEGRATION)
 * 2. Searches/fetches those specific channels using Slack API
 * 3. Returns relevant messages matching the query
 *
 * Mirrors the Teams equivalent: search-project-teams-messages.ts
 */

import { db, type ProjectContextType } from "@repo/database";
import { executeSlackTool } from "@repo/integrations/slack";

// Internal type for parsed Slack contexts
interface SlackIntegrationContext {
	channelId: string;
	channelName: string;
	mcpConfigId?: string;
}

/**
 * Parse Slack integration contexts from ProjectContext metadata.
 */
function parseSlackContexts(
	integrationContexts: Array<{ id: string; metadata: unknown }>,
): SlackIntegrationContext[] {
	const contexts: SlackIntegrationContext[] = [];

	for (const ctx of integrationContexts) {
		const metadata = ctx.metadata as Record<string, unknown> | null;
		if (metadata?.provider !== "SLACK") {
			continue;
		}

		if (metadata?.channelId) {
			contexts.push({
				channelId: metadata.channelId as string,
				channelName:
					(metadata.channelName as string) || "Slack Channel",
				mcpConfigId: metadata.mcpConfigId as string | undefined,
			});
		}
	}

	return contexts;
}

/**
 * Input for the search activity
 */
export interface SearchProjectSlackMessagesInput {
	/** The project to search Slack messages for */
	projectId: string;
	/** Search query - keywords, phrases, or topics */
	query: string;
	/** User ID for OAuth credentials */
	userId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** Maximum number of messages to return (default: 15) */
	limit?: number;
}

/**
 * A Slack message from search results
 */
export interface SlackSearchMessage {
	id: string;
	content: string;
	from: string;
	createdAt?: string;
	channelId?: string;
	channelName?: string;
	/** Parent thread timestamp when this message participates in a thread. */
	threadTs?: string;
	/** Direct link to the message in Slack (only set on search.messages results). */
	permalink?: string;
}

/**
 * Result of the search activity
 */
export interface SearchProjectSlackMessagesResult {
	messages: SlackSearchMessage[];
	totalCount: number;
	query: string;
	searchedChannels: string[];
	errors: string[];
}

/**
 * Tool definition for the document generation agent
 */
export const SEARCH_SLACK_MESSAGES_TOOL_DEFINITION = {
	name: "search_slack_messages",
	description: `Search for messages in Slack channels that are linked to this project.
Use this tool when you need to find relevant context from Slack discussions, decisions, or conversations.
The search will only look in channels that have been configured for this project.

Examples of when to use:
- "Search for discussions about authentication requirements"
- "Find messages mentioning the API design"
- "Look for any decisions made about the database schema"

Tips for effective searches:
- Use specific keywords related to the document you're generating
- Search for people's names if looking for their input: "from:@user"
- Search for topics, features, or technical terms mentioned in discussions`,
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"Search query - can include keywords, phrases, or 'from:@user' to filter by sender",
			},
			limit: {
				type: "number",
				description:
					"Maximum number of messages to return (default: 15, max: 50)",
			},
		},
		required: ["query"],
	},
};

/**
 * Check if a project has Slack integration configured.
 * Looks for INTEGRATION contexts with provider=SLACK.
 */
export async function checkProjectHasSlackIntegration(params: {
	projectId: string;
}): Promise<boolean> {
	const { projectId } = params;

	const integrationContexts = await db.projectContext.findMany({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
		},
		select: {
			metadata: true,
		},
	});

	return integrationContexts.some((ctx) => {
		const metadata = ctx.metadata as Record<string, unknown> | null;
		return metadata?.provider === "SLACK";
	});
}

/**
 * Search Slack messages in channels configured for a project.
 *
 * This activity is designed to be used as a tool by the document generation agent.
 * It searches only the Slack channels that have been linked to the project
 * as INTEGRATION contexts.
 */
export async function searchProjectSlackMessages(
	input: SearchProjectSlackMessagesInput,
): Promise<SearchProjectSlackMessagesResult> {
	const { projectId, query, userId, organizationId, limit = 15 } = input;
	const errors: string[] = [];
	const searchedChannels: string[] = [];

	console.log("[SearchProjectSlackMessages] Searching", { query, projectId });

	// Fetch INTEGRATION type contexts for this project
	const integrationContexts = await db.projectContext.findMany({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
		},
		select: {
			id: true,
			metadata: true,
		},
	});

	if (integrationContexts.length === 0) {
		console.log(
			"[SearchProjectSlackMessages] No Slack contexts configured for this project",
		);
		return {
			messages: [],
			totalCount: 0,
			query,
			searchedChannels: [],
			errors: [
				"No Slack channels are linked to this project. The user needs to add Slack channels in the project's Contexts tab.",
			],
		};
	}

	const slackContexts = parseSlackContexts(integrationContexts);

	if (slackContexts.length === 0) {
		return {
			messages: [],
			totalCount: 0,
			query,
			searchedChannels: [],
			errors: ["No valid Slack channel configurations found."],
		};
	}

	// Build lookup set for filtering search results
	const configuredChannelIds = new Set(slackContexts.map((c) => c.channelId));
	const channelIdToName = new Map(
		slackContexts.map((c) => [c.channelId, c.channelName]),
	);

	for (const ctx of slackContexts) {
		searchedChannels.push(ctx.channelName);
	}

	console.log(
		`[SearchProjectSlackMessages] Searching ${slackContexts.length} Slack channels`,
	);

	try {
		const searchResult = (await executeSlackTool(
			"search_messages",
			{
				query,
				limit: Math.min(limit * 2, 100), // Get extra to filter
			},
			userId,
			organizationId,
		)) as {
			messages: Array<{
				id: string;
				content: string;
				from: string;
				createdAt?: string;
				channelId?: string;
				channelName?: string;
				threadTs?: string;
				permalink?: string;
			}>;
			count: number;
			totalHits?: number;
			error?: string;
		};

		if (searchResult.error) {
			errors.push(searchResult.error);
		}

		const filteredMessages: SlackSearchMessage[] = [];

		for (const msg of searchResult.messages || []) {
			// Filter to only configured channels
			if (msg.channelId && configuredChannelIds.has(msg.channelId)) {
				filteredMessages.push({
					id: msg.id,
					content: msg.content,
					from: msg.from,
					createdAt: msg.createdAt,
					channelId: msg.channelId,
					channelName:
						channelIdToName.get(msg.channelId) || msg.channelName,
					threadTs: msg.threadTs,
					permalink: msg.permalink,
				});

				if (filteredMessages.length >= limit) {
					break;
				}
			}
		}

		console.log(
			`[SearchProjectSlackMessages] Found ${filteredMessages.length} messages matching query`,
		);

		return {
			messages: filteredMessages,
			totalCount: filteredMessages.length,
			query,
			searchedChannels,
			errors,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		console.error(
			`[SearchProjectSlackMessages] Search failed: ${errorMessage}`,
		);

		if (
			errorMessage.includes("Slack not connected") ||
			errorMessage.includes("Please connect your Slack")
		) {
			errors.push(
				"Slack not connected. Please connect your Slack workspace in Settings > Integrations.",
			);
		} else {
			errors.push(`Failed to search Slack messages: ${errorMessage}`);
		}

		return {
			messages: [],
			totalCount: 0,
			query,
			searchedChannels,
			errors,
		};
	}
}

// ============================================================================
// FETCH RECENT SLACK MESSAGES
// ============================================================================

/**
 * Input for fetching recent Slack messages
 */
export interface FetchRecentSlackMessagesInput {
	/** The project to fetch Slack messages for */
	projectId: string;
	/** User ID for OAuth credentials */
	userId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** Maximum number of messages to return (default: 10) */
	limit?: number;
}

/**
 * Result of fetching recent Slack messages
 */
export interface FetchRecentSlackMessagesResult {
	/** Formatted messages ready to add to contexts[] */
	formattedContexts: string[];
	/** Number of messages fetched */
	messageCount: number;
	/** Names of channels that were fetched from */
	fetchedChannels: string[];
	/** Any errors encountered (non-fatal) */
	errors: string[];
}

/**
 * Fetch recent Slack messages for a project.
 *
 * Unlike searchProjectSlackMessages (which requires a query), this fetches the
 * last N messages chronologically. Used to provide Slack context to BOTH
 * workflow paths (iterative and non-iterative), ensuring custom prompt users
 * also get Slack context.
 *
 * This is called in the document generation workflow to provide Slack context.
 */
export async function fetchRecentSlackMessages(
	input: FetchRecentSlackMessagesInput,
): Promise<FetchRecentSlackMessagesResult> {
	const { projectId, userId, organizationId, limit = 10 } = input;
	const errors: string[] = [];
	const fetchedChannels: string[] = [];

	console.log(
		`[FetchRecentSlackMessages] Fetching recent messages for project ${projectId}`,
	);

	// Fetch INTEGRATION type contexts for this project
	const integrationContexts = await db.projectContext.findMany({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
		},
		select: {
			id: true,
			metadata: true,
		},
	});

	if (integrationContexts.length === 0) {
		console.log(
			"[FetchRecentSlackMessages] No Slack contexts configured for this project",
		);
		return {
			formattedContexts: [],
			messageCount: 0,
			fetchedChannels: [],
			errors: [],
		};
	}

	const slackContexts = parseSlackContexts(integrationContexts);

	if (slackContexts.length === 0) {
		return {
			formattedContexts: [],
			messageCount: 0,
			fetchedChannels: [],
			errors: [],
		};
	}

	console.log(
		`[FetchRecentSlackMessages] Fetching from ${slackContexts.length} Slack channels`,
	);

	interface SlackMessage {
		content: string;
		from: string;
		createdAt?: string;
		channelName: string;
	}

	const allMessages: SlackMessage[] = [];

	// Distribute limit across channels
	const messagesPerChannel = Math.ceil(limit / slackContexts.length);

	for (const ctx of slackContexts) {
		try {
			const result = (await executeSlackTool(
				"get_channel_messages",
				{
					channelId: ctx.channelId,
					channelName: ctx.channelName,
					limit: messagesPerChannel,
				},
				userId,
				organizationId,
			)) as {
				messages: Array<{
					id: string;
					content: string;
					from: string;
					createdAt?: string;
				}>;
				count: number;
			};

			for (const msg of result.messages || []) {
				if (msg.content && msg.content.trim().length > 0) {
					allMessages.push({
						content: msg.content,
						from: msg.from,
						createdAt: msg.createdAt,
						channelName: ctx.channelName,
					});
				}
			}

			fetchedChannels.push(ctx.channelName);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			console.error(
				`[FetchRecentSlackMessages] Error fetching from ${ctx.channelName}:`,
				errorMessage,
			);
			errors.push(
				`Failed to fetch from ${ctx.channelName}: ${errorMessage}`,
			);
		}
	}

	if (allMessages.length === 0) {
		console.log("[FetchRecentSlackMessages] No messages found");
		return {
			formattedContexts: [],
			messageCount: 0,
			fetchedChannels,
			errors,
		};
	}

	// Sort by createdAt (most recent first) and limit
	allMessages.sort((a, b) => {
		if (!a.createdAt || !b.createdAt) {
			return 0;
		}
		return (
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		);
	});

	const limitedMessages = allMessages.slice(0, limit);

	// Format messages for context
	const formattedContexts: string[] = [];

	const messageLines: string[] = [
		"## Recent Slack Discussions\n",
		"The following are recent messages from Slack channels linked to this project:\n",
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

		messageLines.push(`[#${msg.channelName} - ${timestamp}]`);
		messageLines.push(`From: ${msg.from}`);
		messageLines.push(`${msg.content}\n`);
	}

	formattedContexts.push(messageLines.join("\n"));

	console.log(
		`[FetchRecentSlackMessages] Formatted ${limitedMessages.length} messages from ${fetchedChannels.length} channels`,
	);

	return {
		formattedContexts,
		messageCount: limitedMessages.length,
		fetchedChannels,
		errors,
	};
}
