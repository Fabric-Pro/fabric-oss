import {
	callMcpWithRestFallback,
	gitlabFetch,
} from "@repo/integrations/gitlab";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	resolveGitLabRestTokenForStep,
	resolveGitLabSourceForStep,
} from "./gitlab-resolver";
import { interpolateTemplate } from "./utils";

export async function executeGitLabSearchIssuesStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { projectId, search, state } = params.nodeConfig as {
		projectId?: string;
		search?: string;
		state?: string;
	};

	if (!projectId || !search) {
		return {
			success: false,
			error: "Project ID and search query are required",
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
	const interpolatedSearch = interpolateTemplate(search, params.inputs);
	const issueState = state || "opened";

	try {
		const result = (await callMcpWithRestFallback({
			source,
			method: "list_issues",
			args: {
				// Pass RAW project_id; the official MCP server expects
				// raw `group/project` or numeric id. REST fallback below
				// encodes once when building the URL.
				project_id: interpolatedProjectId,
				search: interpolatedSearch,
				state: issueState,
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
				return (await gitlabFetch(
					token,
					`/projects/${encodeURIComponent(interpolatedProjectId)}/issues`,
					{
						search: interpolatedSearch,
						state: issueState,
					},
				)) as Array<{
					id: number;
					title: string;
					state: string;
					web_url?: string;
				}>;
			},
		})) as Array<{
			id: number;
			title: string;
			state: string;
			web_url?: string;
		}>;

		if (!Array.isArray(result)) {
			return {
				success: false,
				error: "Unexpected GitLab response (not a list of issues)",
			};
		}

		return {
			success: true,
			output: {
				issues: result.map((issue) => ({
					id: issue.id,
					title: issue.title,
					state: issue.state,
					url: issue.web_url,
				})),
				count: result.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search GitLab issues",
		};
	}
}
