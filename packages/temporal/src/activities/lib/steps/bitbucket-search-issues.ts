import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeBitbucketSearchIssuesStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { workspace, repoSlug, query, state } = params.nodeConfig as {
		workspace?: string;
		repoSlug?: string;
		query?: string;
		state?: string;
	};

	if (!workspace || !repoSlug || !query) {
		return {
			success: false,
			error: "Workspace, repository slug, and search query are required",
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
	const bbql = `title ~ "${interpolateTemplate(query, params.inputs).replace(/"/g, '\\"')}"${state ? ` AND state = "${state}"` : ""}`;
	const url = new URL(
		`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(interpolateTemplate(workspace, params.inputs))}/${encodeURIComponent(interpolateTemplate(repoSlug, params.inputs))}/issues`,
	);
	url.searchParams.set("q", bbql);

	try {
		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Basic ${auth}`,
				Accept: "application/json",
			},
		});

		const result = (await response.json()) as {
			values?: Array<{
				id: number;
				title: string;
				state?: string;
				links?: { html?: { href?: string } };
			}>;
			error?: { message?: string };
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
				issues: (result.values ?? []).map((issue) => ({
					id: issue.id,
					title: issue.title,
					state: issue.state,
					url: issue.links?.html?.href,
				})),
				count: result.values?.length ?? 0,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search Bitbucket issues",
		};
	}
}
