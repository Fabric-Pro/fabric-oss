import {
	AZURE_DEVOPS_API_VERSION,
	getRepositoryJson,
	isRecord,
	type RepositoryApiInput,
	type RepositoryFailure,
	repositoryApiTarget,
	repositoryRequestSignal,
	stringField,
} from "./repository-api";
import { readCappedRepositoryBody, repositoryBlobId } from "./repository-body";
import {
	type ReadRepositoryFileResult,
	readRepositoryFile,
} from "./repository-file";

/**
 * What changed between two commits (request-path helper; Fizzy #2878 §10),
 * through the PROJECT integration's stored credential (decrypted by the
 * caller; this module never touches the DB): the Compare dialog of a
 * repository-backed project, and a commit's own diff (a commit against its
 * parent).
 *
 * The answer is a PATH manifest, in the shape the snapshot compare uses
 * (`added`, `removed`, `modified`), from the provider's compare API; no file
 * content is read here. A rename is a removal of the old path and an addition
 * of the new one: a snapshot has no rename, and git detects it from the pair.
 * The comparison is against the merge base (GitHub's `base...head`, GitLab's
 * default, Azure DevOps's `diffCommonCommit`), which for a commit and an
 * ancestor of it is exactly "what the later commit changed since".
 *
 * Paths are repository-relative in the provider's spelling with no leading
 * `/`; filtering to the sync's folder is the caller's, which knows it.
 *
 * `truncated` is set when the provider capped the listing (GitHub lists at
 * most 300 files; GitLab says `compare_timeout`; Azure DevOps says
 * `allChangesIncluded: false`) or when this helper stopped paging, so a list
 * that stops short is never presented as complete.
 *
 * `readRepositoryFileAtCommit` reads one file at one commit, capped, for the
 * dialog's per-file diff. Closed failure set as the sibling helpers have it;
 * the token never leaves the request; neither function throws.
 */

/** Files per request, and requests per comparison: GitHub's own ceiling is 300 files. */
const FILES_PAGE_SIZE = 100;
const MAX_PAGES = 3;

export type RepositoryCompareStatus = "added" | "removed" | "modified";

export type RepositoryCompareFile = {
	path: string;
	status: RepositoryCompareStatus;
};

export type CompareRepositoryRefsInput = RepositoryApiInput & {
	/** The older commit. */
	from: string;
	/** The newer commit. */
	to: string;
};

export type CompareRepositoryRefsResult =
	| { ok: true; files: RepositoryCompareFile[]; truncated: boolean }
	| { ok: false; outcome: RepositoryFailure };

function plain(path: string): string | null {
	const trimmed = path.replace(/^\/+/, "");
	return trimmed === "" ? null : trimmed;
}

function push(
	files: RepositoryCompareFile[],
	status: RepositoryCompareStatus,
	path: unknown,
): void {
	if (typeof path !== "string") {
		return;
	}
	const relative = plain(path);
	if (relative !== null) {
		files.push({ path: relative, status });
	}
}

type Page = {
	files: RepositoryCompareFile[];
	/** The provider returned a full page, so another may exist. */
	more: boolean;
	/** The provider itself says the listing is incomplete. */
	capped: boolean;
};

async function gitHubPage(
	input: CompareRepositoryRefsInput,
	page: number,
): Promise<
	{ ok: true; page: Page } | { ok: false; outcome: RepositoryFailure }
