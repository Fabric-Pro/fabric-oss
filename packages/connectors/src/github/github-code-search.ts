/**
 * GitHub Code Search
 *
 * Provides repository code search, file content retrieval, and directory tree
 * listing via the GitHub REST API. All functions are stateless — credentials
 * are passed in by the caller.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeSearchParams {
	provider: "GITHUB" | "AZURE_DEVOPS";
	token: string;
	owner: string;
	repo: string;
	branch?: string;
	azureProject?: string;
}

export interface SearchCodeParams extends CodeSearchParams {
	query: string;
	path?: string;
	language?: string;
	maxResults?: number;
}

export interface GetFileParams extends CodeSearchParams {
	path: string;
}

export interface ListStructureParams extends CodeSearchParams {
	directory?: string;
}

export interface CodeSearchResponse {
	results: CodeSearchResult[];
	/** Set only when the search failed; see {@link RepositoryReadError}. */
	error?: RepositoryReadError;
}

export interface CodeSearchResult {
	filePath: string;
	fileName: string;
	repository: string;
	htmlUrl?: string;
	matchedSnippets: string[];
	score?: number;
}

/**
 * Why a file or tree read returned nothing. Absent on a successful read, so an
 * empty result without it is a genuinely empty file or directory; present, it
 * separates "not found" from "denied", "rate limited" or "the provider failed",
 * which the empty result alone cannot.
 */
export interface RepositoryReadError {
	kind:
		| "not_found"
		| "not_a_file"
		| "unauthorized"
		| "forbidden"
		| "rate_limited"
		| "provider_error"
		| "request_failed"
		| "misconfigured";
	/** HTTP status, when the provider answered. */
	status?: number;
	/** `not_a_file` only: what the path names instead of a regular file. */
	objectType?: RepositoryObjectType;
	/** A fixed sentence per kind and status; never provider or exception text. */
	message: string;
}

/** A repository path that is not a regular file. */
export type RepositoryObjectType = "dir" | "symlink" | "submodule";

export interface FileContentResult {
	path: string;
	content: string;
	size: number;
	encoding: string;
	isBinary: boolean;
	isTruncated: boolean;
	/** Set only when the read failed; see {@link RepositoryReadError}. */
	error?: RepositoryReadError;
}

export interface TreeEntry {
	path: string;
	type: "file" | "directory";
	size?: number;
}

export interface RepositoryStructure {
	entries: TreeEntry[];
	totalFiles: number;
	totalDirectories: number;
	truncated: boolean;
	/** Set only when the listing failed; see {@link RepositoryReadError}. */
	error?: RepositoryReadError;
}

/**
 * Classify a failed provider response. A rate-limit wall (429, or a GitHub
 * 403 with the quota exhausted or a retry-after) is not a permission verdict,
 * matching `accessFromStatus` in repository-access.ts.
 *
 * The message is a fixed sentence per kind and status. It deliberately never
 * includes the response's body, status text or headers: providers echo
 * credentials there, and this text reaches the chat model and the logs.
 */
export function readErrorFromResponse(
	response: Pick<Response, "status" | "headers">,
): RepositoryReadError {
	const { status } = response;
	const header = (name: string): string | null =>
		response.headers?.get?.(name) ?? null;
	const rateLimited =
		status === 429 ||
		(status === 403 &&
			(header("retry-after") !== null ||
				header("x-ratelimit-remaining") === "0"));
	// Azure DevOps answers an invalid or expired PAT with 203 and an HTML
	// sign-in page (repository-api.ts, repository-file.ts treat it the same).
	if (status === 203) {
		return {
			kind: "unauthorized",
			status,
			message:
				"The Azure DevOps credentials were rejected (HTTP 203, sign-in page).",
		};
	}
	if (rateLimited) {
		return {
			kind: "rate_limited",
			status,
			message: `The repository provider rate-limited the request (HTTP ${status}); try again shortly.`,
		};
	}
	if (status === 401) {
		return {
			kind: "unauthorized",
			status,
			message: "The repository credentials were rejected (HTTP 401).",
		};
	}
	if (status === 403) {
		return {
			kind: "forbidden",
			status,
			message:
				"The repository credentials do not have access to this (HTTP 403).",
		};
	}
	if (status === 404) {
		return { kind: "not_found", status, message: "Not found (HTTP 404)." };
	}
	if (status >= 500) {
		return {
			kind: "provider_error",
			status,
			message: `The repository provider returned an error (HTTP ${status}).`,
		};
	}
	return {
		kind: "request_failed",
		status,
		message: `The repository request failed (HTTP ${status}).`,
	};
}

