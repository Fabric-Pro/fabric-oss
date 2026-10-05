/**
 * Code Search — Unified Entry Point
 *
 * Provider-agnostic facade for searching code in repositories, fetching file
 * contents, listing directory trees, and comparing an indexed commit to the
 * current branch HEAD. Delegates to the appropriate provider implementation
 * (GitHub, GitLab, Azure DevOps) based on the `provider` field in the params.
 */

import {
	type CodeSearchResponse,
	errorClassName,
	type FileContentResult,
	type GetFileParams,
	getGitHubFile,
	type ListStructureParams,
	listGitHubStructure,
	notAFileError,
	type RepositoryObjectType,
	type RepositoryReadError,
	type RepositoryStructure,
	readErrorFromException,
	readErrorFromResponse,
	readErrorLogFields,
	type SearchCodeParams,
	searchGitHubCode,
} from "./github/github-code-search";

// Re-export all types so consumers can import from a single module
export type {
	CodeSearchParams,
	CodeSearchResponse,
	CodeSearchResult,
	FileContentResult,
	GetFileParams,
	ListStructureParams,
	RepositoryObjectType,
	RepositoryReadError,
	RepositoryStructure,
	SearchCodeParams,
	TreeEntry,
} from "./github/github-code-search";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB
const DEFAULT_MAX_RESULTS = 10;
const ABSOLUTE_MAX_RESULTS = 30;

// ---------------------------------------------------------------------------
// Azure DevOps helpers
// ---------------------------------------------------------------------------

function adoAuthHeader(pat: string): string {
	return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

/**
 * Whether an Azure DevOps answer is a failure, discarding its body if so.
 * 203 is the sign-in page Azure DevOps serves for an invalid or expired PAT:
 * `response.ok` is true for it, but its body is HTML, never the data asked
 * for — as repository-api.ts and repository-file.ts already treat it.
 */
async function adoFailed(response: Response): Promise<boolean> {
	if (response.ok && response.status !== 203) {
		return false;
	}
	await response.body?.cancel().catch(() => {});
	return true;
}

const UNSUPPORTED_PROVIDER_ERROR: RepositoryReadError = {
	kind: "misconfigured",
	message: "This repository provider is not supported for code reads.",
};

const ADO_PROJECT_MISSING_ERROR: RepositoryReadError = {
	kind: "misconfigured",
	message:
		"The repository is not fully configured: its Azure DevOps project is missing.",
};

/**
 * What an Azure DevOps item is when it is not a regular file, from the
 * item's own metadata (the `items` endpoint asked with
 * `Accept: application/json` and no content — the request repository-file.ts
 * makes): folder, symbolic link, or submodule (a `commit` object). Null for a
 * blob, and for anything this does not recognise.
 */
function adoNonFileType(item: unknown): RepositoryObjectType | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return null;
	}
	const record = item as Record<string, unknown>;
	if (record.isFolder === true || record.gitObjectType === "tree") {
		return "dir";
	}
	if (record.isSymLink === true) {
		return "symlink";
	}
	if (record.gitObjectType === "commit") {
		return "submodule";
	}
	return null;
}

/** Search code in an Azure DevOps repository. */
async function searchAzureDevOpsCode(
	params: SearchCodeParams,
): Promise<CodeSearchResponse> {
	const {
		query,
		owner: organization,
		repo,
		token,
		azureProject,
		path,
		maxResults,
	} = params;

	if (!azureProject) {
		console.error(
			"[code-search] azureProject is required for Azure DevOps search",
		);
		return { results: [], error: ADO_PROJECT_MISSING_ERROR };
	}

	const clampedMax = Math.min(
		maxResults ?? DEFAULT_MAX_RESULTS,
		ABSOLUTE_MAX_RESULTS,
	);

	// Azure DevOps code search requires the Project filter whenever a Repository
	// filter is supplied (the API rejects Repository-without-Project with a 400
	// "Filter [Repository] is found but filter [Project] is not.").
	const filters: Record<string, string[]> = {
		Project: [azureProject],
		Repository: [repo],
	};
	if (path) {
		filters.Path = [path];
	}

	const url = `https://almsearch.dev.azure.com/${organization}/${azureProject}/_apis/search/codesearchresults?api-version=7.1`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: adoAuthHeader(token),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			searchText: query,
			$top: clampedMax,
			filters,
		}),
	});

	if (await adoFailed(response)) {
		const error = readErrorFromResponse(response);
		console.error(
			"[code-search] ADO search failed",
			readErrorLogFields(error),
		);
		return { results: [], error };
	}

	const data = (await response.json()) as {
		results?: Array<{
			fileName: string;
			path: string;
			repository?: { name?: string };
			matches?: Record<
				string,
				Array<{ charOffset: number; length: number }>
			>;
			contentId?: string;
		}>;
	};

	return {
		results: (data.results ?? []).map((item) => ({
			filePath: item.path,
			fileName: item.fileName,
			repository: item.repository?.name ?? repo,
			matchedSnippets: [],
		})),
	};
}

