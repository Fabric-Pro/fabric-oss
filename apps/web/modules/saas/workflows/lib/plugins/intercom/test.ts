import type { TestConnectionResult } from "../types";

export async function testIntercomConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const accessToken = credentials.INTERCOM_ACCESS_TOKEN || credentials.apiKey;
	if (!accessToken) {
		return { success: false, error: "Intercom access token is required" };
	}

	try {
		const response = await fetch("https://api.intercom.io/me", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const body = await response.text();
			return {
				success: false,
				error: body || `Intercom returned status ${response.status}`,
			};
		}

		return { success: true, message: "Intercom connection successful" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Intercom",
		};
	}
}
