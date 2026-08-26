/**
 * Perplexity Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the Perplexity connection with provided credentials
 */
export async function testPerplexityConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.PERPLEXITY_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "PERPLEXITY_API_KEY is required",
			};
		}

		// Verify token format
		if (!apiKey.startsWith("pplx-")) {
			return {
				success: false,
				error: "Invalid API key format. Perplexity keys should start with 'pplx-'",
			};
		}

		// Test the connection with a minimal chat completion
		const response = await fetch(
			"https://api.perplexity.ai/chat/completions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "llama-3.1-sonar-small-128k-online",
					messages: [{ role: "user", content: "Hello" }],
					max_tokens: 1,
				}),
			},
		);

		if (response.ok) {
			return {
				success: true,
				message: "Perplexity connection successful",
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API key. Please check your Perplexity API key.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Perplexity returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
