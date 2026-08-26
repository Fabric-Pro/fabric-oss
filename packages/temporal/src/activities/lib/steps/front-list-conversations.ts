/**
 * Front List Conversations Step
 * Lists conversations from a Front inbox
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeFrontListConversationsStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { inboxId, status } = params.nodeConfig as {
		inboxId?: string;
		status?: string;
	};

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

	const interpolatedInboxId = inboxId
		? interpolateTemplate(inboxId, params.inputs)
		: "";
	const conversationStatus = status || "open";

	try {
		let url: string;
		if (interpolatedInboxId) {
			url = `https://api2.frontapp.com/inboxes/${interpolatedInboxId}/conversations?q[statuses][]=${conversationStatus}`;
		} else {
			url = `https://api2.frontapp.com/conversations?q[statuses][]=${conversationStatus}`;
		}

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${credentials.FRONT_API_KEY}`,
			},
		});

		const result = (await response.json()) as {
			_results?: Array<{
				id: string;
				subject: string;
				status: string;
				created_at: number;
			}>;
			error?: string;
		};

		if (!response.ok) {
			return {
				success: false,
				error:
					result.error || `Front returned status ${response.status}`,
			};
		}

		const conversations = result._results ?? [];
		return {
			success: true,
			output: {
				conversations: conversations.map((c) => ({
					id: c.id,
					subject: c.subject,
					status: c.status,
					createdAt: c.created_at,
				})),
				count: conversations.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to list Front conversations",
		};
	}
}