/**
 * A thrown fetch or parse failure, as a read error. Fixed text: an
 * exception's message can carry the request URL and its credentials.
 */
export function readErrorFromException(): RepositoryReadError {
	return {
		kind: "request_failed",
		message:
			"The repository request failed before the provider answered; try again shortly.",
	};
}

/** The read error for a path that names a folder, link or submodule. */
export function notAFileError(
	objectType: RepositoryObjectType,
): RepositoryReadError {
	return {
		kind: "not_a_file",
		objectType,
		message:
			objectType === "dir"
				? "The path is a directory, not a file."
				: objectType === "symlink"
					? "The path is a symbolic link, not a regular file."
					: "The path is a git submodule, not a regular file.",
	};
}

/**
 * An error's class name for logs, and nothing else from it: the message and
 * stack can carry tokens. Anything that is not a plain identifier is "Error".
 */
export function errorClassName(error: unknown): string {
	const name = error instanceof Error ? error.name : typeof error;
	return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

/** Log fields for a failed read: kind, status and class name only. */
export function readErrorLogFields(
	error: RepositoryReadError,
	cause?: unknown,
): Record<string, unknown> {
	return {
		kind: error.kind,
		...(error.status !== undefined ? { status: error.status } : {}),
		...(cause !== undefined ? { errorClass: errorClassName(cause) } : {}),
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB
const DEFAULT_MAX_RESULTS = 10;
const ABSOLUTE_MAX_RESULTS = 30;

const GITHUB_HEADERS = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github.text-match+json",
	"X-GitHub-Api-Version": "2022-11-28",
});

// ---------------------------------------------------------------------------
// GitHub-specific API helpers
// ---------------------------------------------------------------------------

/** Search code in a GitHub repository using the Code Search API. */
async function searchGitHubCode(
	params: SearchCodeParams,
): Promise<CodeSearchResponse> {
	const { query, owner, repo, token, path, language, maxResults } = params;
	const clampedMax = Math.min(
		maxResults ?? DEFAULT_MAX_RESULTS,
		ABSOLUTE_MAX_RESULTS,
	);

	// Build the qualified query string with repo, path, and language qualifiers
	let qualifiedQuery = `${query} repo:${owner}/${repo}`;
	if (path) {
		qualifiedQuery += ` path:${path}`;
	}
	if (language) {
		qualifiedQuery += ` language:${language}`;
	}

	const url = `https://api.github.com/search/code?${new URLSearchParams({
		q: qualifiedQuery,
		per_page: String(clampedMax),
	})}`;

	const response = await fetch(url, {
		headers: GITHUB_HEADERS(token),
	});

	if (!response.ok) {
		const error = readErrorFromResponse(response);
		console.error(
			"[github-code-search] Search failed",
			readErrorLogFields(error),
		);
		return { results: [], error };
	}

	const data = (await response.json()) as {
		items?: Array<{
			name: string;
			path: string;
			html_url: string;
			repository?: { full_name?: string };
			score?: number;
			text_matches?: Array<{ fragment?: string }>;
		}>;
	};

	return {
		results: (data.items ?? []).map((item) => ({
			filePath: item.path,
			fileName: item.name,
			repository: item.repository?.full_name ?? `${owner}/${repo}`,
			htmlUrl: item.html_url,
			matchedSnippets: (item.text_matches ?? [])
				.map((match) => match.fragment)
				.filter((fragment): fragment is string => Boolean(fragment)),
			score: item.score,
		})),
	};
}

/** Fetch the full content of a single file from a GitHub repository. */
async function getGitHubFile(
	params: GetFileParams,
): Promise<FileContentResult> {
	const { owner, repo, token, path, branch } = params;

	// Omit `ref` when the branch is unknown so GitHub serves the repo's real
	// default branch — a hardcoded "main" 404s on repos whose default is master.
	const query = branch ? `?${new URLSearchParams({ ref: branch })}` : "";
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}${query}`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (!response.ok) {
		const error = readErrorFromResponse(response);
		console.error(
			"[github-code-search] Get file failed",
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

	const raw = (await response.json()) as unknown;
	// The contents API answers a folder with its listing (an array), and a
	// link or submodule with an object of that type: none of them is a file.
	// Same shapes `readGitHubFile` in repository-file.ts tells apart.
	if (Array.isArray(raw)) {
		return notAFile(path, "dir");
	}
	const data = (raw ?? {}) as {
		content?: string;
		encoding?: string;
		size?: number;
		type?: string;
	};
	if (
		data.type === "dir" ||
		data.type === "symlink" ||
		data.type === "submodule"
	) {
		return notAFile(path, data.type);
	}

	const rawSize = data.size ?? 0;
	// An empty file: `type: "file"` with size 0, or empty base64 content.
	if (
		data.type === "file" &&
		(rawSize === 0 || (data.encoding === "base64" && !data.content))
	) {
		return {
			path,
			content: "",
			size: 0,
			encoding: "utf-8",
			isBinary: false,
			isTruncated: false,
		};
	}

	// Content GitHub did not base64-encode (e.g. `none` for a file too large
	// for the contents API) cannot be shown as text.
	const isBinary = data.encoding !== "base64" && data.encoding !== "utf-8";

	if (isBinary || !data.content) {
		return {
			path,
			content: "",
			size: rawSize,
			encoding: data.encoding ?? "unknown",
			isBinary: true,
			isTruncated: false,
		};
	}

	// Decode base64 content from the GitHub API. GitHub base64-encodes binary
	// files too, so a NUL byte (git's own binary test) marks one.
	let decoded: string;
	try {
		const bytes = Buffer.from(data.content, "base64");
		if (bytes.includes(0)) {
			return {
				path,
				content: "",
				size: rawSize,
				encoding: "base64",
				isBinary: true,
				isTruncated: false,
			};
		}
		decoded = bytes.toString("utf-8");
	} catch {
		console.error("[github-code-search] Failed to decode base64 content");
		return {
			path,
			content: "",
			size: rawSize,
			encoding: data.encoding ?? "base64",
			isBinary: true,
			isTruncated: false,
		};
	}

	const isTruncated = decoded.length > MAX_FILE_SIZE_BYTES;
	const content = isTruncated
		? decoded.slice(0, MAX_FILE_SIZE_BYTES)
		: decoded;

	return {
		path,
		content,
		size: rawSize,
		encoding: "utf-8",
		isBinary: false,
		isTruncated,
	};
}

/** List the directory tree of a GitHub repository. */
async function listGitHubStructure(
	params: ListStructureParams,
): Promise<RepositoryStructure> {
	const { owner, repo, token, branch, directory } = params;

	// `HEAD` resolves to the repo's real default branch when none is given —
	// a hardcoded "main" 404s on repos whose default is master.
	const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch || "HEAD"}?recursive=1`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (!response.ok) {
		const error = readErrorFromResponse(response);
		console.error(
			"[github-code-search] List structure failed",
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
		tree?: Array<{
			path: string;
			type: string;
			size?: number;
		}>;
		truncated?: boolean;
	};

	const prefix = directory ? normalizeDirectoryPrefix(directory) : null;

	const entries: TreeEntry[] = (data.tree ?? [])
		.filter((item) => {
			if (!prefix) {
				return true;
			}
			return item.path.startsWith(prefix);
		})
		.map((item) => ({
			path: item.path,
			type:
				item.type === "tree"
					? ("directory" as const)
					: ("file" as const),
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
		truncated: data.truncated ?? false,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notAFile(
	path: string,
	objectType: RepositoryObjectType,
): FileContentResult {
	return {
		path,
		content: "",
		size: 0,
		encoding: "none",
		isBinary: false,
		isTruncated: false,
		error: notAFileError(objectType),
	};
}

/** Ensure directory prefix ends with a slash for consistent path matching. */
/**
 * The tree-path prefix for `directory`, or null for the repository root.
 * GitHub tree paths are root-relative (`src/a.ts`), so a leading slash, as
 * in `/src` or `/`, is dropped rather than matching nothing. Case is kept:
 * `src` and `SRC` can be different directories.
 */
function normalizeDirectoryPrefix(directory: string): string | null {
	const trimmed = directory.split("/").filter(Boolean).join("/");
	return trimmed ? `${trimmed}/` : null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { searchGitHubCode, getGitHubFile, listGitHubStructure };
