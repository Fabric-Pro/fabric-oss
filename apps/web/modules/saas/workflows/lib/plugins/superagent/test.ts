import type { TestConnectionResult } from "../types";

/**
 * Superagent has no dedicated auth-check endpoint, so this posts a trivial
 * guard request. A 401/403 proves the key is bad; anything else proves the
 * key is accepted.
 */
export async function testSuperagentConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.SUPERAGENT_API_KEY ?? credentials.apiKey;
	if (!apiKey) {
		return { success: false, error: "API key is required" };
	}

	try {
		const response = await fetch("https://app.superagent.sh/api/guard", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ text: "ping" }),
		});

		if (response.status === 401 || response.status === 403) {
			return { success: false, error: "Superagent rejected the API key" };
		}
		if (!response.ok) {
			return {
				success: false,
				error: `Superagent returned HTTP ${response.status}`,
			};
		}
		return { success: true, message: "Connected to Superagent" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Could not reach Superagent",
		};
	}
}
