/**
 * Slack Send Message Step
 * Sends messages to Slack channels
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeSlackSendStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { slackChannel, slackMessage } = params.nodeConfig as {
		slackChannel?: string;
		slackMessage?: string;
	};

	if (!slackChannel || !slackMessage) {
		return { success: false, error: "Channel and message are required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"SLACK",
		params.userId,
		params.organizationId,
	);

	const token = credentials?.SLACK_TOKEN;
	if (!token) {
		return {
			success: false,
			error: "Slack bot token not configured. Please connect Slack in Settings > Integrations.",
		};
	}

	// Validate token format
	if (!token.startsWith("xoxb-")) {
		if (token.startsWith("xoxp-")) {
			return {
				success: false,
				error: "Invalid token type: You have a User Token (xoxp-) configured. Please use a Bot User OAuth Token (xoxb-) instead.",
			};
		}
		return {
			success: false,
			error: `Invalid token format: Slack Bot tokens should start with "xoxb-".`,
		};
	}

	const interpolatedChannel = interpolateTemplate(
		slackChannel,
		params.inputs,
	);
	const interpolatedMessage = interpolateTemplate(
		slackMessage,
		params.inputs,
	);

	try {
		const response = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				channel: interpolatedChannel,
				text: interpolatedMessage,
			}),
		});

		const result = await response.json();

		if (!result.ok) {
			let errorMessage = result.error || "Failed to send Slack message";
			if (result.error === "not_allowed_token_type") {
				errorMessage =
					"Token type not allowed. Make sure you're using a Bot User OAuth Token (xoxb-) with 'chat:write' scope.";
			} else if (result.error === "channel_not_found") {
				errorMessage = `Channel "${interpolatedChannel}" not found. Make sure the bot is invited to this channel.`;
			} else if (result.error === "not_in_channel") {
				errorMessage = `Bot is not in channel "${interpolatedChannel}". Invite the bot to this channel first.`;
			}
			return { success: false, error: errorMessage };
		}

		return {
			success: true,
			output: {
				// `ts` and `ok` are what the plugin declares (and what Slack's
				// API calls them); `timestamp` predates them and is kept so
				// existing workflows keep resolving.
				ok: true,
				ts: result.ts,
				timestamp: result.ts,
				channel: result.channel,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to send Slack message",
		};
	}
}
