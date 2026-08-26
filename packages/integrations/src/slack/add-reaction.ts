/**
 * Slack Add Reaction
 *
 * Posts an emoji reaction to a Slack message using bot credentials
 * resolved from the WorkflowIntegration table.
 *
 * Used by the inbound channel handler to acknowledge user messages
 * directed at the bot (`@Fabric` mentions and DMs) so users see an
 * immediate visual confirmation that the bot received the event.
 *
 * Bot tokens issued before `reactions:write` was added to the OAuth
 * scope list will fail this call with `missing_scope`. Callers should
 * treat this as a non-fatal degraded state — the bot will continue
 * to reply normally; users just won't see the acknowledgment emoji
 * until they reconnect Slack.
 */

import { db } from "@repo/database";
import { decryptApiKey } from "@repo/utils";

interface AddSlackReactionInput {
	teamId: string;
	channel: string;
	timestamp: string;
	name: string;
	userId: string;
	organizationId?: string;
}

interface AddSlackReactionResult {
	ok: boolean;
	error?: string;
}

async function resolveSlackBotToken(
	teamId: string,
	userId: string,
	organizationId?: string,
): Promise<string> {
	const trigger = await db.agentDeploymentTrigger.findFirst({
		where: {
			slackTeamId: teamId,
			isActive: true,
			userId,
			...(organizationId ? { organizationId } : { organizationId: null }),
		},
		include: { deployment: true },
	});

	if (trigger?.deployment) {
		const integration = await db.workflowIntegration.findFirst({
			where: {
				userId,
				provider: "SLACK",
				isActive: true,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (integration?.credentials) {
			let credentialsJson: string;
			try {
				credentialsJson = decryptApiKey(integration.credentials);
			} catch {
				credentialsJson = integration.credentials;
			}

			const parsed = JSON.parse(credentialsJson) as Record<
				string,
				string
			>;
			const token = parsed.access_token || parsed.apiKey;
			if (token) {
				return token;
			}
		}
	}

	throw new Error(
		`No Slack bot token found for team ${teamId}. Connect Slack in Settings > Integrations.`,
	);
}

export async function addSlackReaction(
	input: AddSlackReactionInput,
): Promise<AddSlackReactionResult> {
	try {
		const token = await resolveSlackBotToken(
			input.teamId,
			input.userId,
			input.organizationId,
		);

		const body = new URLSearchParams({
			channel: input.channel,
			timestamp: input.timestamp,
			name: input.name,
		}).toString();

		const response = await fetch("https://slack.com/api/reactions.add", {
			method: "POST",
			headers: {
				"Content-Type":
					"application/x-www-form-urlencoded; charset=utf-8",
				Authorization: `Bearer ${token}`,
			},
			body,
		});

		if (!response.ok) {
			return {
				ok: false,
				error: `Slack API error: ${response.status} ${response.statusText}`,
			};
		}

		const data = (await response.json()) as {
			ok: boolean;
			error?: string;
		};

		if (!data.ok) {
			return {
				ok: false,
				error: data.error ?? "Unknown Slack API error",
			};
		}

		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add Slack reaction",
		};
	}
}
