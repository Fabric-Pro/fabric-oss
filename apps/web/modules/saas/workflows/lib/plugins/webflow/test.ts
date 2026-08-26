import type { TestConnectionResult } from "../types";

/** Validate a Webflow token by listing sites — the cheapest authenticated read. */
export async function testWebflowConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.WEBFLOW_API_KEY ?? credentials.apiKey;
	if (!apiKey) {
		return { success: false, error: "API token is required" };
	}

	try {
		const response = await fetch("https://api.webflow.com/v2/sites", {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
		});
		if (!response.ok) {
			return {
				success: false,
				error: `Webflow rejected the token (HTTP ${response.status})`,
			};
		}
		return { success: true, message: "Connected to Webflow" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Could not reach Webflow",
		};
	}
}
