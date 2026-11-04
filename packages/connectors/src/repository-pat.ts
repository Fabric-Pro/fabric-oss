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

export type GitHubTokenAccount =
	| {
			ok: true;
			id: string;
			login: string;
			scopes: string[];
			/**
			 * `classic` when GitHub sent the `X-OAuth-Scopes` header (a classic
			 * token or an OAuth grant, whose scopes are then known), otherwise
			 * `fine-grained`: its permissions cannot be read up front.
			 */
			tokenType: "classic" | "fine-grained";
	  }
	| { ok: false; status?: number };

const GITHUB_HEADERS = (pat: string) => ({
	Authorization: `Bearer ${pat}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
});

/**
 * The GitHub account a token acts as: `GET /user` gives its id and login, and
 * the `X-OAuth-Scopes` header its classic scopes. A fine-grained token sends
 * no such header; its scopes are then an empty list. Never throws for a
 * provider answer; a transport failure propagates to the caller.
 */
export async function readGitHubTokenAccount({
	pat,
	signal,
}: {
	pat: string;
	signal?: AbortSignal;
}): Promise<GitHubTokenAccount> {
	const response = await fetch("https://api.github.com/user", {
		headers: GITHUB_HEADERS(pat),
		signal,
	});
	if (!response.ok) {
		return { ok: false, status: response.status };
	}
	const body = (await response.json()) as { id?: unknown; login?: unknown };
	if (
		(typeof body.id !== "number" && typeof body.id !== "string") ||
		typeof body.login !== "string" ||
		body.login === ""
	) {
		return { ok: false };
	}
	const header = response.headers.get("x-oauth-scopes");
	const scopes = (header ?? "")
		.split(",")
		.map((scope) => scope.trim())
		.filter((scope) => scope !== "");
	return {
		ok: true,
		id: String(body.id),
		login: body.login,
		scopes,
		tokenType: header === null ? "fine-grained" : "classic",
	};
}

/**
 * Whether the token may list the repositories it reaches
 * (`GET /user/repos?per_page=1`): a cheap, read-only probe of a fine-grained
 * token, whose permissions GitHub does not report. Never throws for a
 * provider answer; a transport failure propagates to the caller.
 */
export async function canGitHubTokenListRepositories({
	pat,
	signal,
}: {
	pat: string;
	signal?: AbortSignal;
}): Promise<boolean> {
	const response = await fetch(
		"https://api.github.com/user/repos?per_page=1",
		{ headers: GITHUB_HEADERS(pat), signal },
	);
	return response.ok;
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
