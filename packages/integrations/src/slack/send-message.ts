/**
 * Slack Send Message
 *
 * Posts messages to Slack channels/threads using bot credentials
 * resolved from the WorkflowIntegration table.
 *
 * Used by the trigger system to reply back to @Fabric mentions
 * and by Weave/orchestrator for agent status updates.
 */

import { canUseWorkflowIntegrations, db } from "@repo/database";
import { decryptApiKey } from "@repo/utils";

interface SendSlackMessageInput {
	teamId: string;
	channel: string;
	text: string;
	threadTs?: string;
	userId: string;
	organizationId?: string;
}

interface SendSlackMessageResult {
	ok: boolean;
	messageTs?: string;
	error?: string;
}

/**
 * The bot token of the user's Slack connection for `teamId`.
 *
 * An organization's connection is used only while the user is a member of
 * that organization (`canUseWorkflowIntegrations`, as `getSlackCredentials`
 * checks): the callers act for a user named by a trigger, and a user who has
 * left, or who never belonged, gets no token even if a trigger and a
 * connection row with their id remain. A refusal reads as no token; with no
 * organization the user's personal connection is read as before.
 */
async function resolveSlackBotToken(
	teamId: string,
	userId: string,
	organizationId?: string,
): Promise<string> {
	if (!(await canUseWorkflowIntegrations(userId, organizationId))) {
		throw new Error(noSlackBotTokenMessage(teamId));
	}

	// Look for a deployment trigger with this team ID to find the right integration
	const trigger = await db.agentDeploymentTrigger.findFirst({
		where: {
			slackTeamId: teamId,
			isActive: true,
			userId,
			...(organizationId ? { organizationId } : { organizationId: null }),
		},
		include: {
			deployment: true,
		},
	});

	if (trigger?.deployment) {
		// Check for integration credentials on the deployment
		const integration = await db.workflowIntegration.findFirst({
			where: {
				userId,
				provider: "SLACK",
				NOT: { name: "SLACK_OAUTH_APP" },
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

	throw new Error(noSlackBotTokenMessage(teamId));
}

function noSlackBotTokenMessage(teamId: string): string {
	return `No Slack bot token found for team ${teamId}. Connect Slack in Settings > Integrations.`;
}

export async function sendSlackMessage(
	input: SendSlackMessageInput,
): Promise<SendSlackMessageResult> {
	try {
		const token = await resolveSlackBotToken(
			input.teamId,
			input.userId,
			input.organizationId,
		);

		const body: Record<string, unknown> = {
			channel: input.channel,
			text: input.text,
		};

		if (input.threadTs) {
			body.thread_ts = input.threadTs;
		}

		const response = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			return {
				ok: false,
				error: `Slack API error: ${response.status} ${response.statusText}`,
			};
		}

		const data = (await response.json()) as {
			ok: boolean;
			ts?: string;
			error?: string;
		};

		if (!data.ok) {
			return {
				ok: false,
				error: data.error ?? "Unknown Slack API error",
			};
		}

		return { ok: true, messageTs: data.ts };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to send Slack message",
		};
	}
}
