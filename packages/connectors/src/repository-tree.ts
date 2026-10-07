import { repositoryApiTarget, repositoryRequestSignal } from "./repository-api";
import { readCappedRepositoryBody } from "./repository-body";
import {
	gitlabHeaders,
	gitlabHost,
	parseAdoRepositoryUrl,
	type VerifyRepositoryBranchInput,
} from "./repository-branch";

/**
 * Repository tree listing (request-path helper)
 *
 * Lists every folder and file of one branch through the PROJECT
 * integration's stored credential (decrypted by the caller — this module
 * never touches the DB), so the Living Memory repository-sync dialog can
 * offer paths to select instead of typed ones (Fizzy #2674). The sibling of
 * `listRepositoryBranches`, with the same closed outcome set:
 *
 *  - `ok: true`     — the entries, in provider order, at most
 *                     `MAX_REPOSITORY_TREE_ENTRIES`; `truncated` when the
 *                     provider cut the listing or the cap did.
 *                     A GitHub repository with no commits (a 409 whose
 *                     message is "Git Repository is empty") is an empty
 *                     `ok` listing; any other 409 is "unreachable".
 *  - "not-found"    — the remote answered 404: branch or repository absent.
 *                     Azure DevOps's answer for a repository with no
 *                     commits is not established, so it keeps whatever
 *                     outcome its status maps to (no empty-tree case).
 *  - "unauthorized" — the stored credential was rejected (401/403).
 *  - "unreachable"  — anything else: network failure, timeout, a 5xx, a body
 *                     that is not the expected JSON. NEVER an empty success:
 *                     `code-search.ts`'s `listRepositoryStructure` folds
 *                     failures into an empty listing, which is why this
 *                     does not build on it.
 *  - "unsupported"  — GitLab, or any provider `isRepositoryTreeProvider`
 *                     does not list: the dialog keeps typed paths there.
 *
 * Every returned path is repository-relative in the sync's plain spelling:
 * no leading or trailing `/`, no backslash, no surrounding whitespace. A
 * provider path that cannot be put in that form is left out rather than
 * offered for a selection `configure` would refuse.
 *
 * A file that is not a REGULAR file — a symbolic link: GitHub's blob mode
 * `120000` (or any blob mode other than `100644`/`100755`), Azure DevOps's
 * `isSymLink` — is listed as a file with `regular: false`. Both syncs keep
 * regular files only, so a preview must not count it as synced; a caller
 * that does not read the marker lists it exactly as before (Fizzy #2726).
 *
 * SECURITY: the token is request-scoped — NEVER logged, NEVER returned — and
 * raw provider response bodies are never surfaced. The helper never throws.
 */

/** Most entries one listing returns; beyond it the result is `truncated`. */
export const MAX_REPOSITORY_TREE_ENTRIES = 20_000;

/**
 * One request's time budget. A recursive listing of a large tree is one
 * slower response than a single branch lookup, so this is longer than the
 * 5 s the branch helpers use; past it the listing reads as unreachable.
 */
const TREE_REQUEST_TIMEOUT_MS = 15_000;
/** All JSON received while resolving one tree stays within this byte budget. */
const MAX_TREE_RESPONSE_BYTES = 16 * 1024 * 1024;

const ADO_API_VERSION = "7.1";
const GITLAB_TREE_PAGE_SIZE = 100;
const MAX_GITLAB_TREE_PAGES = Math.ceil(
	MAX_REPOSITORY_TREE_ENTRIES / GITLAB_TREE_PAGE_SIZE,
);

export type ListRepositoryTreeInput = VerifyRepositoryBranchInput & {
	/** `branch` names a branch by default, or a pinned commit for a stable tree. */
	refType?: "branch" | "commit";
};

export type ListRepositoryTreeAtCommitInput = Omit<
	ListRepositoryTreeInput,
	"branch" | "refType"
> & {
	/** Full provider commit object id. */
	sha: string;
};

/**
 * The providers `listRepositoryTree` can list. Any other (GitLab, or one
 * added later) answers `unsupported`, so a caller can learn that from the
 * provider alone, before it resolves a credential.
 */
const REPOSITORY_TREE_PROVIDERS: ReadonlySet<string> = new Set([
	"GITHUB",
	"AZURE_DEVOPS",
]);

export function isRepositoryTreeProvider(provider: string): boolean {
	return REPOSITORY_TREE_PROVIDERS.has(provider);
}

