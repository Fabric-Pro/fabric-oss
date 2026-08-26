/**
 * AI Gateway Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the AI Gateway connection with provided credentials
 */
export async function testAiGatewayConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.AI_GATEWAY_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "AI_GATEWAY_API_KEY is required",
			};
		}

		// Verify it's a Vercel AI Gateway key
		if (!apiKey.startsWith("vck_")) {
			return {
				success: false,
				error: "Invalid API key format. Vercel AI Gateway keys should start with 'vck_'",
			};
		}

		// Test the connection by making a minimal API call
		const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (response.ok) {
			return {
				success: true,
				message: "AI Gateway connection successful",
			};
		}

		// Handle specific error cases
		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API key. Please check your Vercel AI Gateway key.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `AI Gateway returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