> {
	const target = repositoryApiTarget(input);
	if (target === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const params = new URLSearchParams({
		per_page: String(FILES_PAGE_SIZE),
		page: String(page),
	});
	const answer = await getRepositoryJson(
		target,
		`/compare/${encodeURIComponent(input.from)}...${encodeURIComponent(input.to)}?${params.toString()}`,
	);
	if (!answer.ok) {
		return answer;
	}
	if (!isRecord(answer.data) || !Array.isArray(answer.data.files)) {
		return { ok: false, outcome: "unreachable" };
	}
	const files: RepositoryCompareFile[] = [];
	for (const entry of answer.data.files) {
		if (!isRecord(entry)) {
			return { ok: false, outcome: "unreachable" };
		}
		switch (stringField(entry, "status")) {
			case "added":
			case "copied":
				push(files, "added", entry.filename);
				break;
			case "removed":
				push(files, "removed", entry.filename);
				break;
			case "renamed":
				push(files, "removed", entry.previous_filename);
				push(files, "added", entry.filename);
				break;
			case "modified":
			case "changed":
				push(files, "modified", entry.filename);
				break;
			case "unchanged":
				break;
			default:
				return { ok: false, outcome: "unreachable" };
		}
	}
	return {
		ok: true,
		page: {
			files,
			more: answer.data.files.length >= FILES_PAGE_SIZE,
			capped: false,
		},
	};
}

async function gitLabPage(
	input: CompareRepositoryRefsInput,
): Promise<
	{ ok: true; page: Page } | { ok: false; outcome: RepositoryFailure }
> {
	const target = repositoryApiTarget(input);
	if (target === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const params = new URLSearchParams({ from: input.from, to: input.to });
	const answer = await getRepositoryJson(
		target,
		`/repository/compare?${params.toString()}`,
	);
	if (!answer.ok) {
		return answer;
	}
	if (!isRecord(answer.data) || !Array.isArray(answer.data.diffs)) {
		return { ok: false, outcome: "unreachable" };
	}
	const files: RepositoryCompareFile[] = [];
	for (const entry of answer.data.diffs) {
		if (!isRecord(entry)) {
			return { ok: false, outcome: "unreachable" };
		}
		if (entry.new_file === true) {
			push(files, "added", entry.new_path);
		} else if (entry.deleted_file === true) {
			push(files, "removed", entry.old_path);
		} else if (entry.renamed_file === true) {
			push(files, "removed", entry.old_path);
			push(files, "added", entry.new_path);
		} else {
			push(files, "modified", entry.new_path);
		}
	}
	return {
		ok: true,
		page: {
			files,
			more: false,
			capped: answer.data.compare_timeout === true,
		},
	};
}

async function azureDevOpsPage(
	input: CompareRepositoryRefsInput,
	page: number,
): Promise<
	{ ok: true; page: Page } | { ok: false; outcome: RepositoryFailure }
> {
	const target = repositoryApiTarget(input);
	if (target === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const params = new URLSearchParams({
		baseVersion: input.from,
		baseVersionType: "commit",
		targetVersion: input.to,
		targetVersionType: "commit",
		diffCommonCommit: "true",
		$top: String(FILES_PAGE_SIZE),
		$skip: String((page - 1) * FILES_PAGE_SIZE),
		"api-version": AZURE_DEVOPS_API_VERSION,
	});
	const answer = await getRepositoryJson(
		target,
		`/diffs/commits?${params.toString()}`,
	);
	if (!answer.ok) {
		return answer;
	}
	if (!isRecord(answer.data) || !Array.isArray(answer.data.changes)) {
		return { ok: false, outcome: "unreachable" };
	}
	const files: RepositoryCompareFile[] = [];
	for (const entry of answer.data.changes) {
		if (!isRecord(entry) || !isRecord(entry.item)) {
			return { ok: false, outcome: "unreachable" };
		}
		// Folders are listed beside the files they hold: only blobs are files.
		if (
			entry.item.isFolder === true ||
			entry.item.gitObjectType === "tree"
		) {
			continue;
		}
		const changeType = (
			stringField(entry, "changeType") ?? ""
		).toLowerCase();
		const path = entry.item.path;
		if (changeType.includes("delete") && !changeType.includes("undelete")) {
			push(files, "removed", path);
		} else if (changeType.includes("rename")) {
			push(
				files,
				"removed",
				entry.originalPath ?? entry.sourceServerItem,
			);
			push(files, "added", path);
		} else if (
			changeType.includes("add") ||
			changeType.includes("undelete")
		) {
			push(files, "added", path);
		} else if (changeType.includes("edit")) {
			push(files, "modified", path);
		}
	}
	return {
		ok: true,
		page: {
			files,
			more: answer.data.changes.length >= FILES_PAGE_SIZE,
			capped: answer.data.allChangesIncluded === false,
		},
	};
}

/**
 * The files that differ between `from` and `to`, de-duplicated by path (a
 * path that is both removed and added, as a rename onto an existing name
 * would list it, is `modified`). Never throws.
 */
export async function compareRepositoryRefs(
	input: CompareRepositoryRefsInput,
): Promise<CompareRepositoryRefsResult> {
	const collected: RepositoryCompareFile[] = [];
	let truncated = false;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const answer =
			input.provider === "GITHUB"
				? await gitHubPage(input, page)
				: input.provider === "GITLAB"
					? await gitLabPage(input)
					: await azureDevOpsPage(input, page);
		if (!answer.ok) {
			return answer;
		}
		collected.push(...answer.page.files);
		if (answer.page.capped) {
			truncated = true;
		}
		if (!answer.page.more) {
			break;
		}
		if (page === MAX_PAGES) {
			truncated = true;
		}
	}
	const byPath = new Map<string, RepositoryCompareStatus>();
	for (const file of collected) {
		const seen = byPath.get(file.path);
		byPath.set(
			file.path,
			seen !== undefined && seen !== file.status
				? "modified"
				: file.status,
		);
	}
	return {
		ok: true,
		files: [...byPath].map(([path, status]) => ({ path, status })),
		truncated,
	};
}

export type IsCommitOnBranchInput = RepositoryApiInput & {
	branch: string;
	sha: string;
};

export type IsCommitOnBranchResult =
	| { ok: true; onBranch: boolean }
	| { ok: false; outcome: RepositoryFailure };

/**
 * Whether `sha` is part of `branch`'s history: it has no commit the branch
 * lacks. A commit on a pull request's branch, or on any other ref of the
 * repository, is not, and its content is not the project's to show.
 *
 * One request per provider, comparing the branch to the commit and reading
 * how many commits the commit is ahead by: GitHub `compare/{branch}...{sha}`
 * (`ahead_by`), GitLab `repository/compare?from={branch}&to={sha}` (the
 * `commits` list is empty), Azure DevOps `diffs/commits` with the branch as
 * base and the commit as target (`aheadCount`). An answer that does not carry
 * the count is `unreachable`, never "on the branch". Never throws.
 */
export async function isCommitOnBranch(
	input: IsCommitOnBranchInput,
): Promise<IsCommitOnBranchResult> {
	const target = repositoryApiTarget(input);
	if (target === null) {
		return { ok: false, outcome: "unreachable" };
	}
	switch (input.provider) {
		case "GITHUB": {
			const params = new URLSearchParams({ per_page: "1" });
			const answer = await getRepositoryJson(
				target,
				`/compare/${encodeURIComponent(input.branch)}...${encodeURIComponent(input.sha)}?${params.toString()}`,
			);
			if (!answer.ok) {
				return answer;
			}
			return isRecord(answer.data) &&
				typeof answer.data.ahead_by === "number"
				? { ok: true, onBranch: answer.data.ahead_by === 0 }
				: { ok: false, outcome: "unreachable" };
		}
		case "GITLAB": {
			const params = new URLSearchParams({
				from: input.branch,
				to: input.sha,
			});
			const answer = await getRepositoryJson(
				target,
				`/repository/compare?${params.toString()}`,
			);
			if (!answer.ok) {
				return answer;
			}
			return isRecord(answer.data) && Array.isArray(answer.data.commits)
				? { ok: true, onBranch: answer.data.commits.length === 0 }
				: { ok: false, outcome: "unreachable" };
		}
		case "AZURE_DEVOPS": {
			const params = new URLSearchParams({
				baseVersion: input.branch,
				baseVersionType: "branch",
				targetVersion: input.sha,
				targetVersionType: "commit",
				$top: "1",
				"api-version": AZURE_DEVOPS_API_VERSION,
			});
			const answer = await getRepositoryJson(
				target,
				`/diffs/commits?${params.toString()}`,
			);
			if (!answer.ok) {
				return answer;
			}
			return isRecord(answer.data) &&
				typeof answer.data.aheadCount === "number"
				? { ok: true, onBranch: answer.data.aheadCount === 0 }
				: { ok: false, outcome: "unreachable" };
		}
		default: {
			const unreachable: never = input.provider;
			return unreachable;
		}
	}
}

export type ReadRepositoryFileAtCommitInput = RepositoryApiInput & {
	sha: string;
	/** Repository-relative, in the sync's plain spelling. */
	path: string;
	/** The most bytes read; a longer file is `tooLarge`. */
	maxBytes: number;
};

const GITLAB_DIRECTORY_PAGE_SIZE = 100;
const MAX_GITLAB_DIRECTORY_PAGES = 200;
const GITLAB_DIRECTORY_RESPONSE_MAX_BYTES = 1024 * 1024;
const GITLAB_FILE_REQUEST_TIMEOUT_MS = 10_000;

function gitLabFileFailure(status: number): {
	ok: false;
	outcome: "unauthorized" | "unreachable";
} {
	return {
		ok: false,
		outcome:
			status === 401 || status === 403 || status === 203
				? "unauthorized"
				: "unreachable",
	};
}

async function readGitLabBody(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const body = await readCappedRepositoryBody(response, maxBytes, {
		refuseDeclaredLength: true,
	});
	return body.complete ? body.bytes : null;
}

function matchesGitBlob(bytes: Uint8Array, blobId: string): boolean {
	return repositoryBlobId(bytes, blobId) === blobId.toLowerCase();
}

type GitLabTreeEntry = {
	id?: unknown;
	mode?: unknown;
	path?: unknown;
	type?: unknown;
};

async function gitLabRegularFileAtCommit(
	target: NonNullable<ReturnType<typeof repositoryApiTarget>>,
	input: ReadRepositoryFileAtCommitInput,
	signal: AbortSignal,
): Promise<
	| { ok: true; state: "found"; blobId: string; rawPath: string }
	| { ok: true; state: "absent" }
	| { ok: false; outcome: "unauthorized" | "unreachable" }
> {
	const separator = input.path.lastIndexOf("/");
	const directory = separator === -1 ? "" : input.path.slice(0, separator);
	const params = new URLSearchParams({
		ref: input.sha,
		per_page: String(GITLAB_DIRECTORY_PAGE_SIZE),
		page: "1",
		...(directory === "" ? {} : { path: directory }),
	});
	let page = 1;
	for (
		let pagesRead = 0;
		pagesRead < MAX_GITLAB_DIRECTORY_PAGES;
		pagesRead++
	) {
		if (signal.aborted) {
			return { ok: false, outcome: "unreachable" };
		}
		params.set("page", String(page));
		let response: Response;
		try {
			response = await fetch(
				`${target.base}/repository/tree?${params.toString()}`,
				{ headers: target.headers, signal },
			);
		} catch {
			return { ok: false, outcome: "unreachable" };
		}
		if (signal.aborted) {
			return { ok: false, outcome: "unreachable" };
		}
		if (!response.ok) {
			return response.status === 404
				? { ok: true, state: "absent" }
				: gitLabFileFailure(response.status);
		}
		let bytes: Uint8Array | null;
		try {
			bytes = await readGitLabBody(
				response,
				GITLAB_DIRECTORY_RESPONSE_MAX_BYTES,
			);
		} catch {
			return { ok: false, outcome: "unreachable" };
		}
		if (bytes === null || signal.aborted) {
			return { ok: false, outcome: "unreachable" };
		}
		let data: unknown;
		try {
			data = JSON.parse(Buffer.from(bytes).toString("utf8"));
		} catch {
			return { ok: false, outcome: "unreachable" };
		}
		if (!Array.isArray(data)) {
			return { ok: false, outcome: "unreachable" };
		}
		for (const item of data as GitLabTreeEntry[]) {
			if (item.path !== input.path) {
				continue;
			}
			return item.type === "blob" &&
				(item.mode === "100644" || item.mode === "100755") &&
				typeof item.id === "string" &&
				/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(item.id)
				? {
						ok: true,
						state: "found",
						blobId: item.id,
						rawPath: `/repository/files/${encodeURIComponent(input.path)}/raw?${new URLSearchParams({ ref: input.sha }).toString()}`,
					}
				: { ok: true, state: "absent" };
		}
		const next = response.headers.get("x-next-page");
		if (next === null || next === "") {
			return { ok: true, state: "absent" };
		}
		if (!/^\d+$/.test(next) || Number(next) <= page) {
			return { ok: false, outcome: "unreachable" };
		}
		page = Number(next);
	}
	return { ok: false, outcome: "unreachable" };
}

async function readGitLabFileAtCommit(
	input: ReadRepositoryFileAtCommitInput,
): Promise<ReadRepositoryFileResult> {
	const target = repositoryApiTarget(input);
	if (target === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const signal = repositoryRequestSignal(
		GITLAB_FILE_REQUEST_TIMEOUT_MS,
		input.signal,
	);
	const entry = await gitLabRegularFileAtCommit(target, input, signal);
	if (!entry.ok) {
		return { ok: false, outcome: entry.outcome };
	}
	if (entry.state === "absent") {
		return entry;
	}
	if (signal.aborted) {
		return { ok: false, outcome: "unreachable" };
	}
	let response: Response;
	try {
		response = await fetch(`${target.base}${entry.rawPath}`, {
			headers: target.headers,
			signal,
		});
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
	if (signal.aborted) {
		return { ok: false, outcome: "unreachable" };
	}
	if (!response.ok) {
		return response.status === 404
			? { ok: true, state: "absent" }
			: gitLabFileFailure(response.status);
	}
	let bytes: Uint8Array | null;
	try {
		bytes = await readGitLabBody(response, input.maxBytes);
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
	if (signal.aborted) {
		return { ok: false, outcome: "unreachable" };
	}
	if (bytes === null) {
		return { ok: true, state: "tooLarge" };
	}
	return matchesGitBlob(bytes, entry.blobId)
		? { ok: true, state: "found", bytes }
		: { ok: false, outcome: "unreachable" };
}

/**
 * One file as `sha` holds it, at most `maxBytes` of it, undecoded. GitHub and
 * Azure DevOps go through `readRepositoryFile` (same checks: a folder, a
 * submodule or a link is `absent`). GitLab first verifies the pinned tree
 * entry is a regular blob, then reads the provider's raw file bytes. This
 * avoids GitLab's JSON files API text normalization. Never throws.
 */
export async function readRepositoryFileAtCommit(
	input: ReadRepositoryFileAtCommitInput,
): Promise<ReadRepositoryFileResult> {
	if (input.signal?.aborted) {
		return { ok: false, outcome: "unreachable" };
	}
	if (input.provider !== "GITLAB") {
		return readRepositoryFile({
			...input,
			branch: input.sha,
			refType: "commit",
		});
	}
	return readGitLabFileAtCommit(input);
}
