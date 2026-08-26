/**
 * GitHub Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the GitHub connection with provided credentials
 */
export async function testGithubConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const token = credentials.GITHUB_TOKEN;

		if (!token) {
			return {
				success: false,
				error: "GITHUB_TOKEN is required",
			};
		}

		// Verify token format
		if (!token.startsWith("ghp_") && !token.startsWith("github_pat_")) {
			return {
				success: false,
				error: "Invalid token format. GitHub tokens should start with 'ghp_' or 'github_pat_'",
			};
		}

		// Test the connection by getting authenticated user
		const response = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Fabric-Workflow-Builder",
			},
		});

		if (response.ok) {
			const user = await response.json();
			return {
				success: true,
				message: `GitHub connection successful. Authenticated as ${user.login}`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid or expired token. Please check your GitHub token.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `GitHub returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
