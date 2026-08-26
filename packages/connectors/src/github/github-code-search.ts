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

export interface CodeSearchResult {
	filePath: string;
	fileName: string;
	repository: string;
	htmlUrl?: string;
	matchedSnippets: string[];
	score?: number;
}

export interface FileContentResult {
	path: string;
	content: string;
	size: number;
	encoding: string;
	isBinary: boolean;
	isTruncated: boolean;
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
): Promise<CodeSearchResult[]> {
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
		console.error(
			`[github-code-search] Search failed: ${response.status} ${response.statusText}`,
		);
		return [];
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

	return (data.items ?? []).map((item) => ({
		filePath: item.path,
		fileName: item.name,
		repository: item.repository?.full_name ?? `${owner}/${repo}`,
		htmlUrl: item.html_url,
		matchedSnippets: (item.text_matches ?? [])
			.map((match) => match.fragment)
			.filter((fragment): fragment is string => Boolean(fragment)),
		score: item.score,
	}));
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
		console.error(
			`[github-code-search] Get file failed: ${response.status} ${response.statusText} (${path})`,
		);
		return {
			path,
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
		};
	}

	const data = (await response.json()) as {
		content?: string;
		encoding?: string;
		size?: number;
		type?: string;
	};

	const isBinary = data.encoding !== "base64" && data.encoding !== "utf-8";
	const rawSize = data.size ?? 0;

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

	// Decode base64 content from the GitHub API
	let decoded: string;
	try {
		decoded = Buffer.from(data.content, "base64").toString("utf-8");
	} catch {
		console.error(
			`[github-code-search] Failed to decode base64 content for ${path}`,
		);
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
		console.error(
			`[github-code-search] List structure failed: ${response.status} ${response.statusText}`,
		);
		return {
			entries: [],
			totalFiles: 0,
			totalDirectories: 0,
			truncated: false,
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

/** Ensure directory prefix ends with a slash for consistent path matching. */
function normalizeDirectoryPrefix(directory: string): string {
	return directory.endsWith("/") ? directory : `${directory}/`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { searchGitHubCode, getGitHubFile, listGitHubStructure };
