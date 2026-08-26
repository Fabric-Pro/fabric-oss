import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeHubSpotCreateContactStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { email, firstname, lastname, phone, company } =
		params.nodeConfig as Record<string, string | undefined>;

	if (!email) {
		return { success: false, error: "Email is required" };
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
		const properties: Record<string, string> = {
			email: interpolateTemplate(email, params.inputs),
		};
		if (firstname) {
			properties.firstname = interpolateTemplate(
				firstname,
				params.inputs,
			);
		}
		if (lastname) {
			properties.lastname = interpolateTemplate(lastname, params.inputs);
		}
		if (phone) {
			properties.phone = interpolateTemplate(phone, params.inputs);
		}
		if (company) {
			properties.company = interpolateTemplate(company, params.inputs);
		}

		const response = await fetch(
			"https://api.hubapi.com/crm/v3/objects/contacts",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.HUBSPOT_ACCESS_TOKEN}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({ properties }),
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

		return {
			success: true,
			output: {
				contactId: result.id,
				contactUrl: `https://app.hubspot.com/contacts/${result.id}`,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create HubSpot contact",
		};
	}
}
