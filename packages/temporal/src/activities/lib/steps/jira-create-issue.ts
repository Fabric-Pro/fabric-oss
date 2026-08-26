import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeJiraCreateIssueStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { projectKey, summary, description, issueType } =
		params.nodeConfig as {
			projectKey?: string;
			summary?: string;
			description?: string;
			issueType?: string;
		};

	if (!projectKey || !summary) {
		return {
			success: false,
			error: "Project key and summary are required",
		};
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
		const response = await fetch(`https://${domain}/rest/api/3/issue`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${auth}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				fields: {
					project: {
						key: interpolateTemplate(projectKey, params.inputs),
					},
					summary: interpolateTemplate(summary, params.inputs),
					issuetype: { name: issueType || "Task" },
					description: description
						? {
								type: "doc",
								version: 1,
								content: [
									{
										type: "paragraph",
										content: [
											{
												type: "text",
												text: interpolateTemplate(
													description,
													params.inputs,
												),
											},
										],
									},
								],
							}
						: undefined,
				},
			}),
		});

		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.errorMessages?.[0] ||
					result?.errors?.summary ||
					`Jira returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				issueKey: result.key,
				issueId: result.id,
				issueUrl: `https://${domain}/browse/${result.key}`,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Jira issue",
		};
	}
}
