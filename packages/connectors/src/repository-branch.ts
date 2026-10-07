import { shortBranchName } from "./azure-devops/discovery";
import {
	azureDevOpsHeaders,
	gitlabHeaders,
	gitlabHost,
	parseAdoRepositoryUrl,
} from "./repository-address";
import {
	AZURE_DEVOPS_API_VERSION,
	getRepositoryJson,
	isRecord,
	repositoryApiTarget,
} from "./repository-api";

export {
	gitlabHeaders,
	gitlabHost,
	parseAdoRepositoryUrl,
} from "./repository-address";

/**
 * Remote branch verification (request-path helper)
 *
 * Confirms a branch exists on the remote BEFORE a project repository
 * integration starts monitoring it, using the PROJECT integration's stored
 * credentials (decrypted by the caller — this module never touches the DB).
 * Lives beside `validateAzureDevOpsPat` as the request-path home for
 * provider REST specifics, keeping the calling oRPC procedure thin per
 * `backend/api.md`.
 *
 * Outcomes are a closed set the caller maps to sanitized errors:
 *  - "exists"       — the branch is on the remote.
 *  - "not-found"    — the remote answered but the branch (or repo) is absent.
 *  - "unauthorized" — the stored credential was rejected (401/403).
 *  - "unreachable"  — network failure or a 5xx-class upstream error.
 *
 * SECURITY: the token is request-scoped — NEVER logged, NEVER returned — and
 * raw provider response bodies are never surfaced. The helper never throws.
 */

export type BranchVerifyOutcome =
	| "exists"
	| "not-found"
	| "unauthorized"
	| "unreachable";

export interface VerifyRepositoryBranchInput {
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	/** Decrypted access token or PAT (request-scoped, never logged). */
	token: string;
	/** Canonical repository URL — ADO org/project come from it. */
	repositoryUrl: string;
	owner: string;
	repo: string;
	azureOrganization?: string | null;
	/**
	 * GitLab authenticates OAuth tokens with `Authorization: Bearer` and PATs
	 * with `PRIVATE-TOKEN`; the wrong one reads as a rejected credential and
	 * blocks branch edits for a perfectly good PAT. Every other provider takes
	 * the token as a Bearer header regardless.
	 */
	gitlabAuth?: "bearer" | "private-token";
	/** Azure DevOps PATs use Basic; OAuth access tokens use Bearer. */
	azureDevOpsAuth?: "basic" | "bearer";
	branch: string;
	signal?: AbortSignal;
}

const ADO_API_VERSION = "7.1";

/** Map an HTTP status to an outcome shared by all three providers. */
function outcomeFromStatus(
	status: number,
): Exclude<BranchVerifyOutcome, "exists"> {
	if (status === 401 || status === 403) {
		return "unauthorized";
	}
	if (status === 404) {
		return "not-found";
	}
	return "unreachable";
}

