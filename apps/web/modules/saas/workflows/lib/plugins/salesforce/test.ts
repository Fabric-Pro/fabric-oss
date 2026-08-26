import type { TestConnectionResult } from "../types";

export async function testSalesforceConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const domain = credentials.SALESFORCE_DOMAIN || credentials.domain;
	const accessToken =
		credentials.SALESFORCE_ACCESS_TOKEN ||
		credentials.apiToken ||
		credentials.apiKey;
	if (!domain || !accessToken) {
		return {
			success: false,
			error: "Salesforce domain and access token are required",
		};
	}

	const normalizedDomain = domain.startsWith("http")
		? domain.replace(/\/$/, "")
		: `https://${domain.replace(/\/$/, "")}`;

	try {
		const response = await fetch(
			`${normalizedDomain}/services/data/v61.0/limits`,
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			const body = await response.text();
			return {
				success: false,
				error: body || `Salesforce returned status ${response.status}`,
			};
		}

		return { success: true, message: "Salesforce connection successful" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Salesforce",
		};
	}
}
