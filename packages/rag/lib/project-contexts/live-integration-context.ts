/**
 * Live Integration Context Fetcher
 *
 * Fetches recent messages from Teams chats/channels and Slack channels
 * linked to a project. These are fetched live (not from Qdrant) because
 * integration contexts are stored as pointer records with empty content.
 *
 * Used by the document AI chat stream and feature enhancement to inject
 * real-time team discussions as LLM context.
 */

import { db } from "@repo/database";
import type { ProjectContextType } from "@repo/database/prisma/client";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { executeSlackTool } from "@repo/integrations/slack";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TeamsContext {
	type: "chat" | "channel";
	chatId?: string;
	teamId?: string;
	channelId?: string;
	displayName: string;
	sourceLabel?: string | null;
	sourceGuidance?: string | null;
}

interface SlackContext {
	channelId: string;
	channelName: string;
	sourceLabel?: string | null;
	sourceGuidance?: string | null;
}

interface IntegrationMessage {
	id: string;
	content: string;
	from: string;
	createdAt?: string;
	source: string; // display name of the chat/channel
	/** Parent context's user-declared type label + AI guidance (#1888);
	 * present only when the parent source carries them. */
	sourceLabel?: string;
	sourceGuidance?: string;
}

export interface LiveIntegrationContextResult {
	teamsMessages: IntegrationMessage[];
	slackMessages: IntegrationMessage[];
	teamsMessageCount: number;
	slackMessageCount: number;
	hasTeams: boolean;
	hasSlack: boolean;
}

export interface FetchLiveIntegrationContextOptions {
	projectId: string;
	userId: string;
	organizationId?: string;
	teamsLimit?: number;
	slackLimit?: number;
}

// ─── Core Fetch ──────────────────────────────────────────────────────────────

export async function fetchLiveIntegrationContext(
	options: FetchLiveIntegrationContextOptions,
): Promise<LiveIntegrationContextResult> {
	const {
		projectId,
		userId,
		organizationId,
		teamsLimit = 20,
		slackLimit = 20,
	} = options;

	// Find all INTEGRATION contexts for this project
	const integrationContexts = await db.projectContext.findMany({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
		},
		select: {
			id: true,
			metadata: true,
			sourceType: true,
			aiInstructions: true,
		},
	});

	if (integrationContexts.length === 0) {
		return {
			teamsMessages: [],
			slackMessages: [],
			teamsMessageCount: 0,
			slackMessageCount: 0,
			hasTeams: false,
			hasSlack: false,
		};
	}

	// Parse Teams and Slack contexts from metadata
	const teamsContexts: TeamsContext[] = [];
	const slackContexts: SlackContext[] = [];

	for (const ctx of integrationContexts) {
		const metadata = ctx.metadata as Record<string, unknown> | null;
		if (!metadata) {
			continue;
		}

		if (metadata.provider === "MICROSOFT_TEAMS") {
			const chatType = metadata.chatType as string | undefined;
			if (
				chatType === "channel" &&
				metadata.teamId &&
				metadata.channelId
			) {
				teamsContexts.push({
					type: "channel",
					teamId: metadata.teamId as string,
					channelId: metadata.channelId as string,
					displayName:
						(metadata.chatTopic as string) || "Teams Channel",
					sourceLabel: ctx.sourceType ?? null,
					sourceGuidance: ctx.aiInstructions ?? null,
				});
			} else if (metadata.chatId) {
				teamsContexts.push({
					type: "chat",
					chatId: metadata.chatId as string,
					displayName: (metadata.chatTopic as string) || "Teams Chat",
					sourceLabel: ctx.sourceType ?? null,
					sourceGuidance: ctx.aiInstructions ?? null,
				});
			}
		} else if (metadata.provider === "SLACK" && metadata.channelId) {
			slackContexts.push({
				channelId: metadata.channelId as string,
				channelName:
					(metadata.channelName as string) || "Slack Channel",
				sourceLabel: ctx.sourceType ?? null,
				sourceGuidance: ctx.aiInstructions ?? null,
			});
		}
	}

	// Fetch messages in parallel
	const [teamsMessages, slackMessages] = await Promise.all([
		teamsContexts.length > 0
			? fetchTeamsMessages(
					teamsContexts,
					teamsLimit,
					userId,
					organizationId,
				)
			: Promise.resolve([]),
		slackContexts.length > 0
			? fetchSlackMessages(
					slackContexts,
					slackLimit,
					userId,
					organizationId,
				)
			: Promise.resolve([]),
	]);

	return {
		teamsMessages,
		slackMessages,
		teamsMessageCount: teamsMessages.length,
		slackMessageCount: slackMessages.length,
		hasTeams: teamsContexts.length > 0,
		hasSlack: slackContexts.length > 0,
	};
}

// ─── Teams Messages ──────────────────────────────────────────────────────────

