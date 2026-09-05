/**
 * Tool Node for Project Document Generator
 *
 * Handles server-side tool execution for the multi-node graph.
 * Supports Teams tools that call internal API endpoints:
 * - search_teams_messages: KQL-powered search across project Teams chats
 * - get_chat_messages: Get recent messages from a specific linked chat
 * - get_full_message: Get untruncated content of a specific message
 * - list_message_replies: Get threaded replies under a channel message
 *
 * Pattern: Same as data-analyst agent's tool node using ToolNode from
 * @langchain/langgraph/prebuilt with DynamicStructuredTool.
 */

import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG } from "@repo/agent-core/recursion";
import { logger } from "@repo/logs";
import { z } from "zod/v4";
import type { AgentState } from "../state";

// Mirrors packages/integrations/src/microsoft/config/limits.ts. Duplicated here
// because the agent bundle can't pull @repo/integrations (would inline the whole
// Graph client). Keep these three values in sync with the server-side source.
const TEAMS_TOOL_LIMITS = {
	EXCERPTS_PER_PASS: 8,
	MAX_EXCERPTS_MERGED: 16,
	MAX_CHARS_PER_EXCERPT: 400,
	FULL_MESSAGE_MAX_CHARS: 10_000,
} as const;

interface ExtractedExcerpt {
	messageId: string;
	from: string | null;
	createdAt: string | null;
	webLink: string | null;
	excerpt: string;
	relevance: number | null;
	chatId?: string | null;
	teamId?: string | null;
	channelId?: string | null;
	chatName?: string | null;
}

function formatExcerpts(excerpts: ExtractedExcerpt[]): string {
	return excerpts
		.map((e) => {
			const meta = [
				`messageId: ${e.messageId}`,
				e.chatId ? `chatId: ${e.chatId}` : undefined,
				e.teamId ? `teamId: ${e.teamId}` : undefined,
				e.channelId ? `channelId: ${e.channelId}` : undefined,
				e.webLink ? `link: ${e.webLink}` : undefined,
				e.relevance !== null
					? `relevance: ${e.relevance.toFixed(2)}`
					: undefined,
			]
				.filter(Boolean)
				.join(", ");
			const who = e.chatName
				? `${e.from || "Unknown"} in ${e.chatName}`
				: e.from || "Unknown";
			return `[${meta}] **${who}** (${e.createdAt || "unknown time"}): ${e.excerpt}`;
		})
		.join("\n\n");
}

interface SlackLineParts {
	messageId?: string;
	channelId?: string;
	channelName?: string;
	threadTs?: string;
	replyCount?: number;
	from: string;
	createdAt?: string;
	permalink?: string;
	content: string;
}

function formatSlackMessageLine(p: SlackLineParts): string {
	const meta: string[] = [];
	if (p.messageId) {
		meta.push(`messageId: ${p.messageId}`);
	}
	if (p.channelId) {
		meta.push(`channelId: ${p.channelId}`);
	}
	if (p.threadTs) {
		meta.push(`threadTs: ${p.threadTs}`);
	}
	if (typeof p.replyCount === "number" && p.replyCount > 0) {
		meta.push(`replies: ${p.replyCount}`);
	}
	const metaPrefix = meta.length ? `[${meta.join(", ")}] ` : "";
	const channelPart = p.channelName ? ` in #${p.channelName}` : "";
	const linkSuffix = p.permalink ? ` <${p.permalink}>` : "";
	return `${metaPrefix}**${p.from}**${channelPart} (${p.createdAt || "unknown time"})${linkSuffix}: ${p.content}`;
}

/** Resolve the internal API base URL */
function getApiUrl(): string {
	return (
		process.env.RUNTIME_API_URL ||
		process.env.FABRIC_API_URL ||
		process.env.NEXT_PUBLIC_SITE_URL ||
		"http://localhost:3001"
	);
}

/**
 * A 401 from an internal API almost always means the run's AI token expired
 * mid-generation (a long model call outliving the token TTL), not a
 * transient failure — so it's logged at error and the model is told to stop
 * retrying instead of silently continuing without the tool's context.
 */
function internalApiFailure(tool: string, status: number): string {
	logger.error(
		`[ToolNode] ${tool} auth failed (401) — AI token likely expired mid-run`,
		{ status },
	);
	return `Authentication to ${tool} expired mid-run. Do not retry this tool; finish with the context already gathered.`;
}

/**
 * Helper to call the generic /api/internal/teams-tools endpoint.
 * Returns the raw JSON response or an error string.
 */
async function callTeamsTool(
	toolName: string,
	args: Record<string, unknown>,
	state: AgentState,
	aiToken?: string,
): Promise<unknown> {
	const { projectId, userId } = state;

	if (!projectId || !userId) {
		logger.warn(`[ToolNode] Missing projectId or userId for ${toolName}`, {
			projectId,
			userId,
		});
		return `${toolName} skipped: missing project or user context.`;
	}

	const apiUrl = getApiUrl();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (aiToken) {
		headers["X-AI-Token"] = aiToken;
	}

	const response = await fetch(`${apiUrl}/api/internal/teams-tools`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			toolName,
			args,
			projectId,
		}),
	});

	if (!response.ok) {
		if (response.status === 401) {
			return internalApiFailure(toolName, response.status);
		}
		logger.warn(`[ToolNode] ${toolName} API returned error`, {
			status: response.status,
		});
		return `${toolName} failed (${response.status}). Continuing without this context.`;
	}

	return await response.json();
}

/**
 * Create the search_teams_messages tool for server-side execution.
 *
 * This tool calls the internal Teams search API endpoint, which reuses
 * the existing searchProjectTeamsMessages activity logic.
 */
function createSearchTeamsMessagesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	const apiUrl = getApiUrl();

	return new DynamicStructuredTool({
		name: "search_teams_messages",
		description: `Search for messages in Microsoft Teams chats that are linked to this project.
Use this tool when you need to find relevant context from team discussions, decisions, or conversations.
The search will only look in chats that have been configured for this project.

Returns up to ~${TEAMS_TOOL_LIMITS.MAX_EXCERPTS_MERGED} relevance-ranked excerpts (each ≤ ${TEAMS_TOOL_LIMITS.MAX_CHARS_PER_EXCERPT} chars) filtered against
the user's active stage prompt. Each excerpt includes messageId, from, createdAt,
and webLink. If an excerpt looks promising and you need the full message, call
get_full_message with that messageId (capped at ${TEAMS_TOOL_LIMITS.FULL_MESSAGE_MAX_CHARS / 1000}KB).

Supply 'alternateQuery' when the topic has obvious synonyms or the stage prompt
points to a different phrasing than your literal keywords — the server runs both
queries in parallel and merges the deduplicated excerpts.

Examples of when to use:
- "Search for discussions about authentication requirements"
- "Find messages mentioning the API design"
- "Look for any decisions made about the database schema"

Tips for effective searches:
- Use specific keywords related to the document you're generating
- Search for topics, features, or technical terms mentioned in discussions`,
		schema: z.object({
			query: z
				.string()
				.describe(
					"Primary search query — keywords, phrases, or topics",
				),
			alternateQuery: z
				.string()
				.optional()
				.describe(
					"Optional second search query. Supply when the topic has common synonyms, a different phrasing in the stage prompt, or two distinct facets worth searching separately. The server runs both queries in parallel and merges the deduplicated excerpt list.",
				),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of raw Graph messages per pass before relevance filtering (default: 15, max: 50)",
				),
		}),
		func: async ({ query, alternateQuery, limit = 15 }) => {
			const { projectId, userId, organizationId, systemPrompt } = state;

			if (!projectId || !userId) {
				logger.warn(
					"[ToolNode] Missing projectId or userId for Teams search",
					{ projectId, userId },
				);
				return "Teams search skipped: missing project or user context.";
			}

			const clampedLimit = Math.min(Math.max(1, limit), 50);

			logger.info("[ToolNode] Executing search_teams_messages", {
				projectId,
				query,
				alternateQuery: alternateQuery || null,
				hasStagePrompt: !!systemPrompt,
				limit: clampedLimit,
			});

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (aiToken) {
					headers["X-AI-Token"] = aiToken;
				}

				const response = await fetch(
					`${apiUrl}/api/internal/teams-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							projectId,
							query,
							alternateQuery,
							stagePrompt: systemPrompt,
							userId,
							organizationId,
							limit: clampedLimit,
						}),
					},
				);

				if (!response.ok) {
					if (response.status === 401) {
						return internalApiFailure(
							"search_teams_messages",
							response.status,
						);
					}
					logger.warn("[ToolNode] Teams search API returned error", {
						status: response.status,
					});
					return `Teams search failed (${response.status}). Continuing without Teams context.`;
				}

				const result = (await response.json()) as {
					excerpts?: ExtractedExcerpt[];
					messages?: Array<{
						id: string;
						from: string;
						createdAt?: string;
						content: string;
						chatId?: string;
						teamId?: string;
						channelId?: string;
					}>;
					twoPass?: boolean;
				};

				if (result.excerpts && result.excerpts.length > 0) {
					logger.info("[ToolNode] Teams search returned excerpts", {
						excerptCount: result.excerpts.length,
						twoPass: !!result.twoPass,
						query,
					});
					return formatExcerpts(result.excerpts);
				}

				if (!result.messages || result.messages.length === 0) {
					return `No Teams messages found for "${query}".`;
				}

				logger.info(
					"[ToolNode] Teams search returned legacy messages",
					{
						messageCount: result.messages.length,
						query,
					},
				);

				return result.messages
					.map(
						(m) =>
							`[messageId: ${m.id}${m.chatId ? `, chatId: ${m.chatId}` : ""}${m.teamId ? `, teamId: ${m.teamId}` : ""}${m.channelId ? `, channelId: ${m.channelId}` : ""}] **${m.from}** (${m.createdAt || "unknown time"}): ${m.content}`,
					)
					.join("\n\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] Teams search failed", {
					error: errorMessage,
				});
				return `Teams search encountered an error: ${errorMessage}. Continuing without Teams context.`;
			}
		},
	});
}

/**
 * Create the get_chat_messages tool.
 *
 * Fetches recent messages from a specific Teams chat linked to the project.
 * Useful when the agent wants to browse a particular chat rather than search.
 */
function createGetChatMessagesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "get_chat_messages",
		description: `Get recent messages from a specific Microsoft Teams chat linked to this project.
Use this when you want to browse recent messages in a particular chat rather than search by keywords.
You need the chatId which you can find from search results or from the project's linked chats.

If you supply 'query', the response is a bounded set of relevance-ranked excerpts
(≤ ${TEAMS_TOOL_LIMITS.EXCERPTS_PER_PASS} per call, ≤ ${TEAMS_TOOL_LIMITS.MAX_CHARS_PER_EXCERPT} chars each) filtered against the active stage prompt — use
get_full_message on an excerpt's messageId for the full text. If you omit 'query',
the response is the raw recent messages (each pre-truncated to ~500 chars).`,
		schema: z.object({
			chatId: z
				.string()
				.describe("The Teams chat ID to fetch messages from"),
			query: z
				.string()
				.optional()
				.describe(
					"Optional relevance query. When provided, the response is a compact list of excerpts filtered to what matters for this topic + the active stage prompt. Prefer this over raw recent messages unless you explicitly need chronological browsing.",
				),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of messages to return (default: 20, max: 50)",
				),
		}),
		func: async ({ chatId, query, limit = 20 }) => {
			logger.info("[ToolNode] Executing get_chat_messages", {
				chatId,
				query: query || null,
				hasStagePrompt: !!state.systemPrompt,
				limit,
			});

			try {
				const clampedLimit = Math.min(Math.max(1, limit), 50);
				const result = (await callTeamsTool(
					"get_chat_messages",
					{
						chatId,
						limit: clampedLimit,
						...(query ? { query } : {}),
						...(state.systemPrompt
							? { stagePrompt: state.systemPrompt }
							: {}),
					},
					state,
					aiToken,
				)) as
					| string
					| {
							mode?: string;
							excerpts?: ExtractedExcerpt[];
							messages?: Array<{
								id: string;
								from: string;
								createdAt?: string;
								content: string;
							}>;
							count?: number;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (result.excerpts && result.excerpts.length > 0) {
					logger.info(
						"[ToolNode] get_chat_messages returned excerpts",
						{ excerptCount: result.excerpts.length },
					);
					return formatExcerpts(result.excerpts);
				}

				if (!result.messages || result.messages.length === 0) {
					return "No messages found in this chat.";
				}

				logger.info("[ToolNode] get_chat_messages returned results", {
					messageCount: result.messages.length,
				});

				return result.messages
					.map(
						(m) =>
							`[messageId: ${m.id}] **${m.from}** (${m.createdAt || "unknown time"}): ${m.content}`,
					)
					.join("\n\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] get_chat_messages failed", {
					error: errorMessage,
				});
				return `Failed to get chat messages: ${errorMessage}`;
			}
		},
	});
}

/**
 * Create the list_linked_chats tool.
 *
 * Returns all Microsoft Teams chats/channels linked to this project.
 * The agent uses this to discover chatIds before calling get_chat_messages.
 */
function createListLinkedChatsTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "list_linked_chats",
		description: `List all Microsoft Teams chats and channels linked to this project.
Returns chat IDs, names, and types so you can then use get_chat_messages to fetch recent messages.
Use this FIRST when the user asks about recent/latest Teams messages, before calling get_chat_messages.`,
		schema: z.object({}),
		func: async () => {
			logger.info("[ToolNode] Executing list_linked_chats", {
				projectId: state.projectId,
			});

			try {
				const result = (await callTeamsTool(
					"list_linked_chats",
					{},
					state,
					aiToken,
				)) as
					| string
					| {
							chats?: Array<{
								chatId?: string;
								chatType?: string;
								chatTopic?: string;
								teamId?: string;
								channelId?: string;
								channelName?: string;
								teamName?: string;
							}>;
							count?: number;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (!result.chats || result.chats.length === 0) {
					return "No Teams chats or channels are linked to this project.";
				}

				logger.info("[ToolNode] list_linked_chats returned results", {
					chatCount: result.chats.length,
				});

				return result.chats
					.map((chat) => {
						if (chat.chatId) {
							return `- **${chat.chatTopic || "Group Chat"}** (type: ${chat.chatType || "group"}, chatId: ${chat.chatId})`;
						}
						return `- **${chat.channelName || "Channel"}** in ${chat.teamName || "Team"} (teamId: ${chat.teamId}, channelId: ${chat.channelId})`;
					})
					.join("\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] list_linked_chats failed", {
					error: errorMessage,
				});
				return `Failed to list linked chats: ${errorMessage}`;
			}
		},
	});
}

/**
 * Create the get_teams_channel_messages tool.
 *
 * Fetches recent messages from a Teams channel linked to the project.
 * Uses the list_messages Graph API method with teamId/channelId.
 */
function createGetTeamsChannelMessagesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "get_teams_channel_messages",
		description: `Get recent messages from a Microsoft Teams channel linked to this project.
Use this when you want to browse recent messages in a channel. Requires teamId and channelId from list_linked_chats.
For group chats (which have a chatId), use get_chat_messages instead.

If you supply 'query', the response is a bounded set of relevance-ranked excerpts
(≤ ${TEAMS_TOOL_LIMITS.EXCERPTS_PER_PASS} per call, ≤ ${TEAMS_TOOL_LIMITS.MAX_CHARS_PER_EXCERPT} chars each) filtered against the active stage prompt — use
get_full_message on an excerpt's messageId for the full text. If you omit 'query',
the response is the raw recent messages (each pre-truncated to ~500 chars).`,
		schema: z.object({
			teamId: z.string().describe("The Team ID from list_linked_chats"),
			channelId: z
				.string()
				.describe("The Channel ID from list_linked_chats"),
			query: z
				.string()
				.optional()
				.describe(
					"Optional relevance query. When provided, the response is a compact list of excerpts filtered to what matters for this topic + the active stage prompt.",
				),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of messages to return (default: 20, max: 50)",
				),
		}),
		func: async ({ teamId, channelId, query, limit = 20 }) => {
			logger.info("[ToolNode] Executing get_teams_channel_messages", {
				teamId,
				channelId,
				query: query || null,
				hasStagePrompt: !!state.systemPrompt,
				limit,
			});

			try {
				const clampedLimit = Math.min(Math.max(1, limit), 50);
				const result = (await callTeamsTool(
					"list_messages",
					{
						teamId,
						channelId,
						limit: clampedLimit,
						...(query ? { query } : {}),
						...(state.systemPrompt
							? { stagePrompt: state.systemPrompt }
							: {}),
					},
					state,
					aiToken,
				)) as
					| string
					| {
							mode?: string;
							excerpts?: ExtractedExcerpt[];
							messages?: Array<{
								id: string;
								from: string;
								createdAt?: string;
								content: string;
							}>;
							count?: number;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (result.excerpts && result.excerpts.length > 0) {
					logger.info(
						"[ToolNode] get_teams_channel_messages returned excerpts",
						{ excerptCount: result.excerpts.length },
					);
					return formatExcerpts(result.excerpts);
				}

				if (!result.messages || result.messages.length === 0) {
					return "No messages found in this channel.";
				}

				logger.info(
					"[ToolNode] get_teams_channel_messages returned results",
					{
						messageCount: result.messages.length,
					},
				);

				return result.messages
					.map(
						(m) =>
							`[messageId: ${m.id}] **${m.from}** (${m.createdAt || "unknown time"}): ${m.content}`,
					)
					.join("\n\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] get_teams_channel_messages failed", {
					error: errorMessage,
				});
				return `Failed to get channel messages: ${errorMessage}`;
			}
		},
	});
}

/**
 * Create the get_full_message tool.
 *
 * Gets the complete, untruncated content of a specific Teams message.
 * Search results may return truncated content — use this to get the full text.
 */
function createGetFullMessageTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "get_full_message",
		description: `Get the full content of a specific Microsoft Teams message (capped at 10KB).
Use this when search results or excerpts show a promising messageId and you need the
complete text beyond the 400-char excerpt. If the message is longer than 10KB the
response is truncated at that boundary — for embedded images call get_message_hosted_content.
Requires the messageId and either a chatId (for group chats) or teamId+channelId (for channels).`,
		schema: z.object({
			messageId: z.string().describe("The ID of the message to retrieve"),
			chatId: z
				.string()
				.optional()
				.describe("Chat ID if the message is from a group chat"),
			teamId: z
				.string()
				.optional()
				.describe("Team ID if the message is from a channel"),
			channelId: z
				.string()
				.optional()
				.describe("Channel ID if the message is from a channel"),
		}),
		func: async ({ messageId, chatId, teamId, channelId }) => {
			logger.info("[ToolNode] Executing get_full_message", {
				messageId,
				chatId,
				teamId,
				channelId,
			});

			if (!chatId && !(teamId && channelId)) {
				return "Error: You must provide either chatId (for group chat messages) or both teamId and channelId (for channel messages). Get these from search_teams_messages, get_chat_messages, or list_linked_chats results.";
			}

			try {
				const args: Record<string, unknown> = { messageId };
				if (chatId) {
					args.chatId = chatId;
				}
				if (teamId) {
					args.teamId = teamId;
				}
				if (channelId) {
					args.channelId = channelId;
				}

				const result = (await callTeamsTool(
					"get_full_message",
					args,
					state,
					aiToken,
				)) as
					| string
					| {
							content?: string;
							from?: string;
							createdAt?: string;
							importance?: string;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (!result.content) {
					return "Message content not found or empty.";
				}

				const parts: string[] = [];
				if (result.from) {
					parts.push(`**From:** ${result.from}`);
				}
				if (result.createdAt) {
					parts.push(`**Date:** ${result.createdAt}`);
				}
				if (result.importance && result.importance !== "normal") {
					parts.push(`**Importance:** ${result.importance}`);
				}
				parts.push(`\n${result.content}`);

				return parts.join("\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] get_full_message failed", {
					error: errorMessage,
				});
				return `Failed to get full message: ${errorMessage}`;
			}
		},
	});
}

/**
 * Create the list_message_replies tool.
 *
 * Gets reply messages (thread) for a channel message.
 * Useful for following threaded discussions about specific topics.
 */
function createListMessageRepliesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "list_message_replies",
		description: `Get replies in a thread under a specific Microsoft Teams channel message.
Use this to follow threaded discussions when you find a relevant message in a channel.
Requires teamId, channelId, and the parent messageId.

If you supply 'query', the response is a bounded set of relevance-ranked excerpts
(≤ 8 per call, ≤ 400 chars each) filtered against the active stage prompt — use
get_full_message on an excerpt's messageId for the full text. If you omit 'query',
the response is the raw replies (each pre-truncated to ~500 chars).`,
		schema: z.object({
			teamId: z.string().describe("The Team ID"),
			channelId: z.string().describe("The Channel ID"),
			messageId: z
				.string()
				.describe("The parent message ID to get replies for"),
			query: z
				.string()
				.optional()
				.describe(
					"Optional relevance query. When provided, the response is a compact list of excerpts filtered to what matters for this topic + the active stage prompt.",
				),
			limit: z
				.number()
				.optional()
				.describe("Maximum number of replies to return (default: 25)"),
		}),
		func: async ({ teamId, channelId, messageId, query, limit = 25 }) => {
			logger.info("[ToolNode] Executing list_message_replies", {
				teamId,
				channelId,
				messageId,
				query: query || null,
				hasStagePrompt: !!state.systemPrompt,
				limit,
			});

			try {
				const result = (await callTeamsTool(
					"list_message_replies",
					{
						teamId,
						channelId,
						messageId,
						limit,
						...(query ? { query } : {}),
						...(state.systemPrompt
							? { stagePrompt: state.systemPrompt }
							: {}),
					},
					state,
					aiToken,
				)) as
					| string
					| {
							mode?: string;
							excerpts?: ExtractedExcerpt[];
							replies?: Array<{
								from: string;
								createdAt?: string;
								content: string;
							}>;
							count?: number;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (result.excerpts && result.excerpts.length > 0) {
					logger.info(
						"[ToolNode] list_message_replies returned excerpts",
						{ excerptCount: result.excerpts.length },
					);
					return formatExcerpts(result.excerpts);
				}

				if (!result.replies || result.replies.length === 0) {
					return "No replies found for this message.";
				}

				logger.info(
					"[ToolNode] list_message_replies returned results",
					{
						replyCount: result.replies.length,
					},
				);

				return result.replies
					.map(
						(m) =>
							`**${m.from}** (${m.createdAt || "unknown time"}): ${m.content}`,
					)
					.join("\n\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] list_message_replies failed", {
					error: errorMessage,
				});
				return `Failed to get message replies: ${errorMessage}`;
			}
		},
	});
}

/**
 * Create the get_message_hosted_content tool.
 *
 * Fetches images (hosted content) from a Teams message and returns them as base64.
 * The LLM can then describe or reference the image content.
 */
function createGetMessageHostedContentTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "get_message_hosted_content",
		description: `Get images and hosted content from a Microsoft Teams message.
Use this when a message contains images (e.g., screenshots, diagrams) and you need to see them.
Returns base64-encoded image data that you can analyze.
Requires the messageId and either a chatId (for group chats) or teamId+channelId (for channels).`,
		schema: z.object({
			messageId: z
				.string()
				.describe("The ID of the message containing images"),
			chatId: z
				.string()
				.optional()
				.describe("Chat ID if the message is from a group chat"),
			teamId: z
				.string()
				.optional()
				.describe("Team ID if the message is from a channel"),
			channelId: z
				.string()
				.optional()
				.describe("Channel ID if the message is from a channel"),
		}),
		func: async ({ messageId, chatId, teamId, channelId }) => {
			logger.info("[ToolNode] Executing get_message_hosted_content", {
				messageId,
				chatId,
				teamId,
				channelId,
			});

			if (!chatId && !(teamId && channelId)) {
				return "Error: You must provide either chatId (for group chat messages) or both teamId and channelId (for channel messages). Get these from search_teams_messages, get_chat_messages, or list_linked_chats results.";
			}

			try {
				const args: Record<string, unknown> = { messageId };
				if (chatId) {
					args.chatId = chatId;
				}
				if (teamId) {
					args.teamId = teamId;
				}
				if (channelId) {
					args.channelId = channelId;
				}

				const result = (await callTeamsTool(
					"get_message_hosted_content",
					args,
					state,
					aiToken,
				)) as
					| string
					| {
							images?: Array<{
								id: string;
								contentType: string;
								base64: string;
							}>;
							count?: number;
							message?: string;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (!result.images || result.images.length === 0) {
					return result.message || "No images found in this message.";
				}

				// Return JSON with the __images marker so toolNode can split it
				// into a text-only ToolMessage (satisfying this tool_call) plus
				// a synthetic HumanMessage carrying the image_url parts —
				// image parts are not valid inside a tool-role message.
				return JSON.stringify({
					__images: true,
					text: `Found ${result.images.length} image(s) in this message.`,
					images: result.images
						.filter((img: { base64: string }) => img.base64)
						.map(
							(img: {
								id: string;
								contentType: string;
								base64: string;
							}) => ({
								id: img.id,
								contentType: img.contentType,
								base64: img.base64,
							}),
						),
					skipped: result.images.filter(
						(img: { base64: string }) => !img.base64,
					).length,
				});
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] get_message_hosted_content failed", {
					error: errorMessage,
				});
				return `Failed to get message images: ${errorMessage}`;
			}
		},
	});
}

/**
 * Helper to call the generic /api/internal/slack-tools endpoint.
 * Returns the raw JSON response or an error string.
 */
async function callSlackTool(
	toolName: string,
	args: Record<string, unknown>,
	state: AgentState,
	aiToken?: string,
): Promise<unknown> {
	const { projectId, userId } = state;

	if (!projectId || !userId) {
		logger.warn(`[ToolNode] Missing projectId or userId for ${toolName}`, {
			projectId,
			userId,
		});
		return `${toolName} skipped: missing project or user context.`;
	}

	const apiUrl = getApiUrl();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (aiToken) {
		headers["X-AI-Token"] = aiToken;
	}

	const response = await fetch(`${apiUrl}/api/internal/slack-tools`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			toolName,
			args,
			projectId,
		}),
	});

	if (!response.ok) {
		if (response.status === 401) {
			return internalApiFailure(toolName, response.status);
		}
		logger.warn(`[ToolNode] ${toolName} API returned error`, {
			status: response.status,
		});
		return `${toolName} failed (${response.status}). Continuing without this context.`;
	}

	return await response.json();
}

/**
 * Create the list_linked_channels tool for Slack.
 *
 * Returns all Slack channels linked to this project.
 * The agent uses this to discover channelIds before calling get_channel_messages.
 */
function createListLinkedChannelsTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "list_linked_channels",
		description: `List all Slack channels linked to this project.
Returns channel IDs and names so you can then use get_channel_messages to fetch recent messages.
Use this FIRST when the user asks about recent/latest Slack messages, before calling get_channel_messages.`,
		schema: z.object({}),
		func: async () => {
			logger.info("[ToolNode] Executing list_linked_channels", {
				projectId: state.projectId,
			});

			try {
				const result = (await callSlackTool(
					"list_linked_channels",
					{},
					state,
					aiToken,
				)) as
					| string
					| {
							channels?: Array<{
								channelId?: string;
								channelName?: string;
							}>;
							count?: number;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (!result.channels || result.channels.length === 0) {
					return "No Slack channels are linked to this project.";
				}

				logger.info(
					"[ToolNode] list_linked_channels returned results",
					{
						channelCount: result.channels.length,
					},
				);

				return result.channels
					.map(
						(ch) =>
							`- **#${ch.channelName || "unknown"}** (channelId: ${ch.channelId})`,
					)
					.join("\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] list_linked_channels failed", {
					error: errorMessage,
				});
				return `Failed to list linked channels: ${errorMessage}`;
			}
		},
	});
}

