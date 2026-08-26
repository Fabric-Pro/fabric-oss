/**
 * Canva Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

export async function testCanvaConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const accessToken = credentials.CANVA_ACCESS_TOKEN;

		if (!accessToken) {
			return {
				success: false,
				error: "CANVA_ACCESS_TOKEN is required",
			};
		}

		const response = await fetch("https://api.canva.com/rest/v1/users/me", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.ok) {
			const data = (await response.json()) as {
				team_user?: { display_name?: string; email?: string };
			};
			const name = data.team_user?.display_name || "your account";
			return {
				success: true,
				message: `Canva connection successful. Connected as ${name}`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API token. Please check your Canva credentials.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Canva returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
