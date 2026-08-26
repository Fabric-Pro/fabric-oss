/**
 * Slack Credentials Helper
 *
 * Retrieves Slack bot tokens from integration connections.
 * Used by Temporal activities and API routes.
 */

import { db } from "@repo/database";
import { decryptApiKey } from "@repo/utils";

export interface SlackCredentials {
	accessToken: string;
	/** User token (xoxp-) for user-scoped APIs like search.messages */
	userAccessToken?: string;
	integrationId: string;
	teamId?: string;
	teamName?: string;
}

/**
 * Get Slack credentials from WorkflowIntegration.
 *
 * Uses XOR tenant isolation:
 * - If organizationId provided: look for org-level integration
 * - Otherwise: look for personal user integration
 *
 * @param userId - The user ID
 * @param organizationId - Optional organization ID for org-level integrations
 * @returns Slack credentials including access token
 */
export default async function getSlackCredentials(
	userId: string,
	organizationId?: string,
): Promise<SlackCredentials> {
	const integration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "SLACK",
					isActive: true,
					NOT: { name: "SLACK_OAUTH_APP" },
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "SLACK",
					isActive: true,
					NOT: { name: "SLACK_OAUTH_APP" },
				},
			});

	if (!integration) {
		throw new Error(
			"Slack not connected. Please connect your Slack workspace in Settings > Integrations.",
		);
	}

	if (!integration.credentials) {
		throw new Error(
			"Slack credentials missing. Please reconnect your Slack workspace in Settings > Integrations.",
		);
	}

	// Credentials are stored as an encrypted JSON string
	let credentialsJson: string;
	try {
		credentialsJson = decryptApiKey(integration.credentials);
	} catch {
		// Might not be encrypted (legacy) — use raw value
		credentialsJson = integration.credentials;
	}

	let parsed: Record<string, string>;
	try {
		parsed = JSON.parse(credentialsJson) as Record<string, string>;
	} catch {
		throw new Error(
			"Slack credentials are corrupted. Please reconnect your Slack workspace in Settings > Integrations.",
		);
	}

	// Support both OAuth format (access_token) and direct token format (apiKey)
	const accessToken = parsed.access_token || parsed.apiKey;
	if (!accessToken) {
		throw new Error(
			"Slack access token missing. Please reconnect your Slack workspace in Settings > Integrations.",
		);
	}

	return {
		accessToken,
		userAccessToken: parsed.user_access_token || undefined,
		integrationId: integration.id,
		teamId: parsed.team_id,
		teamName: parsed.team_name,
	};
}
