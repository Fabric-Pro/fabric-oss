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
import {
	executeMicrosoftTeamsTool,
	isMicrosoftAccessDeniedError,
} from "@repo/integrations/microsoft";
import { executeSlackTool } from "@repo/integrations/slack";
import {
	neutralizeAiChatAttachmentBody,
	neutralizeAiChatAttachmentFilename,
} from "@repo/utils/ai-chat-attachment";

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
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				// A Graph 403 here means THIS user can't read THIS chat/channel —
				// a per-viewer condition surfaced per-context in the project's
				// Context tab via integrations.teams.contextAccess (Fizzy #2450),
				// not an operational fault, so it doesn't belong at error level.
				if (isMicrosoftAccessDeniedError(errorMessage)) {
					console.warn(
						`[LiveIntegrationContext] Access denied fetching Teams messages from ${ctx.displayName}:`,
						errorMessage,
					);
				} else {
					console.error(
						`[LiveIntegrationContext] Error fetching Teams messages from ${ctx.displayName}:`,
						errorMessage,
					);
				}
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

/**
 * The tag this block wraps its contents in, and the one an injected message
 * would have to close to escape into the surrounding prompt.
 */
const LIVE_CONTEXT_TAG = "live_integration_context";

/**
 * An opening or closing `live_integration_context` tag, however spaced or
 * cased, with any trailing underscores already applied by a previous pass.
 */
const LIVE_CONTEXT_TAG_PATTERN = new RegExp(
	`<\\s*/?\\s*${LIVE_CONTEXT_TAG}_*\\s*>`,
	"gi",
);

/** Line terminators a heading could be anchored to. Mirrors the chat envelope's. */
const LIVE_CONTEXT_LINE_BREAK_CLASS =
	"[\\r\\n\\u000B\\u000C\\u0085\\u2028\\u2029]";

/**
 * A `#` run that would forge one of this block's own section headings.
 *
 * Anchored to a line start, because a `#` run is only a heading there — so a
 * message that merely mentions `## Recent Slack Discussions` mid-sentence keeps
 * its text.
 */
const LIVE_CONTEXT_FORGED_SECTION_PATTERN = new RegExp(
	`(^|${LIVE_CONTEXT_LINE_BREAK_CLASS})([ \\t]*)#{1,6}(?=[ \\t]+Recent[ \\t]+(?:Slack|Microsoft[ \\t]+Teams)[ \\t]+Discussions)`,
	"gi",
);

/**
 * Mangle one matched tag by appending an underscore to the tag name.
 *
 * Moves *away* from the real delimiter, which deletion does not: removing the
 * inner tag from `<<live_integration_context>live_integration_context>`
 * reassembles a live one, whereas no amount of nesting converges back onto a
 * lengthening name.
 */
function mangleLiveContextTag(match: string): string {
	return match.replace(
		new RegExp(LIVE_CONTEXT_TAG, "i"),
		`${LIVE_CONTEXT_TAG}_`,
	);
}

/**
 * Neutralize one untrusted message field against every delimiter it could forge.
 *
 * Two layers, because two envelopes are in play. `neutralizeAiChatAttachmentBody`
 * covers the shared chat scaffolding (`### Reference n`, `## Retrieved Context`,
 * the attachment tag) that this text can end up beside in the same prompt; the
 * two passes after it cover the delimiters this block owns and that the shared
 * neutralizer knows nothing about.
 *
 * Applied here, in the renderer, rather than at the producers: the text arrives
 * from Slack and from Teams through separate fetches, so no earlier point sees
 * all of it — the same reasoning recorded on `buildRetrievedContextBlock`.
 */
function neutralizeLiveContextBody(text: string): string {
	return neutralizeAiChatAttachmentBody(text)
		.replace(LIVE_CONTEXT_TAG_PATTERN, mangleLiveContextTag)
		.replace(LIVE_CONTEXT_FORGED_SECTION_PATTERN, "$1$2");
}

/**
 * Neutralize a display name, which is interpolated mid-line after `From: `.
 *
 * Line breaks are the load-bearing part: once the name cannot contain one it
 * cannot start a line, and therefore cannot open a heading or a tag of its own.
 */
function neutralizeLiveContextName(name: string): string {
	return neutralizeLiveContextBody(neutralizeAiChatAttachmentFilename(name));
}

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
	// Annotations are set by project members rather than by a channel, so a far
	// lower bar than the message itself — but they are interpolated into the
	// same block, and a field that can start a line can forge the same headings.
	const meta =
		(msg.sourceLabel
			? `\n[Source type: ${neutralizeLiveContextName(msg.sourceLabel)}]`
			: "") +
		(msg.sourceGuidance
			? `\n[Source guidance: ${neutralizeLiveContextName(
					msg.sourceGuidance,
				)}]`
			: "");
	// `from` and `content` are the untrusted halves: anyone who can post in a
	// linked channel controls both, and neither needs a Fabric account.
	return `${header}${meta}\nFrom: ${neutralizeLiveContextName(
		msg.from,
	)}\n${neutralizeLiveContextBody(msg.content)}`;
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
