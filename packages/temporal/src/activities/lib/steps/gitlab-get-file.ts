/**
 * GitLab Get File Step
 * Retrieves a file from a GitLab repository via the resolved source
 * (official MCP if connected, otherwise REST).
 */

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

export async function executeGitLabGetFileStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		projectId,
		filePath,
		ref = "main",
	} = params.nodeConfig as {
		projectId?: string;
		filePath?: string;
		ref?: string;
	};

	if (!projectId || !filePath) {
		return {
			success: false,
			error: "Project ID and file path are required",
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
	const interpolatedPath = interpolateTemplate(filePath, params.inputs);
	const interpolatedRef = interpolateTemplate(ref, params.inputs);

	try {
		const result = (await callMcpWithRestFallback({
			source,
			method: "get_file_contents",
			args: {
				// Pass RAW values; the official MCP server expects raw
				// `group/project` and raw paths. The REST fallback below
				// encodes both once when building the URL.
				project_id: interpolatedProjectId,
				file_path: interpolatedPath,
				ref: interpolatedRef,
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
					`/projects/${encodeURIComponent(interpolatedProjectId)}/repository/files/${encodeURIComponent(interpolatedPath)}`,
					{ ref: interpolatedRef },
				)) as {
					content?: string;
					file_name?: string;
					file_path?: string;
					size?: number;
					encoding?: string;
					blob_id?: string;
				};
			},
		})) as {
			content?: string;
			file_name?: string;
			file_path?: string;
			size?: number;
			encoding?: string;
			blob_id?: string;
		};

		// Decode base64 content (GitLab returns base64 for repo files)
		const content =
			result.content && (!result.encoding || result.encoding === "base64")
				? Buffer.from(result.content, "base64").toString("utf-8")
				: (result.content ?? null);

		return {
			success: true,
			output: {
				content,
				sha: result.blob_id,
				path: result.file_path,
				size: result.size,
				encoding: result.encoding,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to get GitLab file",
		};
	}
}
