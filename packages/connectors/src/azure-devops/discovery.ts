/**
 * Azure DevOps — Repository Discovery & PAT Validation (request-path helpers)
 *
 * Centralizes the Azure DevOps REST specifics (Basic-auth header
 * `Authorization: Basic base64(":" + pat)`, `dev.azure.com/{org}/_apis/...`)
 * so the oRPC procedures that call them stay thin (see `backend/api.md` —
 * "no business logic in handlers").
 *
 * IMPORTANT: these are SYNCHRONOUS request-path helpers, distinct from the
 * `validateAzureDevOpsPat` *Temporal activity* in
 * `packages/temporal/src/activities/repo-health-check.ts`, which stays for the
 * background health-check path. The API request layer (connect.ts, list-repos)
 * uses these helpers directly so validation happens inline without round-
 * tripping through Temporal.
 *
 * SECURITY: the PAT is request-scoped — it is NEVER logged, NEVER returned, and
 * raw Azure DevOps response bodies are NEVER surfaced. Callers map the returned
 * status to a sanitized `ORPCError`.
 */

// ---------------------------------------------------------------------------
// Auth header
// ---------------------------------------------------------------------------

/**
 * Build the Azure DevOps Basic-auth header for a PAT.
 * ADO authenticates a PAT as `base64(":" + pat)` (empty username).
 */
function adoAuthHeader(pat: string): string {
	return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single Azure DevOps repository, shaped to match what the wizard repo
 * pickers consume (parity with the GitHub/GitLab repo shapes). `fullName` and
 * `htmlUrl` are the canonical `dev.azure.com/{org}/{project}/_git/{repo}` web
 * URL so `parseRepoUrl` + `extractAdoProject` resolve org + project + repo.
 */
export interface AzureDevOpsRepo {
	/** Repository name (e.g. "my-repo"). */
	name: string;
	/** Owning Azure DevOps project name (e.g. "MyProject"). */
	projectName: string;
	/** Canonical web URL — used as the stable identifier for the repo. */
	fullName: string;
	/** Canonical `dev.azure.com/{org}/{project}/_git/{repo}` web URL. */
	htmlUrl: string;
	/** Default branch short name (e.g. "main"), if known. */
	defaultBranch?: string;
	/** Whether the repo is private (ADO repos are private by default). */
	isPrivate?: boolean;
	/** Language is not exposed by the ADO repo list — always null. */
	language: null;
	/** Optional role tag (e.g. "Legacy", "Primary"). */
	roleTag?: string | null;
}

/** Repos grouped by their owning Azure DevOps project (parity with GitHub owner-grouping). */
export interface AzureDevOpsRepoGroup {
	/** The ADO project name (the "owner" bucket for the picker). */
	owner: string;
	repos: AzureDevOpsRepo[];
}

/** Result shape consumed by the wizard repo pickers (parity with the GitHub/GitLab list result). */
export interface ListAzureDevOpsReposResult {
	configured: boolean;
	organization: string | null;
	groups: AzureDevOpsRepoGroup[];
	error: string | null;
}

/** Typed ok/status result — callers decide the ORPCError; the helper never throws on auth failure. */
export type ValidateAzureDevOpsPatResult =
	| { ok: true }
	| { ok: false; status: number };

// ---------------------------------------------------------------------------
// Internal ADO REST response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface AdoProjectRaw {
	id: string;
	name: string;
}

interface AdoRepoRaw {
	id: string;
	name: string;
	defaultBranch?: string;
	project?: { name?: string };
}

const ADO_API_VERSION = "7.1";

// ---------------------------------------------------------------------------
// PAT validation
// ---------------------------------------------------------------------------

/**
 * Validate an Azure DevOps PAT against an organization by hitting
 * `GET https://dev.azure.com/{organization}/_apis/connectionData`.
 *
 * Returns a typed ok/status result — it does NOT throw on an auth failure so
 * the calling procedure can map the status to the appropriate `ORPCError`
 * (e.g. 401/403 → `BAD_REQUEST` "Invalid PAT or insufficient permissions").
 *
 * Reused by both `connect.ts` and `azure-devops/list-repos.ts`.
 */
