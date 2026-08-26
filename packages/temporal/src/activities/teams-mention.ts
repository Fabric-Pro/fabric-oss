/**
 * Teams Mention Activities
 *
 * Activities for the Teams mention handler workflow:
 * - postToTeams: Send a message/reply to a Teams channel or chat via Microsoft Graph API
 * - loadTeamsThreadMapping: Load conversation context for a Teams thread
 * - saveTeamsThreadMappingContext: Persist conversation context for a Teams thread
 */

import { db, isProjectReadOnly } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";

// =============================================================================
// Thread Message Type
// =============================================================================

export interface TeamsThreadMessage {
	role: "user" | "assistant";
	content: string;
	ts: string;
}

// =============================================================================
// Post Message to Teams
// =============================================================================

// Read-only mode reply gate: a
// project-BOUND agent must NOT post Teams replies while its project is in
// Read-only mode — the mention goes unanswered (logged, never thrown). The
// binding lives on the agent instance (toolConnections["project-context"]),
// resolved by invokeAgent and threaded here as `projectId`. Agents with no
// project binding still reply. The newsletter path gates its whole send
// upstream on its own projectId and does not pass one here.
export async function postToTeams({
	teamId,
	channelId,
	chatId,
	messageId,
	message,
	userId,
	organizationId,
	projectId,
}: {
	teamId?: string;
	channelId?: string;
	chatId?: string;
	messageId?: string;
	message: string;
	userId: string;
	organizationId?: string;
	/** The agent's bound project — enables the read-only reply gate above. */
	projectId?: string;
}): Promise<{
	success: boolean;
	error?: string;
	messageId?: string;
	skipped?: boolean;
}> {
	if (projectId && (await isProjectReadOnly(projectId))) {
		console.info(
			"[TeamsMention] Skipping Teams reply — bound project is in Read-only mode",
			{ teamId, channelId, chatId, projectId },
		);
		return { success: true, skipped: true };
	}

	try {
		const result = await executeMicrosoftTeamsTool(
			"send_message",
			{
				teamId,
				channelId,
				chatId,
				messageId,
				text: message,
			},
			userId,
			organizationId,
		);

		const typedResult = result as {
			success?: boolean;
			messageId?: string;
		};

		return {
			success: typedResult.success ?? true,
			messageId: typedResult.messageId,
		};
	} catch (error) {
		console.error("[TeamsMention] Failed to post message:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

// =============================================================================
// Thread Mapping Activities
// =============================================================================

/**
 * Load Teams thread mapping and conversation history.
 *
 * Uses SlackThreadMapping as the backing store with a "teams" platform
 * indicator stored in the contextJson to avoid a schema migration.
 */
export async function loadTeamsThreadMapping({
	teamsTeamId,
	teamsChannelId,
	teamsThreadId,
	userId,
	organizationId,
}: {
	teamsTeamId: string;
	teamsChannelId: string;
	teamsThreadId: string;
	userId: string;
	organizationId?: string;
}): Promise<{
	mapping: {
		id: string;
		deploymentId: string;
		status: string;
		contextJson: Record<string, unknown> | null;
	} | null;
	conversationHistory: TeamsThreadMessage[];
}> {
	// Use a composite key prefix to distinguish Teams entries in SlackThreadMapping
	const compositeTeamId = `teams:${teamsTeamId}`;
	const compositeChannelId = `teams:${teamsChannelId}`;

	const mapping = await db.slackThreadMapping.findFirst({
		where: {
			slackTeamId: compositeTeamId,
			slackChannelId: compositeChannelId,
			slackThreadTs: teamsThreadId,
			userId,
			organizationId: organizationId ?? null,
		},
		select: {
			id: true,
			deploymentId: true,
			status: true,
			contextJson: true,
		},
	});

	if (!mapping) {
		return { mapping: null, conversationHistory: [] };
	}

	const contextJson = (mapping.contextJson as Record<string, unknown>) || {};
	const history =
		(contextJson.conversationHistory as TeamsThreadMessage[]) || [];

	return {
		mapping: {
			id: mapping.id,
			deploymentId: mapping.deploymentId,
			status: mapping.status,
			contextJson: mapping.contextJson as Record<string, unknown> | null,
		},
		conversationHistory: history,
	};
}

/**
 * Save conversation context to Teams thread mapping.
 */
export async function saveTeamsThreadMappingContext({
	mappingId,
	conversationHistory,
}: {
	mappingId: string;
	conversationHistory: TeamsThreadMessage[];
}): Promise<{ success: boolean }> {
	try {
		await db.slackThreadMapping.update({
			where: { id: mappingId },
			data: {
				contextJson: {
					conversationHistory,
					lastUpdated: new Date().toISOString(),
					platform: "teams",
				} as unknown as import("@prisma/client/runtime/library").InputJsonValue,
			},
		});
		return { success: true };
	} catch (error) {
		console.error("[TeamsMention] Failed to save thread context:", error);
		return { success: false };
	}
}

/**
 * Create or update a Teams thread mapping in the database.
 */
export async function upsertTeamsThreadMapping({
	teamsTeamId,
	teamsChannelId,
	teamsThreadId,
	deploymentId,
	workflowId,
	userId,
	organizationId,
}: {
	teamsTeamId: string;
	teamsChannelId: string;
	teamsThreadId: string;
	deploymentId: string;
	workflowId?: string;
	userId: string;
	organizationId?: string;
}): Promise<{ mappingId: string; isNew: boolean }> {
	const compositeTeamId = `teams:${teamsTeamId}`;
	const compositeChannelId = `teams:${teamsChannelId}`;
	const timeoutAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

	const existing = await db.slackThreadMapping.findFirst({
		where: {
			slackTeamId: compositeTeamId,
			slackChannelId: compositeChannelId,
			slackThreadTs: teamsThreadId,
			userId,
			organizationId: organizationId ?? null,
		},
	});

	if (existing) {
		const updated = await db.slackThreadMapping.update({
			where: { id: existing.id },
			data: {
				workflowId: workflowId ?? existing.workflowId,
				status: "active",
				timeoutAt,
			},
		});
		return { mappingId: updated.id, isNew: false };
	}

	const created = await db.slackThreadMapping.create({
		data: {
			slackTeamId: compositeTeamId,
			slackChannelId: compositeChannelId,
			slackThreadTs: teamsThreadId,
			deploymentId,
			workflowId,
			status: "active",
			timeoutAt,
			userId,
			organizationId: organizationId ?? null,
			contextJson: {
				platform: "teams",
				createdAt: new Date().toISOString(),
			},
		},
	});

	return { mappingId: created.id, isNew: true };
}
