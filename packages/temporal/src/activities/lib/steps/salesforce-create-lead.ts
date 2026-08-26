import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

function normalizeSalesforceDomain(domain: string) {
	return domain.startsWith("http")
		? domain.replace(/\/$/, "")
		: `https://${domain.replace(/\/$/, "")}`;
}

export async function executeSalesforceCreateLeadStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { firstName, lastName, company, email, phone } =
		params.nodeConfig as Record<string, string | undefined>;

	if (!lastName || !company) {
		return { success: false, error: "Last name and company are required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"SALESFORCE",
		params.userId,
		params.organizationId,
	);

	if (
		!credentials?.SALESFORCE_DOMAIN ||
		!credentials?.SALESFORCE_ACCESS_TOKEN
	) {
		return {
			success: false,
			error: "Salesforce domain and access token are required in Settings > Integrations.",
		};
	}

	const domain = normalizeSalesforceDomain(credentials.SALESFORCE_DOMAIN);

	try {
		const response = await fetch(
			`${domain}/services/data/v61.0/sobjects/Lead`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.SALESFORCE_ACCESS_TOKEN}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					FirstName: firstName
						? interpolateTemplate(firstName, params.inputs)
						: undefined,
					LastName: interpolateTemplate(lastName, params.inputs),
					Company: interpolateTemplate(company, params.inputs),
					Email: email
						? interpolateTemplate(email, params.inputs)
						: undefined,
					Phone: phone
						? interpolateTemplate(phone, params.inputs)
						: undefined,
				}),
			},
		);

		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.[0]?.message ||
					`Salesforce returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				leadId: result.id,
				leadUrl: `${domain}/${result.id}`,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Salesforce lead",
		};
	}
}
