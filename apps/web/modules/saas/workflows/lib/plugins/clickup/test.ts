import type { TestConnectionResult } from "../types";

export async function testClickUpConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiToken = credentials.CLICKUP_API_TOKEN || credentials.apiKey || "";

	if (!apiToken) {
		return { success: false, error: "ClickUp API token is required" };
	}

	try {
		const response = await fetch("https://api.clickup.com/api/v2/user", {
			headers: {
				Authorization: apiToken,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `ClickUp returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			user?: { username?: string; email?: string };
		};
		const identifier =
			data.user?.username || data.user?.email || "your ClickUp account";
		return {
			success: true,
			message: `Connected as ${identifier}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}
