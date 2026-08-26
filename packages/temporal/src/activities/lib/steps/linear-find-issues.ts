/**
 * Linear Find Issues Step
 * Searches for issues in Linear
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeLinearFindIssuesStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		assignee,
		teamId: configTeamId,
		status,
		label,
	} = params.nodeConfig as {
		assignee?: string;
		teamId?: string;
		status?: string;
		label?: string;
	};

	const credentials = await fetchCredentialsByProvider(
		"LINEAR",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.LINEAR_API_KEY) {
		return {
			success: false,
			error: "Linear API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	try {
		const filter: Record<string, unknown> = {};

		if (assignee) {
			const interpolatedAssignee = interpolateTemplate(
				assignee,
				params.inputs,
			);
			filter.assignee = { id: { eq: interpolatedAssignee } };
		}

		const teamId = configTeamId
			? interpolateTemplate(configTeamId, params.inputs)
			: credentials.LINEAR_TEAM_ID;

		if (teamId) {
			filter.team = { id: { eq: teamId } };
		}

		if (status && status !== "any") {
			filter.state = { name: { eqIgnoreCase: status } };
		}

		if (label) {
			const interpolatedLabel = interpolateTemplate(label, params.inputs);
			filter.labels = { name: { eqIgnoreCase: interpolatedLabel } };
		}

		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: credentials.LINEAR_API_KEY,
			},
			body: JSON.stringify({
				query: `
					query FindIssues($filter: IssueFilter) {
						issues(filter: $filter, first: 50) {
							nodes {
								id
								identifier
								title
								url
								state { name }
								priority
								assignee { id name }
							}
						}
					}
				`,
				variables: { filter },
			}),
		});

		const result = await response.json();

		if (result.errors) {
			return {
				success: false,
				error: result.errors[0]?.message || "Failed to find issues",
			};
		}

		const issues = result.data?.issues?.nodes || [];
		return {
			success: true,
			output: {
				issues: issues.map((issue: Record<string, unknown>) => ({
					id: issue.id,
					identifier: issue.identifier,
					title: issue.title,
					url: issue.url,
					state: (issue.state as Record<string, unknown>)?.name,
					priority: issue.priority,
					assigneeId: (issue.assignee as Record<string, unknown>)?.id,
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
					: "Failed to find Linear issues",
		};
	}
}