export type RepositoryTreeEntry = {
	path: string;
	type: "file" | "dir";
	/** Provider blob/object id when the listing reports one; never a content hash. */
	blobId?: string;
	/** Provider-reported byte count when the listing reports one. */
	size?: number;
	/** Git mode when the listing reports one. */
	mode?: string;
	/**
	 * Present, and `false`, only on a file that is not a regular file (a
	 * symbolic link), which no sync reads. Absent on every other entry.
	 */
	regular?: false;
};

/** Git's modes for a regular file (`git ls-tree`): plain and executable. */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

export type ListRepositoryTreeOutcome =
	| "not-found"
	| "unauthorized"
	| "unreachable"
	| "unsupported";

export type ListRepositoryTreeResult =
	| { ok: true; entries: RepositoryTreeEntry[]; truncated: boolean }
	| { ok: false; outcome: ListRepositoryTreeOutcome };

function outcomeFromStatus(status: number): ListRepositoryTreeOutcome {
	if (status === 401 || status === 403) {
		return "unauthorized";
	}
	if (status === 404) {
		return "not-found";
	}
	return "unreachable";
}

/**
 * The provider's path in the sync's plain spelling, or null when it has
 * none: surrounding slashes are the provider's decoration and are dropped;
 * a backslash or surrounding whitespace is part of the name and cannot be
 * selected, so the entry is left out.
 */
function plainTreePath(raw: string): string | null {
	const path = raw.replace(/^\/+/, "").replace(/\/+$/, "");
	if (path === "" || path.includes("\\") || path.trim() !== path) {
		return null;
	}
	return path;
}

function blobMetadata(item: {
	sha?: unknown;
	objectId?: unknown;
	size?: unknown;
	mode?: unknown;
}): Pick<RepositoryTreeEntry, "blobId" | "size" | "mode"> {
	const blobId =
		typeof item.sha === "string"
			? item.sha
			: typeof item.objectId === "string"
				? item.objectId
				: undefined;
	const size =
		typeof item.size === "number" &&
		Number.isSafeInteger(item.size) &&
		item.size >= 0
			? item.size
			: undefined;
	const mode = typeof item.mode === "string" ? item.mode : undefined;
	return {
		...(blobId === undefined ? {} : { blobId }),
		...(size === undefined ? {} : { size }),
		...(mode === undefined ? {} : { mode }),
	};
}

/** Apply the cap; the provider's own `truncated` flag carries through. */
function capped(
	entries: RepositoryTreeEntry[],
	providerTruncated: boolean,
): ListRepositoryTreeResult {
	if (entries.length > MAX_REPOSITORY_TREE_ENTRIES) {
		return {
			ok: true,
			entries: entries.slice(0, MAX_REPOSITORY_TREE_ENTRIES),
			truncated: true,
		};
	}
	return { ok: true, entries, truncated: providerTruncated };
}

type TreeJson = { data: unknown; bytes: number };

/**
 * Providers can return a syntactically valid tree that is far larger than its
 * entry count suggests. Read JSON as a capped stream before parsing it; the
 * response's `json()` method would otherwise buffer the entire tree first.
 */
async function readTreeJson(
	response: Response,
	maxBytes: number,
): Promise<TreeJson | null> {
	try {
		const body = await readCappedRepositoryBody(response, maxBytes, {
			refuseDeclaredLength: true,
		});
		if (!body.complete) {
			return null;
		}
		return {
			data: JSON.parse(Buffer.from(body.bytes).toString("utf8")),
			bytes: body.bytes.byteLength,
		};
	} catch {
		return null;
	}
}

/**
 * A GitHub 409 whose JSON body's `message` starts with "Git Repository is
 * empty" (any case). An unparseable body, or any other message, is not.
 */
async function isEmptyRepositoryConflict(response: Response): Promise<boolean> {
	const body = await readTreeJson(response, MAX_TREE_RESPONSE_BYTES);
	if (body === null) {
		return false;
	}
	const message =
		body.data && typeof body.data === "object"
			? (body.data as { message?: unknown }).message
			: undefined;
	return (
		typeof message === "string" &&
		message.toLowerCase().startsWith("git repository is empty")
	);
}

