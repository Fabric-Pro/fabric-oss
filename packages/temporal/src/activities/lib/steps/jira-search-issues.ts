import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeJiraSearchIssuesStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { jql, maxResults } = params.nodeConfig as {
		jql?: string;
		maxResults?: string | number;
	};

	if (!jql) {
		return { success: false, error: "JQL query is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"JIRA",
		params.userId,
		params.organizationId,
	);

	if (
		!credentials?.JIRA_DOMAIN ||
		!credentials?.JIRA_EMAIL ||
		!credentials?.JIRA_API_TOKEN
	) {
		return {
			success: false,
			error: "Jira domain, email, and API token are required in Settings > Integrations.",
		};
	}

	const domain = credentials.JIRA_DOMAIN.replace(/^https?:\/\//, "").replace(
		/\/$/,
		"",
	);
	const auth = Buffer.from(
		`${credentials.JIRA_EMAIL}:${credentials.JIRA_API_TOKEN}`,
	).toString("base64");

	try {
		const response = await fetch(
			`https://${domain}/rest/api/3/search/jql`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					jql: interpolateTemplate(jql, params.inputs),
					maxResults: Number(maxResults) || 25,
					fields: ["summary", "status", "issuetype", "project"],
				}),
			},
		);
		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.errorMessages?.[0] ||
					`Jira returned status ${response.status}`,
			};
		}

		const issues = (result.issues as Array<Record<string, unknown>>) ?? [];
		return {
			success: true,
			output: {
				issues: issues.map((issue) => ({
					id: issue.id,
					key: issue.key,
					summary: (issue.fields as Record<string, unknown>)?.summary,
					status: (
						(issue.fields as Record<string, unknown>)?.status as
							| Record<string, unknown>
							| undefined
					)?.name,
					url: `https://${domain}/browse/${issue.key}`,
				})),
				count: issues.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search Jira issues",
		};
	}
}