/** Fetch a single file from an Azure DevOps repository. */
async function getAzureDevOpsFile(
	params: GetFileParams,
): Promise<FileContentResult> {
	const {
		owner: organization,
		repo,
		token,
		azureProject,
		path,
		branch,
	} = params;

	if (!azureProject) {
		console.error(
			"[code-search] azureProject is required for Azure DevOps file retrieval",
		);
		return {
			path,
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			error: ADO_PROJECT_MISSING_ERROR,
		};
	}

	// Omit the version descriptor when the branch is unknown so ADO serves the
	// repo's real default branch — a hardcoded "main" 404s on master-default repos.
	const fileParams = new URLSearchParams({ path, "api-version": "7.1" });
	if (branch) {
		fileParams.set("versionDescriptor.version", branch);
	}
	const url =
		`https://dev.azure.com/${organization}/${azureProject}/_apis/git/repositories/${repo}/items?` +
		fileParams.toString();

	// Folder status comes from the item's metadata, never from the bytes of
	// the file: a JSON file can hold any fields at all. One small metadata
	// request first, then the content.
	const metadataResponse = await fetch(url, {
		headers: {
			Authorization: adoAuthHeader(token),
			Accept: "application/json",
		},
	});
	if (await adoFailed(metadataResponse)) {
		const error = readErrorFromResponse(metadataResponse);
		console.error(
			"[code-search] ADO get file metadata failed",
			readErrorLogFields(error),
		);
		return {
			path,
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			error,
		};
	}
	let metadata: unknown;
	try {
		metadata = await metadataResponse.json();
	} catch {
		// Not item metadata: decide nothing from it and read the content.
		metadata = undefined;
	}
	const nonFile = adoNonFileType(metadata);
	if (nonFile) {
		return {
			path,
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			error: notAFileError(nonFile),
		};
	}

	const response = await fetch(url, {
		headers: {
			Authorization: adoAuthHeader(token),
		},
	});

	if (await adoFailed(response)) {
		const error = readErrorFromResponse(response);
		console.error(
			"[code-search] ADO get file failed",
			readErrorLogFields(error),
		);
		return {
			path,
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			error,
		};
	}

	const text = await response.text();
	const isTruncated = text.length > MAX_FILE_SIZE_BYTES;
	const content = isTruncated ? text.slice(0, MAX_FILE_SIZE_BYTES) : text;

	return {
		path,
		content,
		size: text.length,
		encoding: "utf-8",
		isBinary: false,
		isTruncated,
	};
}

/** List the directory tree of an Azure DevOps repository. */
async function listAzureDevOpsStructure(
	params: ListStructureParams,
): Promise<RepositoryStructure> {
	const {
		owner: organization,
		repo,
		token,
		azureProject,
		branch,
		directory,
	} = params;

	if (!azureProject) {
		console.error(
			"[code-search] azureProject is required for Azure DevOps structure listing",
		);
		return {
			entries: [],
			totalFiles: 0,
			totalDirectories: 0,
			truncated: false,
			error: ADO_PROJECT_MISSING_ERROR,
		};
	}

	const queryParams: Record<string, string> = {
		recursionLevel: "full",
		"api-version": "7.1",
	};
	// Omit the version descriptor when the branch is unknown → ADO default branch.
	if (branch) {
		queryParams["versionDescriptor.version"] = branch;
	}
	if (directory) {
		queryParams.scopePath = directory;
	}

	const url =
		`https://dev.azure.com/${organization}/${azureProject}/_apis/git/repositories/${repo}/items?` +
		new URLSearchParams(queryParams).toString();

	const response = await fetch(url, {
		headers: {
			Authorization: adoAuthHeader(token),
			Accept: "application/json",
		},
	});

	if (await adoFailed(response)) {
		const error = readErrorFromResponse(response);
		console.error(
			"[code-search] ADO list structure failed",
			readErrorLogFields(error),
		);
		return {
			entries: [],
			totalFiles: 0,
			totalDirectories: 0,
			truncated: false,
			error,
		};
	}

	const data = (await response.json()) as {
		value?: Array<{
			path: string;
			isFolder?: boolean;
			size?: number;
		}>;
	};

	const entries = (data.value ?? []).map((item) => ({
		path: item.path,
		type: item.isFolder ? ("directory" as const) : ("file" as const),
		size: item.size,
	}));

	const totalFiles = entries.filter((entry) => entry.type === "file").length;
	const totalDirectories = entries.filter(
		(entry) => entry.type === "directory",
	).length;

	return {
		entries,
		totalFiles,
		totalDirectories,
		truncated: false,
	};
}

