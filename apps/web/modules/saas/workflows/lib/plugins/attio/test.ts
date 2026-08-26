/**
 * Attio Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

export async function testAttioConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.ATTIO_API_KEY;

		if (!apiKey) {
			return {
				success: false,
				error: "ATTIO_API_KEY is required",
			};
		}

		const response = await fetch("https://api.attio.com/v2/self", {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (response.ok) {
			const data = (await response.json()) as {
				data?: { workspace?: { name?: string } };
			};
			const workspaceName =
				data.data?.workspace?.name || "your workspace";
			return {
				success: true,
				message: `Attio connection successful. Connected to ${workspaceName}`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API key. Please check your Attio API key.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Attio returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