/**
 * Create the search_slack_messages tool for server-side execution.
 *
 * This tool calls the internal Slack search API endpoint, which reuses
 * the existing searchProjectSlackMessages activity logic.
 */
function createSearchSlackMessagesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	const apiUrl = getApiUrl();

	return new DynamicStructuredTool({
		name: "search_slack_messages",
		description: `Search for messages in Slack channels that are linked to this project.
Use this tool when you need to find relevant context from Slack discussions, decisions, or conversations.
The search will only look in channels that have been configured for this project.

Each result includes channelName, createdAt, content, and (when present) a clickable Slack permalink
plus a threadTs — pass that threadTs to get_thread_replies if the discussion continued in a thread.

The query is passed verbatim to Slack's search.messages API, so you can combine free text with
Slack's native search modifiers to filter server-side:
- from:@user — messages by a specific person (e.g. "deploy plan from:@alice")
- in:#channel — restrict to one channel even if multiple are linked (e.g. "outage in:#incidents")
- before:YYYY-MM-DD / after:YYYY-MM-DD — date filtering (e.g. "rollback after:2026-04-01")
- has:link / has:file — only messages containing a link or file attachment

Examples of when to use:
- "Search for discussions about authentication requirements"
- "Find messages mentioning the API design"
- "Look for decisions about the database schema after:2026-03-01"
- "Find files shared by alice — alice has:file"

Tips for effective searches:
- Combine modifiers — e.g. "from:@bob has:link before:2026-05-01"
- For a follow-up on a single thread, prefer get_thread_replies once you have a threadTs
- Quote phrases for exact-match: "rollout plan"`,
		schema: z.object({
			query: z
				.string()
				.describe(
					"Search query - can include keywords, phrases, or topics",
				),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of messages to return (default: 15, max: 50)",
				),
		}),
		func: async ({ query, limit = 15 }) => {
			const { projectId, userId, organizationId } = state;

			if (!projectId || !userId) {
				logger.warn(
					"[ToolNode] Missing projectId or userId for Slack search",
					{ projectId, userId },
				);
				return "Slack search skipped: missing project or user context.";
			}

			const clampedLimit = Math.min(Math.max(1, limit), 50);

			logger.info("[ToolNode] Executing search_slack_messages", {
				projectId,
				query,
				limit: clampedLimit,
			});

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (aiToken) {
					headers["X-AI-Token"] = aiToken;
				}

				const response = await fetch(
					`${apiUrl}/api/internal/slack-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							projectId,
							query,
							userId,
							organizationId,
							limit: clampedLimit,
						}),
					},
				);

				if (!response.ok) {
					if (response.status === 401) {
						return internalApiFailure(
							"search_slack_messages",
							response.status,
						);
					}
					logger.warn("[ToolNode] Slack search API returned error", {
						status: response.status,
					});
					return `Slack search failed (${response.status}). Continuing without Slack context.`;
				}

				const result = (await response.json()) as {
					messages?: Array<{
						id?: string;
						from: string;
						createdAt?: string;
						content: string;
						channelId?: string;
						channelName?: string;
						threadTs?: string;
						permalink?: string;
					}>;
				};

				if (!result.messages || result.messages.length === 0) {
					return `No Slack messages found for "${query}".`;
				}

				logger.info("[ToolNode] Slack search returned results", {
					messageCount: result.messages.length,
					query,
				});

				return result.messages
					.map((m) =>
						formatSlackMessageLine({
							messageId: m.id,
							channelId: m.channelId,
							channelName: m.channelName || "unknown",
							threadTs: m.threadTs,
							from: m.from,
							createdAt: m.createdAt,
							permalink: m.permalink,
							content: m.content,
						}),
					)
					.join("\n\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] Slack search failed", {
					error: errorMessage,
				});
				return `Slack search encountered an error: ${errorMessage}. Continuing without Slack context.`;
			}
		},
	});
}

/**
 * Create the get_channel_messages tool.
 *
 * Fetches recent messages from a specific Slack channel linked to the project.
 * Useful when the agent wants to browse a particular channel rather than search.
 */
function createGetChannelMessagesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "get_channel_messages",
		description: `Get recent messages from a specific Slack channel linked to this project.
Use this when you want to browse recent messages in a particular channel rather than search by keywords.
You need the channelId, which you can find from list_linked_channels or from a search_slack_messages result.

Prefer search_slack_messages when you're looking for a specific topic — it supports modifiers like
from:@user, in:#channel, before:/after: dates, and has:link/has:file. Use get_channel_messages for
chronological browsing of "what's new in this channel" with no particular topic in mind.

Each message includes a threadTs when it participates in a thread; call get_thread_replies with
the channelId + threadTs to drill into the discussion.`,
		schema: z.object({
			channelId: z
				.string()
				.describe("The Slack channel ID to fetch messages from"),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of messages to return (default: 20, max: 50)",
				),
		}),
		func: async ({ channelId, limit = 20 }) => {
			logger.info("[ToolNode] Executing get_channel_messages", {
				channelId,
				limit,
			});

			try {
				const clampedLimit = Math.min(Math.max(1, limit), 50);
				const result = (await callSlackTool(
					"get_channel_messages",
					{ channel: channelId, channelId, limit: clampedLimit },
					state,
					aiToken,
				)) as
					| string
					| {
							messages?: Array<{
								id?: string;
								from: string;
								createdAt?: string;
								content: string;
								threadTs?: string;
								replyCount?: number;
							}>;
							count?: number;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (!result.messages || result.messages.length === 0) {
					return "No messages found in this channel.";
				}

				logger.info(
					"[ToolNode] get_channel_messages returned results",
					{
						messageCount: result.messages.length,
					},
				);

				return result.messages
					.map((m) =>
						formatSlackMessageLine({
							messageId: m.id,
							threadTs: m.threadTs,
							replyCount: m.replyCount,
							from: m.from,
							createdAt: m.createdAt,
							content: m.content,
						}),
					)
					.join("\n\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] get_channel_messages failed", {
					error: errorMessage,
				});
				return `Failed to get channel messages: ${errorMessage}`;
			}
		},
	});
}

// threadTs values are discovered from prior search_slack_messages results
// (search excerpts include threadTs only when the matched message is in a thread).
function createGetSlackThreadRepliesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "get_thread_replies",
		description: `Get replies under a Slack message thread linked to this project.
Use this AFTER search_slack_messages returns an excerpt with a threadTs — Slack discussions and
decisions frequently live in threads, not top-level messages, so reading only the parent often
misses the substance. Pass channelId + threadTs from the search result.`,
		schema: z.object({
			channelId: z
				.string()
				.describe("The Slack channel ID containing the thread"),
			threadTs: z
				.string()
				.describe(
					"The parent message timestamp (thread_ts) — from a search_slack_messages excerpt",
				),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of replies to return (default: 50, max: 200)",
				),
		}),
		func: async ({ channelId, threadTs, limit = 50 }) => {
			logger.info("[ToolNode] Executing get_thread_replies", {
				channelId,
				threadTs,
				limit,
			});

			try {
				const clampedLimit = Math.min(Math.max(1, limit), 200);
				const result = (await callSlackTool(
					"get_thread_replies",
					{
						channel: channelId,
						channelId,
						threadTs,
						limit: clampedLimit,
					},
					state,
					aiToken,
				)) as
					| string
					| {
							messages?: Array<{
								id: string;
								from: string;
								createdAt?: string;
								content: string;
							}>;
							count?: number;
							hasMore?: boolean;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (!result.messages || result.messages.length === 0) {
					return "No replies found in this thread.";
				}

				logger.info("[ToolNode] get_thread_replies returned results", {
					messageCount: result.messages.length,
					hasMore: !!result.hasMore,
				});

				const moreSuffix = result.hasMore
					? "\n\n_(more replies exist — re-call with a higher limit to fetch them)_"
					: "";

				return (
					result.messages
						.map((m) =>
							formatSlackMessageLine({
								messageId: m.id,
								from: m.from,
								createdAt: m.createdAt,
								content: m.content,
							}),
						)
						.join("\n\n") + moreSuffix
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] get_thread_replies failed", {
					error: errorMessage,
				});
				return `Failed to get thread replies: ${errorMessage}`;
			}
		},
	});
}

// Returns file metadata + Slack permalinks only — binary content is not fetched.
function createGetSlackSharedFilesTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "get_shared_files",
		description: `List files shared in a Slack channel linked to this project.
Use this when the user asks about attachments, screenshots, PDFs, or diagrams in a Slack channel,
or when a search result references a file you can't see the content of. Returns file metadata plus
Slack permalinks the user can click. The channelId comes from list_linked_channels.

Filter by passing 'types' as a comma-separated Slack file type list (images, pdfs, snippets,
spaces, gdocs, zips, etc.). Omit 'types' to return all file types.`,
		schema: z.object({
			channelId: z
				.string()
				.describe("The Slack channel ID to list files from"),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of files to return (default: 20, max: 100)",
				),
			types: z
				.string()
				.optional()
				.describe(
					"Optional comma-separated Slack file types filter (e.g. 'images,pdfs').",
				),
		}),
		func: async ({ channelId, limit = 20, types }) => {
			logger.info("[ToolNode] Executing get_shared_files", {
				channelId,
				limit,
				types: types || null,
			});

			try {
				const clampedLimit = Math.min(Math.max(1, limit), 100);
				const result = (await callSlackTool(
					"get_shared_files",
					{
						channel: channelId,
						channelId,
						limit: clampedLimit,
						...(types ? { types } : {}),
					},
					state,
					aiToken,
				)) as
					| string
					| {
							files?: Array<{
								id: string;
								name?: string;
								title?: string;
								mimetype?: string;
								filetype?: string;
								size?: number;
								createdBy?: string;
								createdAt?: string;
								permalink?: string;
								urlPrivate?: string;
							}>;
							count?: number;
							total?: number;
					  };

				if (typeof result === "string") {
					return result;
				}

				if (!result.files || result.files.length === 0) {
					return "No files found in this channel.";
				}

				logger.info("[ToolNode] get_shared_files returned results", {
					fileCount: result.files.length,
					total: result.total ?? result.files.length,
				});

				return result.files
					.map((f) => {
						const link = f.permalink ? ` <${f.permalink}>` : "";
						const size =
							typeof f.size === "number"
								? ` ${Math.round(f.size / 1024)}KB`
								: "";
						const type = f.filetype || f.mimetype || "file";
						const by = f.createdBy ? ` by **${f.createdBy}**` : "";
						const when = f.createdAt ? ` (${f.createdAt})` : "";
						return `- ${f.name || f.id} [${type}${size}]${by}${when}${link}`;
					})
					.join("\n");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] get_shared_files failed", {
					error: errorMessage,
				});
				return `Failed to get shared files: ${errorMessage}`;
			}
		},
	});
}

/**
 * Tool node that executes server-side Teams and Slack tools.
 *
 * Uses ToolNode from @langchain/langgraph/prebuilt (same pattern as data-analyst).
 * Only creates integration tools when the corresponding integration flag is true.
 */
/**
 * Create the search_project_knowledge tool for server-side execution.
 *
 * Searches all embedded project context (meeting transcripts, documents, codebase, etc.)
 * via Qdrant vector search. Same core logic as the orchestrator's project_rag_query.
 */
function createSearchProjectKnowledgeTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	const apiUrl = getApiUrl();

	return new DynamicStructuredTool({
		name: "search_project_knowledge",
		description:
			"Search the project's knowledge base for relevant information including meeting transcripts, uploaded documents, codebase analysis, and integration content.",
		schema: z.object({
			query: z
				.string()
				.describe(
					"Search query — use specific terms related to what you're looking for",
				),
			topK: z
				.number()
				.optional()
				.describe(
					"Maximum number of results to return (default: 10, max: 20)",
				),
		}),
		func: async ({ query, topK = 10 }) => {
			const { projectId, userId } = state;

			if (!projectId || !userId) {
				logger.warn(
					"[ToolNode] Missing projectId or userId for project knowledge search",
					{ projectId, userId },
				);
				return "Project knowledge search skipped: missing project or user context.";
			}

			logger.info("[ToolNode] Executing search_project_knowledge", {
				projectId,
				query,
				topK,
			});

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (aiToken) {
					headers["X-AI-Token"] = aiToken;
				}

				const response = await fetch(
					`${apiUrl}/api/internal/project-context-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							projectId,
							query,
							topK: Math.min(Math.max(1, topK), 20),
						}),
					},
				);

				if (!response.ok) {
					if (response.status === 401) {
						return internalApiFailure(
							"search_project_knowledge",
							response.status,
						);
					}
					logger.warn("[ToolNode] project-context-search API error", {
						status: response.status,
					});
					return `Project knowledge search failed (${response.status}). Continuing without this context.`;
				}

				const result = (await response.json()) as {
					formatted: string;
					totalCount: number;
				};

				if (result.totalCount === 0) {
					return "No relevant project knowledge found for this query. Try different search terms or check if project context has been uploaded.";
				}

				logger.info(
					"[ToolNode] search_project_knowledge returned results",
					{
						resultCount: result.totalCount,
						contentLength: result.formatted.length,
					},
				);

				return result.formatted;
			} catch (error) {
				logger.error(
					"[ToolNode] search_project_knowledge failed:",
					error instanceof Error ? error.message : error,
				);
				return "Project knowledge search failed. Continuing without this context.";
			}
		},
	});
}