// ---------------------------------------------------------------------------
// Commit comparison (indexed commit → current branch HEAD)
// ---------------------------------------------------------------------------

export type CompareCommitsStatus =
	| "identical"
	| "ahead"
	| "behind"
	| "diverged"
	| "unknown";

export interface CompareCommitsParams {
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	token: string;
	owner: string;
	repo: string;
	/** The already-indexed commit — the comparison baseline. */
	base: string;
	/** The current branch HEAD (branch name or SHA) to compare against. */
	head: string;
	/** Required for Azure DevOps — the ADO project the repo lives in. */
	azureProject?: string;
}

export interface CompareCommitsResult {
	status: CompareCommitsStatus;
	/** Commits `head` is ahead of `base` — i.e. new commits since the index. */
	aheadBy: number;
	/** Commits `head` is behind `base` (0 for GitLab — compare is one-way). */
	behindBy: number;
	/** Changed file paths between base and head (deduped; provider caps apply). */
	changedFiles: string[];
	/** HEAD SHA at compare time when the provider reports it, else null. */
	headSha: string | null;
	/**
	 * True when the provider capped the changed-file list (GitHub caps compare at
	 * 300 files; ADO pages large diffs). A truncated list is not safe to drive an
	 * incremental re-index — the caller falls back to a full index.
	 */
	truncated: boolean;
}

/** GitHub caps the `files` array of a compare response at 300 entries. */
const GITHUB_COMPARE_FILE_CAP = 300;
/** Upper bound on ADO diff entries requested in one page. */
const ADO_DIFF_TOP = 1000;
/** GitLab REST base — matches `@repo/integrations` (gitlab.com only). */
const GITLAB_API_BASE = "https://gitlab.com/api/v4";

const GITHUB_COMPARE_HEADERS = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
});

const UNKNOWN_COMPARE: CompareCommitsResult = {
	status: "unknown",
	aheadBy: 0,
	behindBy: 0,
	changedFiles: [],
	headSha: null,
	truncated: false,
};

/** Coerce GitHub's compare status into our closed union (unknown otherwise). */
function normalizeCompareStatus(
	status: string | undefined,
): CompareCommitsStatus {
	switch (status) {
		case "identical":
		case "ahead":
		case "behind":
		case "diverged":
			return status;
		default:
			return "unknown";
	}
}

/**
 * Compare via `GET /repos/{owner}/{repo}/compare/{base}...{head}`. Returns the
 * changed file paths (`files[].filename`), ahead/behind counts, and the head SHA
 * (last of `commits`). GitHub caps `files` at 300 → `truncated`.
 */
async function compareGitHubCommits(
	params: CompareCommitsParams,
): Promise<CompareCommitsResult> {
	const { token, owner, repo, base, head } = params;
	const url = `https://api.github.com/repos/${encodeURIComponent(
		owner,
	)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(
		base,
	)}...${encodeURIComponent(head)}`;
	const response = await fetch(url, {
		headers: GITHUB_COMPARE_HEADERS(token),
	});
	if (!response.ok) {
		return UNKNOWN_COMPARE;
	}
	const data = (await response.json()) as {
		status?: string;
		ahead_by?: number;
		behind_by?: number;
		files?: Array<{ filename?: string }>;
		commits?: Array<{ sha?: string }>;
	};
	const files = Array.isArray(data.files) ? data.files : [];
	const changedFiles = files
		.map((f) => f.filename)
		.filter((p): p is string => typeof p === "string" && p.length > 0);
	const commits = data.commits ?? [];
	return {
		status: normalizeCompareStatus(data.status),
		aheadBy: data.ahead_by ?? 0,
		behindBy: data.behind_by ?? 0,
		changedFiles,
		headSha:
			commits.length > 0
				? (commits[commits.length - 1]?.sha ?? null)
				: null,
		truncated: files.length >= GITHUB_COMPARE_FILE_CAP,
	};
}

/**
 * Compare via `GET /projects/:path/repository/compare?from={base}&to={head}`.
 * GitLab compare is one-directional (base → head), so `behindBy` is always 0 and
 * `aheadBy` is the number of commits on `head` not in `base`. Changed paths come
 * from `diffs[].new_path` / `diffs[].old_path` (both, to cover renames + deletes).
 */
