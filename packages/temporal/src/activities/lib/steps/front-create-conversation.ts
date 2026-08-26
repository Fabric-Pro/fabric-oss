/**
 * Front Create Conversation Step
 * Creates a new email conversation in Front
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeFrontCreateConversationStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { subject, body, to, channelId } = params.nodeConfig as {
		subject?: string;
		body?: string;
		to?: string;
		channelId?: string;
	};

	if (!subject || !body || !to) {
		return {
			success: false,
			error: "Subject, body, and to are required",
		};
	}

	const credentials = await fetchCredentialsByProvider(
		"FRONT",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.FRONT_API_KEY) {
		return {
			success: false,
			error: "Front API token not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedSubject = interpolateTemplate(subject, params.inputs);
	const interpolatedBody = interpolateTemplate(body, params.inputs);
	const interpolatedTo = interpolateTemplate(to, params.inputs);
	const recipients = interpolatedTo
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);

	try {
		const payload: Record<string, unknown> = {
			subject: interpolatedSubject,
			body: interpolatedBody,
			to: recipients,
		};
		if (channelId) {
			payload.channel_id = channelId;
		}

		const response = await fetch(
			"https://api2.frontapp.com/conversations",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.FRONT_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			},
		);

		const result = (await response.json()) as {
			id?: string;
			_links?: { self: string };
			error?: string;
		};

		if (!response.ok) {
			return {
				success: false,
				error:
					result.error || `Front returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				conversationId: result.id,
				conversationUrl: result._links?.self,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Front conversation",
		};
	}
}
