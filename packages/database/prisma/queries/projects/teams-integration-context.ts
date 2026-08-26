/**
 * Register a monitored Teams channel/chat as a ProjectContext INTEGRATION row.
 *
 * The on-demand AI Update source picker (`ReviewSourcesSelector`) and the
 * backlog-analysis Teams fetch (`search-project-teams-messages`) both resolve
 * Teams sources purely from `ProjectContext.metadata` — never from the
 * `ProjectLinked*` monitor tables. The Add-Context dialog already writes both a
 * ProjectContext row and a monitor link, but the Project Settings monitor link
 * path (`linkTeamsChannelToProject` / `linkTeamsChatToProject`) writes only the
 * monitor row — so a channel monitored that way is invisible in the picker and
 * unfetchable on demand. These helpers close that gap by writing the same
 * canonical metadata shape the picker + fetch read.
 *
 * The find-then-create guard is not atomic — `metadata` is a JSON column with no
 * unique index, matching the Add-Context path. A rare concurrent double-link
 * could create a duplicate INTEGRATION row (a redundant, harmless picker entry).
 * Acceptable because the caller invokes these best-effort and non-fatally.
 */
import { db } from "../../client";
import { createContext } from "./contexts";

function readMetadata(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function buildTeamsChannelContextMetadata(params: {
	teamId: string;
	channelId: string;
	teamName?: string | null;
	channelName?: string | null;
}): Record<string, unknown> {
	const displayName =
		params.teamName && params.channelName
			? `${params.teamName} - ${params.channelName}`
			: params.channelName || params.teamName || "Teams channel";
	return {
		provider: "MICROSOFT_TEAMS",
		chatType: "channel",
		teamId: params.teamId,
		channelId: params.channelId,
		chatTopic: displayName,
		title: displayName,
		...(params.channelName
			? { channelName: params.channelName, chatName: params.channelName }
			: {}),
		...(params.teamName ? { teamName: params.teamName } : {}),
	};
}

export function buildTeamsChatContextMetadata(params: {
	chatId: string;
	chatTopic?: string | null;
	chatType?: string | null;
}): Record<string, unknown> {
	const type = params.chatType || "group";
	const topic =
		params.chatTopic ||
		(type === "oneOnOne" ? "1:1 Direct Chat" : "Teams group chat");
	return {
		provider: "MICROSOFT_TEAMS",
		chatType: type,
		chatId: params.chatId,
		chatTopic: topic,
		title: topic,
	};
}

/** True when `metadata` already describes this monitored Teams channel. */
export function teamsChannelContextMatches(
	metadata: unknown,
	params: { teamId: string; channelId: string },
): boolean {
	const m = readMetadata(metadata);
	return (
		m?.provider === "MICROSOFT_TEAMS" &&
		m?.teamId === params.teamId &&
		m?.channelId === params.channelId
	);
}

/** True when `metadata` already describes this monitored Teams group chat. */
export function teamsChatContextMatches(
	metadata: unknown,
	params: { chatId: string },
): boolean {
	const m = readMetadata(metadata);
	return m?.provider === "MICROSOFT_TEAMS" && m?.chatId === params.chatId;
}

/**
 * Idempotently ensure a ProjectContext INTEGRATION row exists for a monitored
 * Teams channel. Returns whether a row was created. Bypasses the Add-Context
 * count cap — a monitored channel must always be selectable regardless of how
 * many contexts the project already has.
 */
export async function ensureTeamsChannelIntegrationContext(params: {
	projectId: string;
	teamId: string;
	channelId: string;
	teamName?: string | null;
	channelName?: string | null;
	userId: string;
	organizationId?: string;
}): Promise<{ created: boolean; contextId: string }> {
	const existing = await db.projectContext.findMany({
		where: { projectId: params.projectId, type: "INTEGRATION" },
		select: { id: true, metadata: true },
	});
	const match = existing.find((ctx) =>
		teamsChannelContextMatches(ctx.metadata, params),
	);
	if (match) {
		return { created: false, contextId: match.id };
	}
	const created = await createContext({
		projectId: params.projectId,
		type: "INTEGRATION",
		content: "",
		metadata: buildTeamsChannelContextMetadata(params),
		extractionStatus: "COMPLETED",
		userId: params.userId,
		organizationId: params.organizationId,
	});
	return { created: true, contextId: created.id };
}

/**
 * Idempotently ensure a ProjectContext INTEGRATION row exists for a monitored
 * Teams chat (group or 1:1 direct). Returns whether a row was created.
 */
export async function ensureTeamsChatIntegrationContext(params: {
	projectId: string;
	chatId: string;
	chatTopic?: string | null;
	chatType?: string | null;
	userId: string;
	organizationId?: string;
}): Promise<{ created: boolean; contextId: string }> {
	const existing = await db.projectContext.findMany({
		where: { projectId: params.projectId, type: "INTEGRATION" },
		select: { id: true, metadata: true },
	});
	const match = existing.find((ctx) =>
		teamsChatContextMatches(ctx.metadata, params),
	);
	if (match) {
		return { created: false, contextId: match.id };
	}
	const created = await createContext({
		projectId: params.projectId,
		type: "INTEGRATION",
		content: "",
		metadata: buildTeamsChatContextMetadata(params),
		extractionStatus: "COMPLETED",
		userId: params.userId,
		organizationId: params.organizationId,
	});
	return { created: true, contextId: created.id };
}