export async function validateAzureDevOpsPat({
	organization,
	pat,
}: {
	organization: string;
	pat: string;
}): Promise<ValidateAzureDevOpsPatResult> {
	const response = await fetch(
		`https://dev.azure.com/${organization}/_apis/connectionData`,
		{
			headers: {
				Authorization: adoAuthHeader(pat),
			},
		},
	);

	if (response.ok) {
		return { ok: true };
	}

	return { ok: false, status: response.status };
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

/**
 * Build the canonical `dev.azure.com/{org}/{project}/_git/{repo}` web URL.
 *
 * We construct this ourselves (rather than trusting ADO's `webUrl`/`remoteUrl`)
 * so the URL is always in the exact shape `parseRepoUrl` + `extractAdoProject`
 * expect (org=owner, project, repo), regardless of how ADO encodes the segments.
 */
function buildAdoWebUrl(
	organization: string,
	projectName: string,
	repoName: string,
): string {
	return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}`;
}

/** Strip the `refs/heads/` prefix from an ADO default-branch ref, if present. */
export function shortBranchName(ref: string | undefined): string | undefined {
	if (!ref) {
		return undefined;
	}
	return ref.startsWith("refs/heads/")
		? ref.slice("refs/heads/".length)
		: ref;
}

/**
 * List all repositories the PAT can see in an Azure DevOps organization,
 * grouped by their owning ADO project.
 *
 * Flow:
 *   1. `GET /{org}/_apis/projects` to enumerate projects.
 *   2. Per project, `GET /{org}/{project}/_apis/git/repositories` for its repos.
 *
 * The result shape mirrors the GitHub/GitLab pickers. On an auth failure
 * (401/403) it returns `configured: true` with an error string for the caller
 * to map; "no repositories" is NOT an error — it returns empty groups.
 *
 * SECURITY: the PAT is never logged and raw ADO bodies are never surfaced.
 */
export async function listAzureDevOpsProjectsAndRepos({
	organization,
	pat,
}: {
	organization: string;
	pat: string;
}): Promise<ListAzureDevOpsReposResult> {
	const headers = {
		Authorization: adoAuthHeader(pat),
		Accept: "application/json",
	};

	// 1. List projects in the organization.
	const projectsResponse = await fetch(
		`https://dev.azure.com/${organization}/_apis/projects?api-version=${ADO_API_VERSION}`,
		{ headers },
	);

	if (!projectsResponse.ok) {
		const { status } = projectsResponse;
		return {
			configured: true,
			organization,
			groups: [],
			error:
				status === 401 || status === 403
					? "Invalid PAT or insufficient permissions"
					: `Azure DevOps returned status ${status}`,
		};
	}

	const projectsData = (await projectsResponse.json()) as {
		value?: AdoProjectRaw[];
	};
	const projects = projectsData.value ?? [];

	// 2. For each project, list its Git repositories. Group by project name.
	const groups: AzureDevOpsRepoGroup[] = [];

	for (const project of projects) {
		const reposResponse = await fetch(
			`https://dev.azure.com/${organization}/${encodeURIComponent(project.name)}/_apis/git/repositories?api-version=${ADO_API_VERSION}`,
			{ headers },
		);

		if (!reposResponse.ok) {
			// One project failing (e.g. a project the PAT can list but not read
			// repos in) must not abort discovery — skip it and continue.
			continue;
		}

		const reposData = (await reposResponse.json()) as {
			value?: AdoRepoRaw[];
		};
		const rawRepos = reposData.value ?? [];

		if (rawRepos.length === 0) {
			continue;
		}

		const repos: AzureDevOpsRepo[] = rawRepos.map((repo) => {
			const projectName = repo.project?.name ?? project.name;
			const htmlUrl = buildAdoWebUrl(
				organization,
				projectName,
				repo.name,
			);
			return {
				name: repo.name,
				projectName,
				fullName: htmlUrl,
				htmlUrl,
				defaultBranch: shortBranchName(repo.defaultBranch),
				isPrivate: true,
				language: null,
			};
		});

		// Sort repos within a project alphabetically for a stable picker order.
		repos.sort((a, b) => a.name.localeCompare(b.name));

		groups.push({ owner: project.name, repos });
	}

	// Sort groups (projects) alphabetically.
	groups.sort((a, b) => a.owner.localeCompare(b.owner));

	const totalRepos = groups.reduce((sum, g) => sum + g.repos.length, 0);

	return {
		configured: true,
		organization,
		groups,
		error:
			totalRepos === 0
				? "No repositories found in this organization."
				: null,
	};
}
