/**
 * Advisor tools: what the Advisor knows about itself and the workspace.
 *
 * The "Improve Fabric" starter asks the Advisor to review the last week of
 * sessions and suggest configuration changes. Before these tools existed the
 * model had nothing to read and reached for workspace-document RAG, which
 * failed with "No workspaces are attached". These four tools give it the
 * data the question is actually about: its own recent conversations, one
 * conversation in full, the agents in the workspace, and the connections
 * (integrations and MCP servers) that are configured.
 *
 * Everything is scoped to the calling user, and to the organisation when
 * the chat runs in one, the same way the workflow tools are.
 */

import { db } from "@repo/database";
import { tool } from "ai";
import { z } from "zod";

const ADVISOR_AGENT_IDS = ["fabric-workspace-assistant", "fabric-ai"];

interface StoredToolCall {
	name?: unknown;
	toolName?: unknown;
	status?: unknown;
	error?: unknown;
}

interface StoredMessage {
	role?: unknown;
	content?: unknown;
	isError?: unknown;
	toolCalls?: unknown;
	timestamp?: unknown;
	createdAt?: unknown;
}

export interface SessionSummary {
	messageCount: number;
	userMessageCount: number;
	/** First user messages, trimmed, oldest first. */
	userRequests: string[];
	/** Distinct tool names the assistant called. */
	toolsUsed: string[];
	/** Assistant messages flagged as errors plus tool calls that failed. */
	errorCount: number;
	/** Short excerpt of the last assistant message. */
	lastAssistantExcerpt: string | null;
}

function asArray(value: unknown): StoredMessage[] {
	return Array.isArray(value) ? (value as StoredMessage[]) : [];
}

function textOf(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part
					? String((part as { text: unknown }).text ?? "")
					: "",
			)
			.join(" ");
	}
	return "";
}

