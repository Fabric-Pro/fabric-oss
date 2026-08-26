/**
 * Linear Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the Linear connection with provided credentials
 */
export async function testLinearConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.LINEAR_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "LINEAR_API_KEY is required",
			};
		}

		// Test the connection by querying the viewer
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				Authorization: apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "{ viewer { id name email } }",
			}),
		});

		if (response.ok) {
			const data = await response.json();
			if (data.data?.viewer) {
				return {
					success: true,
					message: `Linear connection successful. Connected as ${data.data.viewer.name}`,
				};
			}
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API key. Please check your Linear API key.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Linear returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