async function compareGitLabCommits(
	params: CompareCommitsParams,
): Promise<CompareCommitsResult> {
	const { token, owner, repo, base, head } = params;
	const projectPath = encodeURIComponent(`${owner}/${repo}`);
	const query = new URLSearchParams({ from: base, to: head });
	const url = `${GITLAB_API_BASE}/projects/${projectPath}/repository/compare?${query.toString()}`;
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		return UNKNOWN_COMPARE;
	}
	const data = (await response.json()) as {
		commit?: { id?: string };
		commits?: Array<{ id?: string }>;
		diffs?: Array<{ new_path?: string; old_path?: string }>;
	};
	const commits = data.commits ?? [];
	const changed = new Set<string>();
	for (const diff of data.diffs ?? []) {
		if (diff.new_path) {
			changed.add(diff.new_path);
		}
		if (diff.old_path) {
			changed.add(diff.old_path);
		}
	}
	const aheadBy = commits.length;
	return {
		status: aheadBy > 0 ? "ahead" : "identical",
		aheadBy,
		behindBy: 0,
		changedFiles: [...changed],
		headSha: data.commit?.id ?? commits[commits.length - 1]?.id ?? null,
		truncated: false,
	};
}

/** A 40-hex (or short-hex) string is a commit ref; anything else is a branch. */
function adoVersionType(ref: string): "commit" | "branch" {
	return /^[0-9a-f]{7,40}$/i.test(ref) ? "commit" : "branch";
}

function adoCompareStatus(
	aheadBy: number,
	behindBy: number,
): CompareCommitsStatus {
	if (aheadBy === 0 && behindBy === 0) {
		return "identical";
	}
	if (aheadBy > 0 && behindBy > 0) {
		return "diverged";
	}
	return aheadBy > 0 ? "ahead" : "behind";
}

/**
 * Compare via the ADO diffs/commits API:
 * `GET /{org}/{project}/_apis/git/repositories/{repo}/diffs/commits`. Maps
 * `changes[].item.path` (leading `/` stripped, folders skipped) to changed files,
 * `aheadCount`/`behindCount` to the counts, and `allChangesIncluded === false`
 * (paged large diff) to `truncated`. ADO doesn't report the head SHA here → null.
 */
