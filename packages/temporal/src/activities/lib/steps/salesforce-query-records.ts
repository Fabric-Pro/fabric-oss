import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

function normalizeSalesforceDomain(domain: string) {
	return domain.startsWith("http")
		? domain.replace(/\/$/, "")
		: `https://${domain.replace(/\/$/, "")}`;
}

export async function executeSalesforceQueryRecordsStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query } = params.nodeConfig as { query?: string };

	if (!query) {
		return { success: false, error: "SOQL query is required" };
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
		const soql = encodeURIComponent(
			interpolateTemplate(query, params.inputs),
		);
		const response = await fetch(
			`${domain}/services/data/v61.0/query?q=${soql}`,
			{
				headers: {
					Authorization: `Bearer ${credentials.SALESFORCE_ACCESS_TOKEN}`,
					Accept: "application/json",
				},
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
				records: result.records ?? [],
				count: result.totalSize ?? 0,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to query Salesforce records",
		};
	}
}