async function verifyGitHubBranch(
	input: VerifyRepositoryBranchInput,
): Promise<BranchVerifyOutcome> {
	const url = `https://api.github.com/repos/${encodeURIComponent(
		input.owner,
	)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(
		input.branch,
	)}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${input.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (response.ok) {
		return "exists";
	}
	return outcomeFromStatus(response.status);
}

async function verifyGitLabBranch(
	input: VerifyRepositoryBranchInput,
): Promise<BranchVerifyOutcome> {
	const host = gitlabHost();
	const projectPath = encodeURIComponent(`${input.owner}/${input.repo}`);
	const url = `${host}/api/v4/projects/${projectPath}/repository/branches/${encodeURIComponent(
		input.branch,
	)}`;
	const response = await fetch(url, {
		headers: gitlabHeaders(input),
	});
	if (response.ok) {
		return "exists";
	}
	return outcomeFromStatus(response.status);
}

/** Extract org + project + API host from an Azure DevOps repository URL. */
async function verifyAzureDevOpsBranch(
	input: VerifyRepositoryBranchInput,
): Promise<BranchVerifyOutcome> {
	const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
	const organization = parsed?.organization ?? input.azureOrganization;
	if (!organization) {
		// Without an organization there is no API to ask — treat as unreachable
		// (a config problem, not a missing branch).
		return "unreachable";
	}
	const host = parsed?.host ?? "https://dev.azure.com";
	const projectSegment = parsed
		? `/${encodeURIComponent(parsed.project)}`
		: "";
	// Repository names are stored RAW from the connect URL — a browser-copied
	// "My%20Repo" is already percent-encoded, and encoding it again would
	// double-encode to "My%2520Repo" (ADO 404 → misleading branch-not-found).
	// Decode first (a plain name is unchanged), then encode exactly once.
	let repoName: string;
	try {
		repoName = decodeURIComponent(input.repo);
	} catch {
		repoName = input.repo;
	}
	// `filter=heads/{branch}` is a PREFIX match, so the response is checked for
	// the exact ref below (heads/main must not be satisfied by main-backup).
	const params = new URLSearchParams({
		filter: `heads/${input.branch}`,
		"api-version": ADO_API_VERSION,
	});
	const url = `${host}/${encodeURIComponent(
		organization,
	)}${projectSegment}/_apis/git/repositories/${encodeURIComponent(
		repoName,
	)}/refs?${params.toString()}`;
	const response = await fetch(url, {
		headers: azureDevOpsHeaders(input),
	});
	// ADO answers an invalid/expired PAT with a 203 + HTML sign-in page rather
	// than a clean 401 — treat it as the credential failure it is.
	if (response.status === 203) {
		return "unauthorized";
	}
	if (!response.ok) {
		return outcomeFromStatus(response.status);
	}
	const data = (await response.json()) as {
		value?: Array<{ name?: string }>;
	};
	const expectedRef = `refs/heads/${input.branch}`;
	const found = (data.value ?? []).some((ref) => ref.name === expectedRef);
	return found ? "exists" : "not-found";
}

/**
 * Verify `branch` exists on the remote repository. Never throws — network and
 * parse failures resolve as `"unreachable"`. Branch names with slashes (e.g.
 * `release/1.2`) are URL-encoded per path segment so they survive routing.
 */
export async function verifyRepositoryBranch(
	input: VerifyRepositoryBranchInput,
): Promise<BranchVerifyOutcome> {
	try {
		switch (input.provider) {
			case "GITHUB":
				return await verifyGitHubBranch(input);
			case "GITLAB":
				return await verifyGitLabBranch(input);
			case "AZURE_DEVOPS":
				return await verifyAzureDevOpsBranch(input);
			default:
				return "unreachable";
		}
	} catch {
		return "unreachable";
	}
}

const BRANCH_HEAD_TIMEOUT_MS = 15_000;

export type ResolveRepositoryBranchHeadResult =
	| { ok: true; commitSha: string }
	| { ok: false; outcome: Exclude<BranchVerifyOutcome, "exists"> };

function missingBranchHead(): ResolveRepositoryBranchHeadResult {
	return { ok: false, outcome: "unreachable" };
}

/**
 * Resolve one configured branch's current commit without walking the bounded
 * branch-picker pages. This is the commit pin for direct reads, so an exact
 * ref is required even where a provider's branch filter is prefix-based.
 */
export async function resolveRepositoryBranchHead(
	input: VerifyRepositoryBranchInput,
): Promise<ResolveRepositoryBranchHeadResult> {
	try {
		const target = repositoryApiTarget(input);
		if (!target) {
			return missingBranchHead();
		}
		const options = { timeoutMs: BRANCH_HEAD_TIMEOUT_MS };
		switch (input.provider) {
			case "GITHUB": {
				const response = await getRepositoryJson(
					target,
					`/branches/${encodeURIComponent(input.branch)}`,
					options,
				);
				if (!response.ok) {
					return response;
				}
				const commit = isRecord(response.data)
					? response.data.commit
					: null;
				return isRecord(commit) && typeof commit.sha === "string"
					? { ok: true, commitSha: commit.sha }
					: missingBranchHead();
			}
			case "GITLAB": {
				const response = await getRepositoryJson(
					target,
					`/repository/branches/${encodeURIComponent(input.branch)}`,
					options,
				);
				if (!response.ok) {
					return response;
				}
				const commit = isRecord(response.data)
					? response.data.commit
					: null;
				return isRecord(commit) && typeof commit.id === "string"
					? { ok: true, commitSha: commit.id }
					: missingBranchHead();
			}
			case "AZURE_DEVOPS": {
				const params = new URLSearchParams({
					filter: `heads/${input.branch}`,
					"api-version": AZURE_DEVOPS_API_VERSION,
				});
				const response = await getRepositoryJson(
					target,
					`/refs?${params.toString()}`,
					options,
				);
				if (!response.ok) {
					return response;
				}
				const expected = `refs/heads/${input.branch}`;
				const refs = isRecord(response.data)
					? response.data.value
					: null;
				if (!Array.isArray(refs)) {
					return missingBranchHead();
				}
				const ref = refs.find(
					(item) => isRecord(item) && item.name === expected,
				);
				if (ref === undefined) {
					return { ok: false, outcome: "not-found" };
				}
				return isRecord(ref) && typeof ref.objectId === "string"
					? { ok: true, commitSha: ref.objectId }
					: missingBranchHead();
			}
			default: {
				const unreachable: never = input.provider;
				return unreachable;
			}
		}
	} catch {
		return missingBranchHead();
	}
}

// ── List branches ────────────────────────────────────────────────────────────

/** Max branch names returned (and the per-page size) — bounds large repos. */
const MAX_BRANCHES = 300;
const BRANCH_PAGE_SIZE = 100;

export type ListRepositoryBranchesInput = Omit<
	VerifyRepositoryBranchInput,
	"branch"
>;

/**
 * One listed branch: its name plus the remote HEAD commit SHA. `commitSha` is
 * `null` when the provider payload omits it — never dropped, so the caller can
 * compare it against a stored checkpoint SHA to detect a stale scan.
 */
export interface RepositoryBranchRef {
	name: string;
	commitSha: string | null;
}

/**
 * Result of a branch listing: `ok` with the branches (name + HEAD SHA), or
 * `ok:false` with the same closed outcome set the verify path uses (so the
 * caller maps a sanitized error). Like the verify helper, this NEVER throws and
 * never surfaces raw token material or upstream bodies.
 */
export type ListRepositoryBranchesResult =
	| { ok: true; branches: RepositoryBranchRef[] }
	| { ok: false; outcome: BranchVerifyOutcome };

async function listGitHubBranches(
	input: ListRepositoryBranchesInput,
): Promise<ListRepositoryBranchesResult> {
	const branches: RepositoryBranchRef[] = [];
	for (let page = 1; branches.length < MAX_BRANCHES; page++) {
		const url = `https://api.github.com/repos/${encodeURIComponent(
			input.owner,
		)}/${encodeURIComponent(
			input.repo,
		)}/branches?per_page=${BRANCH_PAGE_SIZE}&page=${page}`;
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) {
			return { ok: false, outcome: outcomeFromStatus(response.status) };
		}
		const page_ = (await response.json()) as Array<{
			name?: string;
			commit?: { sha?: string };
		}>;
		for (const b of page_) {
			if (b.name) {
				branches.push({
					name: b.name,
					commitSha: b.commit?.sha ?? null,
				});
			}
		}
		if (page_.length < BRANCH_PAGE_SIZE) {
			break;
		}
	}
	return { ok: true, branches };
}

async function listGitLabBranches(
	input: ListRepositoryBranchesInput,
): Promise<ListRepositoryBranchesResult> {
	const host = gitlabHost();
	const projectPath = encodeURIComponent(`${input.owner}/${input.repo}`);
	const branches: RepositoryBranchRef[] = [];
	for (let page = 1; branches.length < MAX_BRANCHES; page++) {
		const url = `${host}/api/v4/projects/${projectPath}/repository/branches?per_page=${BRANCH_PAGE_SIZE}&page=${page}`;
		const response = await fetch(url, {
			headers: gitlabHeaders(input),
		});
		if (!response.ok) {
			return { ok: false, outcome: outcomeFromStatus(response.status) };
		}
		const page_ = (await response.json()) as Array<{
			name?: string;
			commit?: { id?: string };
		}>;
		for (const b of page_) {
			if (b.name) {
				branches.push({
					name: b.name,
					commitSha: b.commit?.id ?? null,
				});
			}
		}
		if (page_.length < BRANCH_PAGE_SIZE) {
			break;
		}
	}
	return { ok: true, branches };
}

async function listAzureDevOpsBranches(
	input: ListRepositoryBranchesInput,
): Promise<ListRepositoryBranchesResult> {
	const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
	const organization = parsed?.organization ?? input.azureOrganization;
	if (!organization) {
		return { ok: false, outcome: "unreachable" };
	}
	const host = parsed?.host ?? "https://dev.azure.com";
	const projectSegment = parsed
		? `/${encodeURIComponent(parsed.project)}`
		: "";
	let repoName: string;
	try {
		repoName = decodeURIComponent(input.repo);
	} catch {
		repoName = input.repo;
	}
	const params = new URLSearchParams({
		filter: "heads/",
		"api-version": ADO_API_VERSION,
		$top: String(MAX_BRANCHES),
	});
	const url = `${host}/${encodeURIComponent(
		organization,
	)}${projectSegment}/_apis/git/repositories/${encodeURIComponent(
		repoName,
	)}/refs?${params.toString()}`;
	const response = await fetch(url, {
		headers: azureDevOpsHeaders(input),
	});
	if (response.status === 203) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (!response.ok) {
		return { ok: false, outcome: outcomeFromStatus(response.status) };
	}
	const data = (await response.json()) as {
		value?: Array<{ name?: string; objectId?: string }>;
	};
	const branches = (data.value ?? [])
		.map((ref) => ({
			name: ref.name ?? "",
			commitSha: ref.objectId ?? null,
		}))
		.filter((b) => b.name.startsWith("refs/heads/"))
		.map((b) => ({
			name: b.name.slice("refs/heads/".length),
			commitSha: b.commitSha,
		}))
		.filter((b) => b.name.length > 0);
	return { ok: true, branches };
}

/**
 * List the remote repository's branch names. Never throws — network/parse
 * failures resolve to `{ ok: false, outcome: "unreachable" }`. The caller
 * decorates each name with default/pinned flags.
 */
export async function listRepositoryBranches(
	input: ListRepositoryBranchesInput,
): Promise<ListRepositoryBranchesResult> {
	try {
		switch (input.provider) {
			case "GITHUB":
				return await listGitHubBranches(input);
			case "GITLAB":
				return await listGitLabBranches(input);
			case "AZURE_DEVOPS":
				return await listAzureDevOpsBranches(input);
			default:
				return { ok: false, outcome: "unreachable" };
		}
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
}

// Resolve default branch

export interface ResolveDefaultBranchInput {
	providedBranch?: string | null;
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	token: string;
	repositoryUrl: string;
	owner: string;
	repo: string;
	azureOrganization?: string | null;
	gitlabAuth?: "bearer" | "private-token";
	azureDevOpsAuth?: "basic" | "bearer";
}

async function resolveGitHubDefaultBranch(
	input: ResolveDefaultBranchInput,
): Promise<string | null> {
	const url = `https://api.github.com/repos/${encodeURIComponent(
		input.owner,
	)}/${encodeURIComponent(input.repo)}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${input.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: AbortSignal.timeout(5000),
	});
	if (response.ok) {
		const data = (await response.json()) as { default_branch?: string };
		return data.default_branch || null;
	}
	return null;
}

