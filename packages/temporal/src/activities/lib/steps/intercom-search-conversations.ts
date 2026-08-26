import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeIntercomSearchConversationsStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query } = params.nodeConfig as { query?: string };

	if (!query) {
		return { success: false, error: "Search query is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"INTERCOM",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.INTERCOM_ACCESS_TOKEN) {
		return {
			success: false,
			error: "Intercom access token is required in Settings > Integrations.",
		};
	}

	try {
		const searchTerm = interpolateTemplate(query, params.inputs);
		const response = await fetch(
			"https://api.intercom.io/conversations/search",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.INTERCOM_ACCESS_TOKEN}`,
					"Content-Type": "application/json",
					Accept: "application/json",
					"Intercom-Version": "2.11",
				},
				body: JSON.stringify({
					query: {
						operator: "OR",
						value: [
							{
								field: "source.body",
								operator: "~",
								value: searchTerm,
							},
						],
					},
				}),
			},
		);

		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.errors?.[0]?.message ||
					`Intercom returned status ${response.status}`,
			};
		}

		const conversations =
			(result.conversations as Array<Record<string, unknown>>) ?? [];
		return {
			success: true,
			output: {
				conversations: conversations.map((conversation) => ({
					id: conversation.id,
					state: conversation.state,
					createdAt: conversation.created_at,
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
					: "Failed to search Intercom conversations",
		};
	}
}