async function compareAzureDevOpsCommits(
	params: CompareCommitsParams,
): Promise<CompareCommitsResult> {
	const { token, owner, repo, base, head, azureProject } = params;
	if (!azureProject) {
		console.error(
			"[code-search] azureProject is required for Azure DevOps compare",
		);
		return UNKNOWN_COMPARE;
	}
	// Repo names are stored RAW from the connect URL — decode once (a plain name is
	// unchanged) then let the URL builder encode, so a pre-encoded "My%20Repo" isn't
	// double-encoded (mirrors repository-branch.ts).
	let repoName: string;
	try {
		repoName = decodeURIComponent(repo);
	} catch {
		repoName = repo;
	}
	const query = new URLSearchParams({
		baseVersion: base,
		baseVersionType: adoVersionType(base),
		targetVersion: head,
		targetVersionType: adoVersionType(head),
		$top: String(ADO_DIFF_TOP),
		"api-version": "7.1",
	});
	const url = `https://dev.azure.com/${encodeURIComponent(
		owner,
	)}/${encodeURIComponent(
		azureProject,
	)}/_apis/git/repositories/${encodeURIComponent(
		repoName,
	)}/diffs/commits?${query.toString()}`;
	const response = await fetch(url, {
		headers: {
			Authorization: adoAuthHeader(token),
			Accept: "application/json",
		},
	});
	if (await adoFailed(response)) {
		return UNKNOWN_COMPARE;
	}
	const data = (await response.json()) as {
		aheadCount?: number;
		behindCount?: number;
		allChangesIncluded?: boolean;
		changes?: Array<{ item?: { path?: string; isFolder?: boolean } }>;
	};
	const changed = new Set<string>();
	for (const change of data.changes ?? []) {
		const item = change.item;
		if (!item || item.isFolder || !item.path) {
			continue;
		}
		changed.add(item.path.replace(/^\//, ""));
	}
	const aheadBy = data.aheadCount ?? 0;
	const behindBy = data.behindCount ?? 0;
	return {
		status: adoCompareStatus(aheadBy, behindBy),
		aheadBy,
		behindBy,
		changedFiles: [...changed],
		headSha: null,
		truncated: data.allChangesIncluded === false,
	};
}

/**
 * Compare a repository's indexed commit (`base`) to its current branch HEAD
 * (`head`), returning the changed file paths + ahead/behind counts. Routes to the
 * correct provider. Never throws — any error (unsupported provider, bad token,
 * force-pushed-away base, network failure) resolves to `status: "unknown"` with
 * empty results, so callers degrade quietly.
 */
export async function compareRepositoryCommits(
	params: CompareCommitsParams,
): Promise<CompareCommitsResult> {
	try {
		switch (params.provider) {
			case "GITHUB":
				return await compareGitHubCommits(params);
			case "GITLAB":
				return await compareGitLabCommits(params);
			case "AZURE_DEVOPS":
				return await compareAzureDevOpsCommits(params);
			default:
				console.error(
					`[code-search] Unsupported compare provider: ${(params as CompareCommitsParams).provider}`,
				);
				return UNKNOWN_COMPARE;
		}
	} catch (error) {
		console.error("[code-search] compareRepositoryCommits error", {
			errorClass: errorClassName(error),
		});
		return UNKNOWN_COMPARE;
	}
}

// ---------------------------------------------------------------------------
// Unified public API
// ---------------------------------------------------------------------------

/**
 * Search code in a repository.
 *
 * Routes to the correct provider implementation based on `params.provider`.
 * Never throws: a failed search returns no results with `error` set, so a
 * caller can tell "no matches" from "denied", "rate limited" or "the provider
 * failed". A search that ran and found nothing has no `error`.
 */
export async function searchRepositoryCode(
	params: SearchCodeParams,
): Promise<CodeSearchResponse> {
	try {
		switch (params.provider) {
			case "GITHUB":
				return await searchGitHubCode(params);
			case "AZURE_DEVOPS":
				return await searchAzureDevOpsCode(params);
			default:
				console.error(
					`[code-search] Unsupported provider: ${(params as SearchCodeParams).provider}`,
				);
				return { results: [], error: UNSUPPORTED_PROVIDER_ERROR };
		}
	} catch (error) {
		const readError = readErrorFromException();
		console.error(
			"[code-search] searchRepositoryCode error",
			readErrorLogFields(readError, error),
		);
		return { results: [], error: readError };
	}
}

/**
 * Fetch the full content of a single file from a repository.
 *
 * Binary files return empty content with `isBinary: true`.
 * Files larger than 100 KB are truncated with `isTruncated: true`.
 * Never throws: a failed read returns empty content with `error` set, so a
 * caller can tell "not found" from "denied" or "provider down".
 */
export async function getRepositoryFile(
	params: GetFileParams,
): Promise<FileContentResult> {
	const emptyResult: FileContentResult = {
		path: params.path,
		content: "",
		size: 0,
		encoding: "none",
		isBinary: false,
		isTruncated: false,
	};

	try {
		switch (params.provider) {
			case "GITHUB":
				return await getGitHubFile(params);
			case "AZURE_DEVOPS":
				return await getAzureDevOpsFile(params);
			default:
				console.error(
					`[code-search] Unsupported provider: ${(params as GetFileParams).provider}`,
				);
				return {
					...emptyResult,
					error: UNSUPPORTED_PROVIDER_ERROR,
				};
		}
	} catch (error) {
		const readError = readErrorFromException();
		console.error(
			"[code-search] getRepositoryFile error",
			readErrorLogFields(readError, error),
		);
		return { ...emptyResult, error: readError };
	}
}

/**
 * List the directory tree of a repository.
 *
 * Optionally filter by a directory prefix. Never throws: a failed listing
 * returns an empty structure with `error` set, so a caller can tell an empty
 * directory from a denied or failed read.
 */
export async function listRepositoryStructure(
	params: ListStructureParams,
): Promise<RepositoryStructure> {
	const emptyResult: RepositoryStructure = {
		entries: [],
		totalFiles: 0,
		totalDirectories: 0,
		truncated: false,
	};

	try {
		switch (params.provider) {
			case "GITHUB":
				return await listGitHubStructure(params);
			case "AZURE_DEVOPS":
				return await listAzureDevOpsStructure(params);
			default:
				console.error(
					`[code-search] Unsupported provider: ${(params as ListStructureParams).provider}`,
				);
				return {
					...emptyResult,
					error: UNSUPPORTED_PROVIDER_ERROR,
				};
		}
	} catch (error) {
		const readError = readErrorFromException();
		console.error(
			"[code-search] listRepositoryStructure error",
			readErrorLogFields(readError, error),
		);
		return { ...emptyResult, error: readError };
	}
}