async function listGitHubTree(
	input: ListRepositoryTreeInput,
): Promise<ListRepositoryTreeResult> {
	const url = `https://api.github.com/repos/${encodeURIComponent(
		input.owner,
	)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(
		input.branch,
	)}?recursive=1`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${input.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: repositoryRequestSignal(TREE_REQUEST_TIMEOUT_MS, input.signal),
	});
	// GitHub answers the trees endpoint of a repository with no commits 409
	// "Git Repository is empty": a real, empty tree, not a failure. Only that
	// message is: any other 409, or one whose body cannot be read, is a
	// failure like every other non-OK status.
	if (response.status === 409) {
		return (await isEmptyRepositoryConflict(response))
			? { ok: true, entries: [], truncated: false }
			: { ok: false, outcome: "unreachable" };
	}
	if (!response.ok) {
		return { ok: false, outcome: outcomeFromStatus(response.status) };
	}
	const body = await readTreeJson(response, MAX_TREE_RESPONSE_BYTES);
	if (body === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const data = body.data as {
		tree?: unknown;
		truncated?: unknown;
	};
	if (!Array.isArray(data?.tree)) {
		return { ok: false, outcome: "unreachable" };
	}
	const entries: RepositoryTreeEntry[] = [];
	for (const item of data.tree as Array<{
		path?: unknown;
		type?: unknown;
		mode?: unknown;
		sha?: unknown;
		size?: unknown;
	}>) {
		// `commit` is a submodule: neither a folder nor a file the sync reads.
		const type =
			item?.type === "blob"
				? "file"
				: item?.type === "tree"
					? "dir"
					: null;
		if (!type || typeof item.path !== "string") {
			continue;
		}
		const path = plainTreePath(item.path);
		if (path === null) {
			continue;
		}
		// A blob's mode says what it is: `120000` is a symbolic link. A blob
		// with no mode at all is taken as a file, as it always was.
		const regular =
			type !== "file" ||
			typeof item.mode !== "string" ||
			REGULAR_FILE_MODES.has(item.mode);
		const metadata = input.refType === "commit" ? blobMetadata(item) : {};
		entries.push(
			regular
				? {
						path,
						type,
						...(type === "file" ? metadata : {}),
					}
				: { path, type, regular: false, ...metadata },
		);
	}
	return capped(entries, data.truncated === true);
}

async function listAzureDevOpsTree(
	input: ListRepositoryTreeInput,
): Promise<ListRepositoryTreeResult> {
	if (input.refType === "commit") {
		return listAzureDevOpsCommitTree(input);
	}
	const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
	const organization = parsed?.organization ?? input.azureOrganization;
	if (!organization) {
		return { ok: false, outcome: "unreachable" };
	}
	const host = parsed?.host ?? "https://dev.azure.com";
	const projectSegment = parsed
		? `/${encodeURIComponent(parsed.project)}`
		: "";
	// Stored RAW from the connect URL: decode once, then encode exactly once
	// (see `verifyAzureDevOpsBranch`).
	let repoName: string;
	try {
		repoName = decodeURIComponent(input.repo);
	} catch {
		repoName = input.repo;
	}
	const params = new URLSearchParams({
		scopePath: "/",
		recursionLevel: "full",
		"versionDescriptor.version": input.branch,
		"versionDescriptor.versionType": input.refType ?? "branch",
		"api-version": ADO_API_VERSION,
	});
	const url = `${host}/${encodeURIComponent(
		organization,
	)}${projectSegment}/_apis/git/repositories/${encodeURIComponent(
		repoName,
	)}/items?${params.toString()}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`,
			Accept: "application/json",
		},
		signal: repositoryRequestSignal(TREE_REQUEST_TIMEOUT_MS, input.signal),
	});
	// ADO answers an invalid/expired PAT with a 203 + HTML sign-in page.
	if (response.status === 203) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (!response.ok) {
		return { ok: false, outcome: outcomeFromStatus(response.status) };
	}
	const body = await readTreeJson(response, MAX_TREE_RESPONSE_BYTES);
	if (body === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const data = body.data as { value?: unknown };
	if (!Array.isArray(data?.value)) {
		return { ok: false, outcome: "unreachable" };
	}
	const entries: RepositoryTreeEntry[] = [];
	for (const item of data.value as Array<{
		path?: unknown;
		isFolder?: unknown;
		isSymLink?: unknown;
		gitObjectType?: unknown;
		objectId?: unknown;
		size?: unknown;
		mode?: unknown;
	}>) {
		if (typeof item?.path !== "string" || item.gitObjectType === "commit") {
			continue;
		}
		// ADO spells every path from the root (`/docs/guide.md`) and lists
		// the root itself as `/`, which `plainTreePath` leaves out.
		const path = plainTreePath(item.path);
		if (path === null) {
			continue;
		}
		// A symbolic link is a blob in git, never a folder, whatever else
		// the item says.
		if (item.isSymLink === true) {
			entries.push({ path, type: "file", regular: false });
			continue;
		}
		const type = item.isFolder === true ? "dir" : "file";
		entries.push({
			path,
			type,
		});
	}
	return capped(entries, false);
}

