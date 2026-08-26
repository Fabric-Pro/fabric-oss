/**
 * GitHub Create Issue Step
 * Creates a new issue in a GitHub repository
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeGithubCreateIssueStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { owner, repo, issueTitle, issueBody, labels, assignees } =
		params.nodeConfig as {
			owner?: string;
			repo?: string;
			issueTitle?: string;
			issueBody?: string;
			labels?: string;
			assignees?: string;
		};

	if (!owner || !repo || !issueTitle) {
		return { success: false, error: "Owner, repo, and title are required" };
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

	const interpolatedOwner = interpolateTemplate(owner, params.inputs);
	const interpolatedRepo = interpolateTemplate(repo, params.inputs);
	const interpolatedTitle = interpolateTemplate(issueTitle, params.inputs);
	const interpolatedBody = issueBody
		? interpolateTemplate(issueBody, params.inputs)
		: undefined;

	try {
		const body: Record<string, unknown> = { title: interpolatedTitle };

		if (interpolatedBody) {
			body.body = interpolatedBody;
		}
		if (labels) {
			body.labels = labels
				.split(",")
				.map((l) => l.trim())
				.filter(Boolean);
		}
		if (assignees) {
			body.assignees = assignees
				.split(",")
				.map((a) => a.trim())
				.filter(Boolean);
		}

		const response = await fetch(
			`https://api.github.com/repos/${interpolatedOwner}/${interpolatedRepo}/issues`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.GITHUB_TOKEN}`,
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "Fabric-Workflow-Builder",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
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
				issueNumber: result.number,
				issueUrl: result.html_url,
				issueId: result.id,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create GitHub issue",
		};
	}
}
