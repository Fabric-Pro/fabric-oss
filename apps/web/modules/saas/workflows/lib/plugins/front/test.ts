/**
 * Front Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

export async function testFrontConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.FRONT_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "FRONT_API_KEY is required",
			};
		}

		const response = await fetch("https://api2.frontapp.com/me", {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (response.ok) {
			const data = (await response.json()) as {
				username?: string;
				email?: string;
			};
			const identifier = data.username || data.email || "your account";
			return {
				success: true,
				message: `Front connection successful. Connected as ${identifier}`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API token. Please check your Front API token.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Front returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