/**
 * Azure DevOps's Items API does not report Git modes. A pinned tree needs
 * those modes to distinguish executable files and links, so resolve the
 * commit's root tree and read the Git Trees resource instead. The branch
 * preview above remains on Items for its established legacy contract.
 */
async function listAzureDevOpsCommitTree(
	input: ListRepositoryTreeInput,
): Promise<ListRepositoryTreeResult> {
	const target = repositoryApiTarget(input);
	if (target === null || target.provider !== "AZURE_DEVOPS") {
		return { ok: false, outcome: "unreachable" };
	}
	const signal = repositoryRequestSignal(
		TREE_REQUEST_TIMEOUT_MS,
		target.signal,
	);
	const commitResponse = await fetch(
		`${target.base}/commits/${encodeURIComponent(input.branch)}?${new URLSearchParams({ "api-version": ADO_API_VERSION }).toString()}`,
		{ headers: target.headers, signal },
	);
	if (commitResponse.status === 203) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (!commitResponse.ok) {
		return { ok: false, outcome: outcomeFromStatus(commitResponse.status) };
	}
	const commit = await readTreeJson(commitResponse, MAX_TREE_RESPONSE_BYTES);
	if (
		commit === null ||
		typeof commit.data !== "object" ||
		commit.data === null ||
		Array.isArray(commit.data) ||
		typeof (commit.data as { treeId?: unknown }).treeId !== "string"
	) {
		return { ok: false, outcome: "unreachable" };
	}
	const treeId = (commit.data as { treeId: string }).treeId;
	if (!/^[0-9a-f]{40}$/i.test(treeId)) {
		return { ok: false, outcome: "unreachable" };
	}
	const treeResponse = await fetch(
		`${target.base}/trees/${encodeURIComponent(treeId)}?${new URLSearchParams({ recursive: "true", "api-version": ADO_API_VERSION }).toString()}`,
		{ headers: target.headers, signal },
	);
	if (treeResponse.status === 203) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (!treeResponse.ok) {
		return { ok: false, outcome: outcomeFromStatus(treeResponse.status) };
	}
	const tree = await readTreeJson(
		treeResponse,
		MAX_TREE_RESPONSE_BYTES - commit.bytes,
	);
	if (tree === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const data = tree.data as { treeEntries?: unknown };
	if (!Array.isArray(data?.treeEntries)) {
		return { ok: false, outcome: "unreachable" };
	}
	const entries: RepositoryTreeEntry[] = [];
	for (const item of data.treeEntries as Array<{
		relativePath?: unknown;
		gitObjectType?: unknown;
		objectId?: unknown;
		size?: unknown;
		mode?: unknown;
	}>) {
		const type =
			item.gitObjectType === "blob"
				? "file"
				: item.gitObjectType === "tree"
					? "dir"
					: null;
		if (type === null || typeof item.relativePath !== "string") {
			continue;
		}
		const path = plainTreePath(item.relativePath);
		if (path === null) {
			continue;
		}
		const metadata = type === "file" ? blobMetadata(item) : {};
		const regular =
			type !== "file" ||
			(typeof item.mode === "string" &&
				REGULAR_FILE_MODES.has(item.mode));
		entries.push(
			regular
				? { path, type, ...(type === "file" ? metadata : {}) }
				: { path, type, regular: false, ...metadata },
		);
		if (entries.length > MAX_REPOSITORY_TREE_ENTRIES) {
			return capped(entries, true);
		}
	}
	return capped(entries, false);
}

/**
 * GitLab's tree route is paginated. It is available for immutable commit
 * reads only: the older branch preview deliberately remains unsupported so
 * configuring a legacy sync keeps its existing typed-path contract.
 */
async function listGitLabCommitTree(
	input: ListRepositoryTreeInput,
): Promise<ListRepositoryTreeResult> {
	const projectPath = encodeURIComponent(`${input.owner}/${input.repo}`);
	const entries: RepositoryTreeEntry[] = [];
	let page = 1;
	let pagesRead = 0;
	let providerEntriesRead = 0;
	let remainingResponseBytes = MAX_TREE_RESPONSE_BYTES;
	const signal = repositoryRequestSignal(
		TREE_REQUEST_TIMEOUT_MS,
		input.signal,
	);
	for (;;) {
		if (signal.aborted) {
			return { ok: false, outcome: "unreachable" };
		}
		if (pagesRead >= MAX_GITLAB_TREE_PAGES) {
			return capped(entries, true);
		}
		pagesRead += 1;
		const params = new URLSearchParams({
			ref: input.branch,
			recursive: "true",
			per_page: String(GITLAB_TREE_PAGE_SIZE),
			page: String(page),
		});
		const response = await fetch(
			`${gitlabHost()}/api/v4/projects/${projectPath}/repository/tree?${params.toString()}`,
			{
				headers: gitlabHeaders(input),
				signal,
			},
		);
		if (signal.aborted) {
			return { ok: false, outcome: "unreachable" };
		}
		if (!response.ok) {
			return { ok: false, outcome: outcomeFromStatus(response.status) };
		}
		const body = await readTreeJson(response, remainingResponseBytes);
		if (body === null) {
			return { ok: false, outcome: "unreachable" };
		}
		remainingResponseBytes -= body.bytes;
		const data = body.data;
		if (signal.aborted) {
			return { ok: false, outcome: "unreachable" };
		}
		if (!Array.isArray(data)) {
			return { ok: false, outcome: "unreachable" };
		}
		providerEntriesRead += data.length;
		if (providerEntriesRead > MAX_REPOSITORY_TREE_ENTRIES) {
			return capped(entries, true);
		}
		for (const item of data as Array<{
			path?: unknown;
			type?: unknown;
			id?: unknown;
			mode?: unknown;
			size?: unknown;
		}>) {
			const type =
				item.type === "blob"
					? "file"
					: item.type === "tree"
						? "dir"
						: null;
			if (type === null || typeof item.path !== "string") {
				continue;
			}
			const path = plainTreePath(item.path);
			if (path === null) {
				continue;
			}
			const regular =
				type !== "file" ||
				typeof item.mode !== "string" ||
				REGULAR_FILE_MODES.has(item.mode);
			const metadata =
				type === "file"
					? blobMetadata({
							objectId: item.id,
							size: item.size,
							mode: item.mode,
						})
					: {};
			entries.push(
				regular
					? { path, type, ...metadata }
					: { path, type, regular: false, ...metadata },
			);
			if (entries.length > MAX_REPOSITORY_TREE_ENTRIES) {
				return capped(entries, true);
			}
		}
		const next = response.headers.get("x-next-page");
		if (next === null || next === "") {
			return capped(entries, false);
		}
		if (!/^\d+$/.test(next) || Number(next) <= page) {
			return { ok: false, outcome: "unreachable" };
		}
		page = Number(next);
	}
}

/**
 * List every folder and file of `branch`. Never throws — network, timeout
 * and parse failures resolve to `{ ok: false, outcome: "unreachable" }`.
 */
export async function listRepositoryTree(
	input: ListRepositoryTreeInput,
): Promise<ListRepositoryTreeResult> {
	if (
		!isRepositoryTreeProvider(input.provider) &&
		!(input.provider === "GITLAB" && input.refType === "commit")
	) {
		// GitLab (and anything newer) keeps typed paths.
		return { ok: false, outcome: "unsupported" };
	}
	try {
		switch (input.provider) {
			case "GITHUB":
				return await listGitHubTree(input);
			case "AZURE_DEVOPS":
				return await listAzureDevOpsTree(input);
			case "GITLAB":
				return await listGitLabCommitTree(input);
			default:
				return { ok: false, outcome: "unsupported" };
		}
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
}

/**
 * List the tree at one immutable commit. The callers still receive the same
 * bounded, provider-normalized entries as a branch listing; only the provider
 * reference changes, so a branch move cannot mix metadata and file bodies.
 */
export async function listRepositoryTreeAtCommit(
	input: ListRepositoryTreeAtCommitInput,
): Promise<ListRepositoryTreeResult> {
	return listRepositoryTree({
		...input,
		branch: input.sha,
		refType: "commit",
	});
}
