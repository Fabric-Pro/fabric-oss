/**
 * GitHub Get Diff Step
 * Retrieves the diff between two commits, branches, or tags in a GitHub repository.
 * Can also fetch the diff for a pull request by PR number.
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeGithubGetDiffStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { owner, repo, base, head, prNumber } = params.nodeConfig as {
		owner?: string;
		repo?: string;
		base?: string;
		head?: string;
		prNumber?: string;
	};

	if (!owner || !repo) {
		return {
			success: false,
			error: "Repository owner and name are required",
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

	const headers = {
		Authorization: `Bearer ${credentials.GITHUB_TOKEN}`,
		"User-Agent": "Fabric-Workflow-Builder",
	};

	try {
		// Pull request diff mode
		if (prNumber) {
			const interpolatedPr = interpolateTemplate(prNumber, params.inputs);
			const prResponse = await fetch(
				`https://api.github.com/repos/${interpolatedOwner}/${interpolatedRepo}/pulls/${interpolatedPr}`,
				{
					headers: {
						...headers,
						Accept: "application/vnd.github.v3.diff",
					},
				},
			);

			if (!prResponse.ok) {
				const json = await prResponse.json().catch(() => ({}));
				return {
					success: false,
					error:
						(json as { message?: string }).message ||
						`HTTP ${prResponse.status}`,
				};
			}

			const diff = await prResponse.text();

			// Also fetch PR metadata for context
			const metaResponse = await fetch(
				`https://api.github.com/repos/${interpolatedOwner}/${interpolatedRepo}/pulls/${interpolatedPr}`,
				{
					headers: {
						...headers,
						Accept: "application/vnd.github.v3+json",
					},
				},
			);
			const meta = metaResponse.ok ? await metaResponse.json() : {};

			return {
				success: true,
				output: {
					diff,
					prNumber: interpolatedPr,
					title: (meta as Record<string, unknown>).title ?? null,
					state: (meta as Record<string, unknown>).state ?? null,
					additions:
						(meta as Record<string, unknown>).additions ?? null,
					deletions:
						(meta as Record<string, unknown>).deletions ?? null,
					changedFiles:
						(meta as Record<string, unknown>).changed_files ?? null,
				},
			};
		}

		// Commit/branch compare mode
		if (!base || !head) {
			return {
				success: false,
				error: "Provide either a PR number or both base and head refs to compare",
			};
		}

		const interpolatedBase = interpolateTemplate(base, params.inputs);
		const interpolatedHead = interpolateTemplate(head, params.inputs);

		const response = await fetch(
			`https://api.github.com/repos/${interpolatedOwner}/${interpolatedRepo}/compare/${interpolatedBase}...${interpolatedHead}`,
			{
				headers: {
					...headers,
					Accept: "application/vnd.github.v3.diff",
				},
			},
		);

		if (!response.ok) {
			const json = await response.json().catch(() => ({}));
			return {
				success: false,
				error:
					(json as { message?: string }).message ||
					`HTTP ${response.status}`,
			};
		}

		const diff = await response.text();

		return {
			success: true,
			output: {
				diff,
				base: interpolatedBase,
				head: interpolatedHead,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to get GitHub diff",
		};
	}
}