async function resolveGitLabDefaultBranch(
	input: ResolveDefaultBranchInput,
): Promise<string | null> {
	const host = gitlabHost();
	const projectPath = encodeURIComponent(`${input.owner}/${input.repo}`);
	const url = `${host}/api/v4/projects/${projectPath}`;
	const response = await fetch(url, {
		headers: gitlabHeaders(input),
		signal: AbortSignal.timeout(5000),
	});
	if (response.ok) {
		const data = (await response.json()) as { default_branch?: string };
		return data.default_branch || null;
	}
	return null;
}

async function resolveAzureDevOpsDefaultBranch(
	input: ResolveDefaultBranchInput,
): Promise<string | null> {
	const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
	const organization = parsed?.organization ?? input.azureOrganization;
	if (!organization) {
		return null;
	}
	const host = parsed?.host ?? "https://dev.azure.com";
	const projectSegment = parsed
		? `/${encodeURIComponent(parsed.project)}`
		: "";
	let repoName: string;
	try {
		repoName = decodeURIComponent(input.repo);
	} catch {
		repoName = input.repo;
	}
	const url = `${host}/${encodeURIComponent(
		organization,
	)}${projectSegment}/_apis/git/repositories/${encodeURIComponent(
		repoName,
	)}?api-version=${ADO_API_VERSION}`;
	const response = await fetch(url, {
		headers: azureDevOpsHeaders(input),
		signal: AbortSignal.timeout(5000),
	});
	// ADO answers a bad/expired PAT with 203 + an HTML sign-in page (`ok` is true
	// for 203): treat it like a 401 and never parse the body.
	if (response.status === 203) {
		return null;
	}
	if (response.ok) {
		const data = (await response.json()) as { defaultBranch?: string };
		return shortBranchName(data.defaultBranch) || null;
	}
	return null;
}

/**
 * Fetch the actual default branch from the provider.
 * Wraps upstream API queries with a 5s timeout and gracefully catches all errors.
 * Returns the provided branch if given, or natively falls back to "main" on any failure.
 */
export async function resolveDefaultBranch(
	input: ResolveDefaultBranchInput,
): Promise<string> {
	if (input.providedBranch) {
		return input.providedBranch;
	}

	try {
		let fetched: string | null = null;
		switch (input.provider) {
			case "GITHUB":
				fetched = await resolveGitHubDefaultBranch(input);
				break;
			case "GITLAB":
				fetched = await resolveGitLabDefaultBranch(input);
				break;
			case "AZURE_DEVOPS":
				fetched = await resolveAzureDevOpsDefaultBranch(input);
				break;
		}
		return fetched || "main";
	} catch (error) {
		console.warn("Failed to resolve default branch; falling back", {
			provider: input.provider,
			repo: input.repo,
			error: error instanceof Error ? error.message : "Unknown error",
		});
		return "main";
	}
}
