import { callMcpWithRestFallback, gitlabPost } from "@repo/integrations/gitlab";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	resolveGitLabRestTokenForStep,
	resolveGitLabSourceForStep,
} from "./gitlab-resolver";
import { interpolateTemplate } from "./utils";

export async function executeGitLabCreateIssueStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { projectId, title, description, labels } = params.nodeConfig as {
		projectId?: string;
		title?: string;
		description?: string;
		labels?: string;
	};

	if (!projectId || !title) {
		return {
			success: false,
			error: "Project ID and issue title are required",
		};
	}

	const source = await resolveGitLabSourceForStep({
		userId: params.userId,
		organizationId: params.organizationId,
	});

	if (!source) {
		return {
			success: false,
			error: "GitLab not connected. Configure it in Settings > Integrations or connect the official GitLab MCP server.",
		};
	}

	const interpolatedProjectId = interpolateTemplate(projectId, params.inputs);
	const interpolatedTitle = interpolateTemplate(title, params.inputs);
	const interpolatedDescription = description
		? interpolateTemplate(description, params.inputs)
		: undefined;
	const interpolatedLabels = labels
		? interpolateTemplate(labels, params.inputs)
		: undefined;

	try {
		const result = (await callMcpWithRestFallback({
			source,
			method: "create_issue",
			// Write: do not blindly retry over REST on an ambiguous MCP
			// network error — the issue may already have been created
			// server-side, and a REST retry would duplicate it.
			idempotent: false,
			args: {
				// Pass RAW project_id; the official MCP server expects
				// either a numeric id or `group/project`, NOT URL-encoded
				// `group%2Fproject`. The REST fallback below encodes once
				// when building the URL path.
				project_id: interpolatedProjectId,
				title: interpolatedTitle,
				description: interpolatedDescription,
				labels: interpolatedLabels,
			},
			restFallback: async () => {
				const token =
					source.kind === "rest-adapter"
						? source.token
						: await resolveGitLabRestTokenForStep({
								userId: params.userId,
								organizationId: params.organizationId,
							});
				if (!token) {
					throw new Error(
						"GitLab REST fallback unavailable: connect a GitLab integration in Settings",
					);
				}
				const body: Record<string, unknown> = {
					title: interpolatedTitle,
				};
				if (interpolatedDescription !== undefined) {
					body.description = interpolatedDescription;
				}
				if (interpolatedLabels !== undefined) {
					body.labels = interpolatedLabels;
				}
				return (await gitlabPost(
					token,
					`/projects/${encodeURIComponent(interpolatedProjectId)}/issues`,
					body,
				)) as {
					id?: number;
					web_url?: string;
					title?: string;
				};
			},
		})) as {
			id?: number;
			web_url?: string;
			title?: string;
			structuredContent?: {
				url?: string;
				title?: string;
				number?: number;
			};
		};

		// MCP path may wrap the issue in `structuredContent`; normalise.
		const issueId = result.structuredContent?.number ?? result.id;
		const issueUrl = result.structuredContent?.url ?? result.web_url;
		const issueTitle = result.structuredContent?.title ?? result.title;

		return {
			success: true,
			output: {
				issueId,
				issueUrl,
				title: issueTitle,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create GitLab issue",
		};
	}
}
