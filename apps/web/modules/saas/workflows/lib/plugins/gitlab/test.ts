import type { TestConnectionResult } from "../types";

export async function testGitLabConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiToken =
		credentials.GITLAB_ACCESS_TOKEN || credentials.apiToken || "";
	const url =
		credentials.GITLAB_URL ||
		credentials.domain ||
		credentials.url ||
		"https://gitlab.com";

	if (!apiToken) {
		return { success: false, error: "GitLab access token is required" };
	}

	const normalizedUrl = url.startsWith("http")
		? url.replace(/\/$/, "")
		: `https://${url.replace(/\/$/, "")}`;

	try {
		const response = await fetch(`${normalizedUrl}/api/v4/user`, {
			headers: {
				Authorization: `Bearer ${apiToken}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `GitLab returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			username?: string;
			name?: string;
			email?: string;
		};
		return {
			success: true,
			message: `Connected as ${data.name || data.username || data.email || "your GitLab account"}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}
