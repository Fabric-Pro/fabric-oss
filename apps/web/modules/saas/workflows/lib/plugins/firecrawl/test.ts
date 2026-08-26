/**
 * Firecrawl Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the Firecrawl connection with provided credentials
 */
export async function testFirecrawlConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.FIRECRAWL_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "FIRECRAWL_API_KEY is required",
			};
		}

		// Test the connection by checking API status
		const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url: "https://example.com",
				formats: ["markdown"],
			}),
		});

		if (response.ok) {
			return {
				success: true,
				message: "Firecrawl connection successful",
			};
		}

		if (response.status === 401 || response.status === 403) {
			return {
				success: false,
				error: "Invalid API key. Please check your Firecrawl API key.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Firecrawl returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
