/**
 * Asana Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

export async function testAsanaConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const accessToken = credentials.ASANA_ACCESS_TOKEN;

		if (!accessToken) {
			return {
				success: false,
				error: "ASANA_ACCESS_TOKEN is required",
			};
		}

		const response = await fetch("https://app.asana.com/api/1.0/users/me", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.ok) {
			const data = (await response.json()) as {
				data: { name: string; email: string };
			};
			return {
				success: true,
				message: `Asana connection successful. Connected as ${data.data.name} (${data.data.email})`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid access token. Please check your Asana credentials.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Asana returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
