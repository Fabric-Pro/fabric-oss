/**
 * fal.ai Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the fal.ai connection with provided credentials
 */
export async function testFalConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.FAL_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "FAL_API_KEY is required",
			};
		}

		// Test the connection by checking API access
		const response = await fetch("https://rest.fal.ai/check", {
			headers: {
				Authorization: `Key ${apiKey}`,
			},
		});

		if (response.ok) {
			return {
				success: true,
				message: "fal.ai connection successful",
			};
		}

		if (response.status === 401 || response.status === 403) {
			return {
				success: false,
				error: "Invalid API key. Please check your fal.ai API key.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `fal.ai returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
