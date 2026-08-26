/**
 * Repo compare glue — resolve a project repository integration into the
 * provider-agnostic `compareRepositoryCommits` args and run the compare.
 *
 * The connectors facade takes explicit `{ owner, repo, azureProject }`; this is
 * the thin API-layer adapter that derives them from a stored integration row
 * (ADO org/project come from the repository URL). Shared by the "pending
 * changes" read and the manual incremental re-index so both compute the
 * indexed-commit → branch-HEAD diff identically.
 */

import {
	type CompareCommitsResult,
	compareRepositoryCommits,
	parseAdoRepositoryUrl,
} from "@repo/connectors";

/** The subset of a `ProjectRepositoryIntegration` row the compare needs. */
export interface RepoCompareRef {
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	repositoryOwner: string;
	repositoryName: string;
	repositoryUrl: string;
	azureOrganization: string | null;
}

/**
 * Resolve the provider-agnostic compare target. For Azure DevOps the API
 * `owner` is the org and the project comes from the repository URL (falling back
 * to the stored `azureOrganization`); GitHub/GitLab use owner/name directly.
 */
function toCompareTarget(repo: RepoCompareRef): {
	owner: string;
	repo: string;
	azureProject?: string;
} {
	if (repo.provider === "AZURE_DEVOPS") {
		const parsed = parseAdoRepositoryUrl(repo.repositoryUrl);
		return {
			owner:
				repo.azureOrganization ??
				parsed?.organization ??
				repo.repositoryOwner,
			repo: repo.repositoryName,
			azureProject: parsed?.project,
		};
	}
	return { owner: repo.repositoryOwner, repo: repo.repositoryName };
}

/**
 * Compare a repo's indexed commit (`base`) to its branch HEAD (`head`). Never
 * throws — the connectors facade degrades any failure to `status: "unknown"`.
 */
export async function compareIndexedCommitToHead(params: {
	repo: RepoCompareRef;
	token: string;
	base: string;
	head: string;
}): Promise<CompareCommitsResult> {
	const target = toCompareTarget(params.repo);
	return compareRepositoryCommits({
		provider: params.repo.provider,
		token: params.token,
		owner: target.owner,
		repo: target.repo,
		base: params.base,
		head: params.head,
		azureProject: target.azureProject,
	});
}