async function fetchTeamsMessages(
	contexts: TeamsContext[],
	limit: number,
	userId: string,
	organizationId?: string,
): Promise<IntegrationMessage[]> {
	const messagesPerContext = Math.ceil(limit / contexts.length);

	type ApiResult = {
		messages: Array<{
			id: string;
			content: string;
			from: string;
			createdAt?: string;
		}>;
		count: number;
	};

	// Fetch all contexts in parallel
	const results = await Promise.all(
		contexts.map(async (ctx): Promise<IntegrationMessage[]> => {
			try {
				let result: ApiResult;
				if (ctx.type === "chat" && ctx.chatId) {
					result = (await executeMicrosoftTeamsTool(
						"get_chat_messages",
						{ chatId: ctx.chatId, limit: messagesPerContext },
						userId,
						organizationId,
					)) as ApiResult;
				} else if (
					ctx.type === "channel" &&
					ctx.teamId &&
					ctx.channelId
				) {
					result = (await executeMicrosoftTeamsTool(
						"list_messages",
						{
							teamId: ctx.teamId,
							channelId: ctx.channelId,
							limit: messagesPerContext,
						},
						userId,
						organizationId,
					)) as ApiResult;
				} else {
					return [];
				}
				return (result.messages || []).map((msg) => ({
					id: msg.id,
					content: msg.content,
					from: msg.from,
					createdAt: msg.createdAt,
					source: ctx.displayName,
					sourceLabel: ctx.sourceLabel ?? undefined,
					sourceGuidance: ctx.sourceGuidance ?? undefined,
				}));
			} catch (error) {
				console.error(
					`[LiveIntegrationContext] Error fetching Teams messages from ${ctx.displayName}:`,
					error instanceof Error ? error.message : error,
				);
				return [];
			}
		}),
	);

	const allMessages = results.flat();

	// Sort most recent first and limit
	allMessages.sort((a, b) => {
		if (!a.createdAt || !b.createdAt) {
			return 0;
		}
		return (
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		);
	});

	return allMessages.slice(0, limit);
}

// ─── Slack Messages ──────────────────────────────────────────────────────────

async function fetchSlackMessages(
	contexts: SlackContext[],
	limit: number,
	userId: string,
	organizationId?: string,
): Promise<IntegrationMessage[]> {
	const messagesPerChannel = Math.ceil(limit / contexts.length);

	// Fetch all channels in parallel
	const results = await Promise.all(
		contexts.map(async (ctx): Promise<IntegrationMessage[]> => {
			try {
				const result = (await executeSlackTool(
					"get_channel_messages",
					{ channelId: ctx.channelId, limit: messagesPerChannel },
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
				return (result.messages || []).map((msg) => ({
					id: msg.id,
					content: msg.content,
					from: msg.from,
					createdAt: msg.createdAt,
					source: ctx.channelName,
					sourceLabel: ctx.sourceLabel ?? undefined,
					sourceGuidance: ctx.sourceGuidance ?? undefined,
				}));
			} catch (error) {
				console.error(
					`[LiveIntegrationContext] Error fetching Slack messages from ${ctx.channelName}:`,
					error instanceof Error ? error.message : error,
				);
				return [];
			}
		}),
	);

	const allMessages = results.flat();

	// Sort most recent first and limit
	allMessages.sort((a, b) => {
		if (!a.createdAt || !b.createdAt) {
			return 0;
		}
		return (
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		);
	});

	return allMessages.slice(0, limit);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatMessage(msg: IntegrationMessage): string {
	const timestamp = msg.createdAt
		? new Date(msg.createdAt).toLocaleString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})
		: "";
	const header = timestamp
		? `[${msg.source} - ${timestamp}]`
		: `[${msg.source}]`;
	// Parent source's type label + AI guidance (#1888) — arrives flag-gated;
	// absent for unannotated sources, so headers stay byte-identical.
	const meta =
		(msg.sourceLabel ? `\n[Source type: ${msg.sourceLabel}]` : "") +
		(msg.sourceGuidance
			? `\n[Source guidance: ${msg.sourceGuidance}]`
			: "");
	return `${header}${meta}\nFrom: ${msg.from}\n${msg.content}`;
}

export function formatLiveContextForPrompt(
	result: LiveIntegrationContextResult,
): string {
	if (result.teamsMessageCount === 0 && result.slackMessageCount === 0) {
		return "";
	}

	const sections: string[] = [];

	if (result.teamsMessages.length > 0) {
		const formatted = result.teamsMessages.map(formatMessage).join("\n\n");
		sections.push(`## Recent Microsoft Teams Discussions\n\n${formatted}`);
	}

	if (result.slackMessages.length > 0) {
		const formatted = result.slackMessages.map(formatMessage).join("\n\n");
		sections.push(`## Recent Slack Discussions\n\n${formatted}`);
	}

	return `<live_integration_context>
The following are recent messages from communication channels linked to this project.
These messages reflect ongoing team discussions and may contain recent decisions, blockers, or context.

${sections.join("\n\n")}
</live_integration_context>`;
}