// ============================================================================
// Code Search Tools (search_repository_code, get_repository_file, list_repository_structure)
// ============================================================================

function createSearchRepositoryCodeTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	const apiUrl = getApiUrl();

	return new DynamicStructuredTool({
		name: "search_repository_code",
		description:
			"Search the project's repository for code matching a query. Returns file paths, matched snippets, and relevance scores. Use this to find specific functions, patterns, or implementations in the codebase.",
		schema: z.object({
			query: z
				.string()
				.describe(
					"Search query — use specific terms, function names, or patterns",
				),
			path: z
				.string()
				.optional()
				.describe(
					"Filter results to a specific directory path (e.g., 'src/auth')",
				),
			language: z
				.string()
				.optional()
				.describe(
					"Filter by programming language (e.g., 'typescript', 'python')",
				),
			maxResults: z
				.number()
				.optional()
				.describe("Maximum number of results (default: 10, max: 30)"),
		}),
		func: async ({ query, path, language, maxResults }) => {
			const { projectId } = state;
			if (!projectId) {
				return "Code search skipped: no project context.";
			}

			logger.info("[ToolNode] Executing search_repository_code", {
				projectId,
				query,
				path,
				language,
			});

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (aiToken) {
					headers["X-AI-Token"] = aiToken;
				}

				const response = await fetch(
					`${apiUrl}/api/internal/code-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							projectId,
							action: "search",
							query,
							path,
							language,
							maxResults: Math.min(maxResults ?? 10, 30),
						}),
					},
				);

				if (!response.ok) {
					if (response.status === 401) {
						return internalApiFailure(
							"search_repository_code",
							response.status,
						);
					}
					logger.warn("[ToolNode] code-search API error", {
						status: response.status,
					});
					return `Code search failed (${response.status}). Continuing without code context.`;
				}

				const result = (await response.json()) as {
					results: Array<{
						filePath: string;
						fileName: string;
						repository: string;
						htmlUrl?: string;
						matchedSnippets: string[];
					}>;
					totalCount: number;
				};

				if (result.totalCount === 0) {
					return "No code matches found. Try different search terms.";
				}

				const formatted = result.results
					.map((r) => {
						const snippets =
							r.matchedSnippets.length > 0
								? r.matchedSnippets.join("\n---\n")
								: "(no preview available)";
						return `### ${r.filePath}\n${snippets}`;
					})
					.join("\n\n");

				return `Found ${result.totalCount} code matches:\n\n${formatted}`;
			} catch (error) {
				logger.error(
					"[ToolNode] search_repository_code failed:",
					error instanceof Error ? error.message : error,
				);
				return "Code search failed. Continuing without code context.";
			}
		},
	});
}

function createGetRepositoryFileTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	const apiUrl = getApiUrl();

	return new DynamicStructuredTool({
		name: "get_repository_file",
		description:
			"Fetch the full content of a specific file from the project's repository by its path. Use after search_repository_code to read the full source of a relevant file.",
		schema: z.object({
			path: z
				.string()
				.describe(
					"File path relative to repository root (e.g., 'src/auth/middleware.ts')",
				),
			branch: z
				.string()
				.optional()
				.describe(
					"Branch name (defaults to the repository's default branch)",
				),
		}),
		func: async ({ path, branch }) => {
			const { projectId } = state;
			if (!projectId) {
				return "File retrieval skipped: no project context.";
			}

			logger.info("[ToolNode] Executing get_repository_file", {
				projectId,
				path,
			});

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (aiToken) {
					headers["X-AI-Token"] = aiToken;
				}

				const response = await fetch(
					`${apiUrl}/api/internal/code-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							projectId,
							action: "get-file",
							path,
							branch,
						}),
					},
				);

				if (!response.ok) {
					if (response.status === 401) {
						return internalApiFailure(
							"get_repository_file",
							response.status,
						);
					}
					return `File retrieval failed (${response.status}).`;
				}

				const result = (await response.json()) as {
					file: {
						path: string;
						content: string;
						size: number;
						isBinary: boolean;
						isTruncated: boolean;
					};
				};

				if (result.file.isBinary) {
					return `File ${path} is a binary file and cannot be displayed.`;
				}

				if (!result.file.content) {
					return `File ${path} not found or is empty.`;
				}

				const truncNote = result.file.isTruncated
					? "\n\n(File truncated at 100KB)"
					: "";
				return `### ${result.file.path} (${result.file.size} bytes)\n\`\`\`\n${result.file.content}\n\`\`\`${truncNote}`;
			} catch (error) {
				logger.error(
					"[ToolNode] get_repository_file failed:",
					error instanceof Error ? error.message : error,
				);
				return "File retrieval failed.";
			}
		},
	});
}

function createListRepositoryStructureTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	const apiUrl = getApiUrl();

	return new DynamicStructuredTool({
		name: "list_repository_structure",
		description:
			"List the directory tree of the project's repository. Useful for understanding the project structure before searching for specific files.",
		schema: z.object({
			directory: z
				.string()
				.optional()
				.describe(
					"Filter to a specific directory (e.g., 'src/components'). Omit for full tree.",
				),
		}),
		func: async ({ directory }) => {
			const { projectId } = state;
			if (!projectId) {
				return "Structure listing skipped: no project context.";
			}

			logger.info("[ToolNode] Executing list_repository_structure", {
				projectId,
				directory,
			});

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (aiToken) {
					headers["X-AI-Token"] = aiToken;
				}

				const response = await fetch(
					`${apiUrl}/api/internal/code-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							projectId,
							action: "list-structure",
							directory,
						}),
					},
				);

				if (!response.ok) {
					if (response.status === 401) {
						return internalApiFailure(
							"list_repository_structure",
							response.status,
						);
					}
					return `Structure listing failed (${response.status}).`;
				}

				const result = (await response.json()) as {
					structure: {
						entries: Array<{
							path: string;
							type: "file" | "directory";
							size?: number;
						}>;
						truncated: boolean;
					};
					totalFiles: number;
					totalDirectories: number;
				};

				if (result.structure.entries.length === 0) {
					return "No files found in the repository (or directory).";
				}

				const tree = result.structure.entries
					.map((e) => {
						const icon = e.type === "directory" ? "📁" : "📄";
						const size = e.size ? ` (${e.size}B)` : "";
						return `${icon} ${e.path}${size}`;
					})
					.join("\n");

				const truncNote = result.structure.truncated
					? "\n\n(Tree was truncated — repository has too many files)"
					: "";

				return `Repository structure (${result.totalFiles} files, ${result.totalDirectories} directories):\n\n${tree}${truncNote}`;
			} catch (error) {
				logger.error(
					"[ToolNode] list_repository_structure failed:",
					error instanceof Error ? error.message : error,
				);
				return "Structure listing failed.";
			}
		},
	});
}

/**
 * Create the write_document_asset tool.
 *
 * Persists a non-markdown artifact (e.g. a self-contained HTML architecture
 * diagram generated by the architecture-diagram skill) as a
 * ProjectDocumentAsset attached to the current ProjectDocument. The handler
 * POSTs to /api/internal/document-assets which authenticates via the
 * X-AI-Token header and validates tenant ownership of the document.
 */
function createWriteDocumentAssetTool(
	state: AgentState,
	aiToken?: string,
): DynamicStructuredTool {
	const apiUrl = getApiUrl();

	return new DynamicStructuredTool({
		name: "write_document_asset",
		description: `Save a non-markdown artifact (e.g. a self-contained HTML diagram) as a file attached to the current document. Use this when an active skill produces HTML, SVG, or binary output instead of markdown.

Required fields:
- filename: the file name (e.g. "architecture-diagram.html").
- contentType: the MIME type (e.g. "text/html", "image/svg+xml").
- content: the full artifact. utf-8 for text, base64 for binary (set encoding accordingly).

Reference the artifact in the markdown body with: <!-- asset:<filename> -->
The document viewer renders it inline at that anchor.`,
		schema: z.object({
			filename: z
				.string()
				.min(1)
				.max(200)
				.describe("Artifact filename with extension"),
			contentType: z
				.string()
				.min(1)
				.max(200)
				.describe("MIME type, e.g. text/html"),
			content: z
				.string()
				.describe("File body. utf-8 text unless encoding is 'base64'."),
			encoding: z
				.enum(["utf-8", "base64"])
				.optional()
				.describe("Content encoding. Defaults to utf-8."),
		}),
		func: async ({ filename, contentType, content, encoding }) => {
			const { documentId, userId } = state;

			if (!documentId || !userId) {
				logger.warn(
					"[ToolNode] write_document_asset skipped — missing documentId/userId",
					{ documentId, userId },
				);
				return "write_document_asset skipped: missing document or user context.";
			}

			if (!aiToken) {
				return "write_document_asset failed: missing AI token.";
			}

			try {
				const response = await fetch(
					`${apiUrl}/api/internal/document-assets`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-AI-Token": aiToken,
						},
						body: JSON.stringify({
							documentId,
							filename,
							contentType,
							content,
							encoding: encoding ?? "utf-8",
						}),
					},
				);

				if (!response.ok) {
					if (response.status === 401) {
						await response.text().catch(() => "");
						return internalApiFailure(
							"write_document_asset",
							response.status,
						);
					}
					const errText = await response.text().catch(() => "");
					logger.warn("[ToolNode] write_document_asset API error", {
						status: response.status,
						error: errText.slice(0, 200),
					});
					return `write_document_asset failed (${response.status}): ${errText.slice(0, 200) || "unknown error"}`;
				}

				const result = (await response.json()) as {
					assetId: string;
					filename: string;
					sizeBytes: number;
				};

				logger.info("[ToolNode] write_document_asset succeeded", {
					assetId: result.assetId,
					filename: result.filename,
					sizeBytes: result.sizeBytes,
				});

				return `Asset saved: ${result.filename} (${result.sizeBytes} bytes). Reference it in the markdown body with: <!-- asset:${result.filename} -->`;
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				logger.error("[ToolNode] write_document_asset failed", {
					error: errorMessage,
				});
				return `write_document_asset failed: ${errorMessage}`;
			}
		},
	});
}

export async function toolNode(
	state: AgentState,
	config?: { configurable?: Record<string, unknown> },
): Promise<Partial<AgentState>> {
	const tools: DynamicStructuredTool[] = [];
	const aiToken = config?.configurable?.ai_token as string | undefined;

	// Always available — searches all embedded project context
	tools.push(createSearchProjectKnowledgeTool(state, aiToken));

	// Always available when an active skill is present — lets the skill
	// persist generated HTML/SVG/binary artifacts alongside the document.
	if (state.activeSkill && state.documentId) {
		tools.push(createWriteDocumentAssetTool(state, aiToken));
	}

	if (state.hasTeamsIntegration) {
		tools.push(createListLinkedChatsTool(state, aiToken));
		tools.push(createSearchTeamsMessagesTool(state, aiToken));
		tools.push(createGetChatMessagesTool(state, aiToken));
		tools.push(createGetTeamsChannelMessagesTool(state, aiToken));
		tools.push(createGetFullMessageTool(state, aiToken));
		tools.push(createListMessageRepliesTool(state, aiToken));
		tools.push(createGetMessageHostedContentTool(state, aiToken));
	}

	if (state.hasSlackIntegration) {
		tools.push(createListLinkedChannelsTool(state, aiToken));
		tools.push(createSearchSlackMessagesTool(state, aiToken));
		tools.push(createGetChannelMessagesTool(state, aiToken));
		tools.push(createGetSlackThreadRepliesTool(state, aiToken));
		tools.push(createGetSlackSharedFilesTool(state, aiToken));
	}

	if (state.hasRepoIntegration) {
		tools.push(createSearchRepositoryCodeTool(state, aiToken));
		tools.push(createGetRepositoryFileTool(state, aiToken));
		tools.push(createListRepositoryStructureTool(state, aiToken));
	}

	const node = new ToolNode(tools);
	const result = (await node.invoke(state, config)) as Record<string, any>;

	return { messages: splitImageToolMessages(result.messages || []) };
}

/**
 * Split image-bearing tool results into a TEXT-ONLY ToolMessage (satisfying
 * the pending tool_call) plus a synthetic HumanMessage carrying the
 * `image_url` parts, so the LLM still receives real image inputs instead of
 * base64 text strings.
 *
 * We do NOT put `image_url` parts inside the ToolMessage itself. The OpenAI
 * chat-completions schema (which Databricks' AI-gateway enforces) types a
 * tool-role message's content as
 * `string | Array<ChatCompletionContentPartText>` — image parts are only valid
 * on `user` messages. A ToolMessage carrying an `image_url` part is a
 * malformed request under that schema, and the gateway rejects the ENTIRE
 * request with a schema-validation 400 (empty body, no per-field detail)
 * rather than just dropping the image. Anthropic's native tool_result blocks
 * do allow images, but this agent talks to an OpenAI-compatible surface, not
 * the native Anthropic API, so that leniency doesn't apply.
 *
 * ORDERING: image HumanMessages are appended AFTER every ToolMessage in the
 * batch — never spliced in beside the tool result they came from. One
 * assistant turn can emit several parallel tool_calls (the norm for this
 * agent), and the provider requires ALL of that turn's tool results to follow
 * it contiguously. Interleaving a user turn between two tool results — which
 * happens whenever the image tool isn't the last call in the batch — produces
 * exactly the malformed history this split exists to prevent.
 *
 * `reconcileToolCalls` (chat-node-tools.ts) matches ToolMessages by
 * `tool_call_id`, not array position, so appending after the batch doesn't
 * break tool-call bookkeeping.
 *
 * Pure and exported so the ordering contract is testable without standing up
 * LangChain's ToolNode.
 */
export function splitImageToolMessages(
	resultMessages: BaseMessage[],
): BaseMessage[] {
	const imageMessages: BaseMessage[] = [];
	const toolMessages: BaseMessage[] = resultMessages.map(
		(msg: BaseMessage): BaseMessage => {
			if (!(msg instanceof ToolMessage)) {
				return msg;
			}

			const content = typeof msg.content === "string" ? msg.content : "";
			if (!content.includes('"__images":true')) {
				return msg;
			}

			try {
				const parsed = JSON.parse(content) as {
					__images: boolean;
					text: string;
					images: Array<{
						id: string;
						contentType: string;
						base64: string;
					}>;
					skipped: number;
				};

				if (!parsed.__images || !parsed.images?.length) {
					return msg;
				}

				const textOnlyToolMessage = new ToolMessage({
					content: parsed.text,
					tool_call_id: msg.tool_call_id,
					name: msg.name,
				});

				const imageParts: Array<
					| { type: "text"; text: string }
					| {
							type: "image_url";
							image_url: { url: string };
					  }
				> = [
					{
						// The tool_call_id disambiguates provenance when the
						// same tool is invoked more than once in one batch —
						// these turns are appended after the whole batch, so
						// position alone no longer identifies the caller.
						type: "text",
						text: `Image(s) retrieved by ${msg.name ?? "tool"} (${msg.tool_call_id}):`,
					},
				];

				for (const img of parsed.images) {
					imageParts.push({
						type: "image_url",
						image_url: {
							url: `data:${img.contentType};base64,${img.base64}`,
						},
					});
				}

				if (parsed.skipped > 0) {
					imageParts.push({
						type: "text",
						text: `${parsed.skipped} image(s) were too large and should be viewed directly in Teams.`,
					});
				}

				// Flagged as synthetic: this is tool output wearing a user role
				// (image parts are only schema-valid on a user message), not a
				// real user turn. Turn-accounting helpers skip flagged messages
				// so image retrieval can't refill the per-turn tool budget or
				// split one request across several reasoning-trace turns.
				imageMessages.push(
					new HumanMessage({
						content: imageParts,
						additional_kwargs: {
							[SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG]: true,
						},
					}),
				);
				return textOnlyToolMessage;
			} catch {
				return msg;
			}
		},
	);

	// Tool results first (contiguous with their assistant tool_calls turn),
	// then any image payloads as follow-up user turns.
	return [...toolMessages, ...imageMessages];
}
