/**
 * Resend Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the Resend connection with provided credentials
 */
export async function testResendConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.RESEND_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "RESEND_API_KEY is required",
			};
		}

		// Verify token format
		if (!apiKey.startsWith("re_")) {
			return {
				success: false,
				error: "Invalid API key format. Resend keys should start with 're_'",
			};
		}

		// Test the connection by listing domains
		const response = await fetch("https://api.resend.com/domains", {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (response.ok) {
			return {
				success: true,
				message: "Resend connection successful",
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API key. Please check your Resend API key.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Resend returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
