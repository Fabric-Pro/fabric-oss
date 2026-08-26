import type { TestConnectionResult } from "../types";

export async function testHubSpotConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const accessToken = credentials.HUBSPOT_ACCESS_TOKEN || credentials.apiKey;
	if (!accessToken) {
		return { success: false, error: "HubSpot access token is required" };
	}

	try {
		const response = await fetch(
			"https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
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
				error: body || `HubSpot returned status ${response.status}`,
			};
		}

		return { success: true, message: "HubSpot connection successful" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to HubSpot",
		};
	}
}
