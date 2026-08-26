/**
 * GitHub Search Issues Step
 * Searches for issues across GitHub repositories
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeGithubSearchIssuesStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query, limit = 10 } = params.nodeConfig as {
		query?: string;
		limit?: number;
	};

	if (!query) {
		return { success: false, error: "Search query is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"GITHUB",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.GITHUB_TOKEN) {
		return {
			success: false,
			error: "GitHub token not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedQuery = interpolateTemplate(query, params.inputs);

	try {
		const response = await fetch(
			`https://api.github.com/search/issues?q=${encodeURIComponent(interpolatedQuery)}&per_page=${limit}`,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${credentials.GITHUB_TOKEN}`,
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "Fabric-Workflow-Builder",
				},
			},
		);

		const result = await response.json();

		if (!response.ok) {
			return {
				success: false,
				error: result.message || `HTTP ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				items: result.items?.map((item: Record<string, unknown>) => ({
					number: item.number,
					title: item.title,
					url: item.html_url,
					state: item.state,
					createdAt: item.created_at,
					user: (item.user as Record<string, unknown>)?.login,
				})),
				totalCount: result.total_count,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search GitHub issues",
		};
	}
}
