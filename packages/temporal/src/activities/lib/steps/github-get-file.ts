/**
 * GitHub Get File Step
 * Retrieves a file from a GitHub repository
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeGithubGetFileStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		owner,
		repo,
		filePath,
		ref = "main",
	} = params.nodeConfig as {
		owner?: string;
		repo?: string;
		filePath?: string;
		ref?: string;
	};

	if (!owner || !repo || !filePath) {
		return {
			success: false,
			error: "Owner, repo, and file path are required",
		};
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
	const interpolatedPath = interpolateTemplate(filePath, params.inputs);
	const interpolatedRef = interpolateTemplate(ref, params.inputs);

	try {
		const response = await fetch(
			`https://api.github.com/repos/${interpolatedOwner}/${interpolatedRepo}/contents/${interpolatedPath}?ref=${interpolatedRef}`,
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

		// Decode base64 content
		const content = result.content
			? Buffer.from(result.content, "base64").toString("utf-8")
			: null;

		return {
			success: true,
			output: {
				content,
				sha: result.sha,
				path: result.path,
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
					: "Failed to get GitHub file",
		};
	}
}
