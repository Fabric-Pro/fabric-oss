import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeZendeskSearchTicketsStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query } = params.nodeConfig as { query?: string };

	if (!query) {
		return { success: false, error: "Search query is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"ZENDESK",
		params.userId,
		params.organizationId,
	);

	if (
		!credentials?.ZENDESK_SUBDOMAIN ||
		!credentials?.ZENDESK_EMAIL ||
		!credentials?.ZENDESK_TOKEN
	) {
		return {
			success: false,
			error: "Zendesk subdomain, email, and token are required in Settings > Integrations.",
		};
	}

	const auth = Buffer.from(
		`${credentials.ZENDESK_EMAIL}/token:${credentials.ZENDESK_TOKEN}`,
	).toString("base64");
	const searchQuery = encodeURIComponent(
		interpolateTemplate(query, params.inputs),
	);

	try {
		const response = await fetch(
			`https://${credentials.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=${searchQuery}`,
			{
				headers: {
					Authorization: `Basic ${auth}`,
					Accept: "application/json",
				},
			},
		);
		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.error ||
					result?.description ||
					`Zendesk returned status ${response.status}`,
			};
		}

		const tickets = (
			(result.results as Array<Record<string, unknown>>) ?? []
		).filter(
			(item) => item.result_type === "ticket" || item.type === "ticket",
		);

		return {
			success: true,
			output: {
				tickets: tickets.map((ticket) => ({
					id: ticket.id,
					subject: ticket.subject,
					status: ticket.status,
					priority: ticket.priority,
					url: ticket.url,
				})),
				count: tickets.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search Zendesk tickets",
		};
	}
}
