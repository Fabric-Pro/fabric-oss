import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeBitbucketCreateIssueStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { workspace, repoSlug, title, content, kind } = params.nodeConfig as {
		workspace?: string;
		repoSlug?: string;
		title?: string;
		content?: string;
		kind?: string;
	};

	if (!workspace || !repoSlug || !title) {
		return {
			success: false,
			error: "Workspace, repository slug, and issue title are required",
		};
	}

	const credentials = await fetchCredentialsByProvider(
		"BITBUCKET",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.BITBUCKET_EMAIL || !credentials?.BITBUCKET_API_TOKEN) {
		return {
			success: false,
			error: "Bitbucket email and API token must be configured in Settings > Integrations.",
		};
	}

	const auth = Buffer.from(
		`${credentials.BITBUCKET_EMAIL}:${credentials.BITBUCKET_API_TOKEN}`,
	).toString("base64");

	try {
		const response = await fetch(
			`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(interpolateTemplate(workspace, params.inputs))}/${encodeURIComponent(interpolateTemplate(repoSlug, params.inputs))}/issues`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					title: interpolateTemplate(title, params.inputs),
					content: content
						? { raw: interpolateTemplate(content, params.inputs) }
						: undefined,
					kind: kind || "task",
				}),
			},
		);

		const result = (await response.json()) as {
			id?: number;
			links?: { html?: { href?: string } };
			title?: string;
			error?: { message?: string };
			type?: string;
		};

		if (!response.ok) {
			return {
				success: false,
				error:
					result.error?.message ||
					`Bitbucket returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				issueId: result.id,
				issueUrl: result.links?.html?.href,
				title: result.title,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Bitbucket issue",
		};
	}
}