function excerpt(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Pure summary of a stored conversation, so it can be tested without a
 * database and reused by both list and detail tools.
 */
export function summarizeSession(messages: unknown): SessionSummary {
	const list = asArray(messages);
	const userRequests: string[] = [];
	const toolsUsed = new Set<string>();
	let errorCount = 0;
	let userMessageCount = 0;
	let lastAssistantExcerpt: string | null = null;

	for (const message of list) {
		if (message.role === "user") {
			userMessageCount += 1;
			if (userRequests.length < 5) {
				const text = excerpt(textOf(message.content), 200);
				if (text) {
					userRequests.push(text);
				}
			}
			continue;
		}
		if (message.role === "assistant") {
			if (message.isError === true) {
				errorCount += 1;
			}
			const text = excerpt(textOf(message.content), 240);
			if (text) {
				lastAssistantExcerpt = text;
			}
			if (Array.isArray(message.toolCalls)) {
				for (const call of message.toolCalls as StoredToolCall[]) {
					const name = call?.name ?? call?.toolName;
					if (typeof name === "string" && name) {
						toolsUsed.add(name);
					}
					if (call?.status === "error" || call?.error) {
						errorCount += 1;
					}
				}
			}
		}
	}

	return {
		messageCount: list.length,
		userMessageCount,
		userRequests,
		toolsUsed: [...toolsUsed].sort(),
		errorCount,
		lastAssistantExcerpt,
	};
}

function fail(prefix: string, error: unknown) {
	return {
		error: `${prefix}: ${error instanceof Error ? error.message : "Unknown error"}`,
	};
}

export function createAdvisorTools(
	userId: string,
	organizationId?: string,
): Record<string, unknown> {
	const scope = organizationId ? { organizationId } : { userId };

	return {
		list_recent_sessions: tool({
			description:
				"List the Advisor's own recent conversations (sessions) in this workspace: when they happened, what the user asked, which tools were called and where errors occurred. Use this to review how Fabric is being used and to suggest configuration changes. Do not use workspace document tools for this.",
			inputSchema: z.object({
				days: z
					.number()
					.int()
					.min(1)
					.max(90)
					.optional()
					.describe("How many days back to look. Default 7."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.describe(
						"Maximum sessions to return, newest first. Default 20.",
					),
				includeAllAgents: z
					.boolean()
					.optional()
					.describe(
						"Include conversations with other agents, not only the Advisor. Default false.",
					),
			}) as any,
			execute: async (params: {
				days?: number;
				limit?: number;
				includeAllAgents?: boolean;
			}) => {
				try {
					const days = params.days ?? 7;
					const since = new Date(
						Date.now() - days * 24 * 60 * 60 * 1000,
					);
					const rows = await db.agentConversation.findMany({
						where: {
							...scope,
							updatedAt: { gte: since },
							...(params.includeAllAgents
								? {}
								: { agentId: { in: ADVISOR_AGENT_IDS } }),
						},
						orderBy: { updatedAt: "desc" },
						take: params.limit ?? 20,
						select: {
							id: true,
							title: true,
							agentId: true,
							status: true,
							createdAt: true,
							updatedAt: true,
							messages: true,
						},
					});

					if (rows.length === 0) {
						return {
							message: `No Advisor sessions in the last ${days} days.`,
							days,
							sessions: [],
						};
					}

					return {
						days,
						count: rows.length,
						sessions: rows.map((row) => ({
							id: row.id,
							title: row.title,
							agentId: row.agentId,
							status: row.status,
							startedAt: row.createdAt.toISOString(),
							lastActiveAt: row.updatedAt.toISOString(),
							...summarizeSession(row.messages),
						})),
					};
				} catch (error) {
					return fail("Failed to list recent sessions", error);
				}
			},
		}),

		get_session: tool({
			description:
				"Read one Advisor conversation in full (trimmed): every user and assistant message with the tools that were called. Use the id from list_recent_sessions.",
			inputSchema: z.object({
				conversationId: z.string().describe("Conversation id."),
			}) as any,
			execute: async (params: { conversationId: string }) => {
				try {
					const row = await db.agentConversation.findFirst({
						where: { id: params.conversationId, ...scope },
						select: {
							id: true,
							title: true,
							agentId: true,
							createdAt: true,
							updatedAt: true,
							messages: true,
						},
					});
					if (!row) {
						return {
							error: "Conversation not found in this workspace.",
						};
					}
					const messages = asArray(row.messages)
						.slice(-40)
						.map((message) => ({
							role: message.role,
							content: excerpt(textOf(message.content), 1500),
							isError: message.isError === true || undefined,
							toolCalls: Array.isArray(message.toolCalls)
								? (message.toolCalls as StoredToolCall[]).map(
										(call) => ({
											name: call?.name ?? call?.toolName,
											status: call?.status,
											error: call?.error
												? excerpt(
														String(call.error),
														300,
													)
												: undefined,
										}),
									)
								: undefined,
						}));
					return {
						id: row.id,
						title: row.title,
						agentId: row.agentId,
						startedAt: row.createdAt.toISOString(),
						lastActiveAt: row.updatedAt.toISOString(),
						...summarizeSession(row.messages),
						messages,
					};
				} catch (error) {
					return fail("Failed to read the session", error);
				}
			},
		}),

		list_agents: tool({
			description:
				"List the agents configured in this workspace (agent template instances) with their status.",
			inputSchema: z.object({
				includeArchived: z
					.boolean()
					.optional()
					.describe("Include archived agents. Default false."),
			}) as any,
			execute: async (params: { includeArchived?: boolean }) => {
				try {
					const rows = await db.agentTemplateInstance.findMany({
						where: {
							...scope,
							...(params.includeArchived
								? {}
								: { status: { not: "ARCHIVED" } }),
						},
						orderBy: { updatedAt: "desc" },
						take: 100,
						select: {
							id: true,
							name: true,
							status: true,
							templateId: true,
							updatedAt: true,
						},
					});
					return {
						count: rows.length,
						agents: rows.map((row) => ({
							id: row.id,
							name: row.name,
							status: row.status,
							templateId: row.templateId,
							updatedAt: row.updatedAt.toISOString(),
						})),
					};
				} catch (error) {
					return fail("Failed to list agents", error);
				}
			},
		}),

		list_connections: tool({
			description:
				"List the connections configured in this workspace: integrations (data connections such as GitHub, Slack, Jira) and MCP servers, with their status. Use this before suggesting a connection to add.",
			inputSchema: z.object({}) as any,
			execute: async () => {
				try {
					const [integrations, mcpServers] = await Promise.all([
						db.dataConnection.findMany({
							where: scope,
							orderBy: { updatedAt: "desc" },
							take: 100,
							select: {
								id: true,
								name: true,
								provider: true,
								status: true,
								updatedAt: true,
							},
						}),
						db.mCPConfig.findMany({
							where: scope,
							orderBy: { updatedAt: "desc" },
							take: 100,
							select: {
								id: true,
								displayName: true,
								mcpServerId: true,
								enabled: true,
								status: true,
								updatedAt: true,
							},
						}),
					]);
					const serverIds = [
						...new Set(mcpServers.map((row) => row.mcpServerId)),
					];
					const servers = serverIds.length
						? await db.mCPServer.findMany({
								where: { id: { in: serverIds } },
								select: { id: true, name: true },
							})
						: [];
					const serverName = new Map(
						servers.map((server) => [server.id, server.name]),
					);
					return {
						integrations: integrations.map((row) => ({
							id: row.id,
							name: row.name,
							provider: row.provider,
							status: row.status,
							updatedAt: row.updatedAt.toISOString(),
						})),
						mcpServers: mcpServers.map((row) => ({
							id: row.id,
							name:
								row.displayName ??
								serverName.get(row.mcpServerId) ??
								row.mcpServerId,
							server: serverName.get(row.mcpServerId) ?? null,
							enabled: row.enabled,
							status: row.status,
							updatedAt: row.updatedAt.toISOString(),
						})),
					};
				} catch (error) {
					return fail("Failed to list connections", error);
				}
			},
		}),
	};
}
