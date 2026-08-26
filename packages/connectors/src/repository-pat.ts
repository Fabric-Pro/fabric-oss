/**
 * Personal-access-token validators for GitHub and GitLab repository
 * integrations (request path). Mirror `validateAzureDevOpsPat`: hit a cheap
 * authenticated endpoint and return a typed ok/status result WITHOUT throwing,
 * so the calling procedure maps the status to the right `ORPCError`.
 *
 * These let a project connect a GitHub/GitLab repo with a scoped PAT (e.g. one
 * carrying `Actions: read` / `read_api`) instead of OAuth — the same path Azure
 * DevOps already uses. The GitHub App's OAuth token is Contents-scoped for code
 * indexing and cannot read Actions, so a PAT is the reliable way to pull CI
 * pipeline results.
 */

export interface ValidateRepoPatResult {
	ok: boolean;
	status?: number;
}

/**
 * Validate a GitHub PAT by calling `GET https://api.github.com/repos/{owner}/{repo}`
 * to verify the token can read the specific repository. (Actions: read scope is
 * surfaced later at fetch time).
 */
export async function validateGitHubPat({
	pat,
	owner,
	repo,
}: {
	pat: string;
	owner: string;
	repo: string;
}): Promise<ValidateRepoPatResult> {
	const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

	const response = await fetch(endpoint, {
		headers: {
			Authorization: `Bearer ${pat}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	return response.ok ? { ok: true } : { ok: false, status: response.status };
}

/**
 * Validate a GitLab PAT by calling `GET {host}/api/v4/projects/{path}` with the
 * `PRIVATE-TOKEN` header — i.e. can this token READ THE REPO we're connecting.
 *
 * Deliberately NOT `/api/v4/user`: that endpoint needs the `User: Read`
 * permission, which is unrelated to reading CI. A least-privilege GitLab
 * fine-grained token scoped for repo/pipeline reads (but not user reads) 403s on
 * `/user` even though it can read exactly what pipeline results needs — so
 * `/user` wrongly rejects the correct token. `/projects/{path}` is the endpoint
 * `resolveDefaultBranch` already calls (Project: Read); `Pipeline: Read` is
 * surfaced later at fetch time, mirroring how the GitHub validator leaves
 * `Actions: read` to the fetch.
 *
 * `host` is passed by the caller; the connect procedure pins it to
 * `https://gitlab.com` (and rejects other hosts) to avoid pointing this
 * authenticated request at an internal host. `projectPath` is the repo's full
 * path (`group/subgroup/project`) — the caller derives it from `parseRepoUrl`.
 */
export async function validateGitLabPat({
	pat,
	host,
	projectPath,
}: {
	pat: string;
	host: string;
	projectPath: string;
}): Promise<ValidateRepoPatResult> {
	const base = host.replace(/\/$/, "");
	const project = encodeURIComponent(projectPath);
	const response = await fetch(`${base}/api/v4/projects/${project}`, {
		headers: { "PRIVATE-TOKEN": pat },
	});
	return response.ok ? { ok: true } : { ok: false, status: response.status };
}
