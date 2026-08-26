import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeHubSpotSearchContactsStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query } = params.nodeConfig as { query?: string };

	if (!query) {
		return { success: false, error: "Search query is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"HUBSPOT",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.HUBSPOT_ACCESS_TOKEN) {
		return {
			success: false,
			error: "HubSpot access token is required in Settings > Integrations.",
		};
	}

	try {
		const q = interpolateTemplate(query, params.inputs);
		const response = await fetch(
			"https://api.hubapi.com/crm/v3/objects/contacts/search",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.HUBSPOT_ACCESS_TOKEN}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					query: q,
					limit: 10,
					properties: ["email", "firstname", "lastname", "company"],
				}),
			},
		);
		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.message ||
					`HubSpot returned status ${response.status}`,
			};
		}

		const contacts =
			(result.results as Array<Record<string, unknown>>) ?? [];
		return {
			success: true,
			output: {
				contacts: contacts.map((contact) => ({
					id: contact.id,
					email: (contact.properties as Record<string, string>)
						?.email,
					firstname: (contact.properties as Record<string, string>)
						?.firstname,
					lastname: (contact.properties as Record<string, string>)
						?.lastname,
					company: (contact.properties as Record<string, string>)
						?.company,
				})),
				count: contacts.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search HubSpot contacts",
		};
	}
}
