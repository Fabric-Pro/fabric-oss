import { repositoryRequestSignal } from "./repository-api";
import {
	repositoryBlobId as blobIdLike,
	readCappedRepositoryBody as readCappedBody,
} from "./repository-body";
import { parseAdoRepositoryUrl } from "./repository-branch";
import {
	isRepositoryTreeProvider,
	type ListRepositoryTreeInput,
} from "./repository-tree";

/**
 * Capped single-file read (request-path helper)
 *
 * Reads one file of one branch through the PROJECT integration's stored
 * credential (decrypted by the caller — this module never touches the DB),
 * reading at most `maxBytes` of it, so the Coding Instructions configure
 * dialog can preview the rules of the chosen folder's `.fabricignore`
 * (Fizzy #2726). The sibling of `listRepositoryTree`, with the same
 * providers, auth headers, host handling and closed outcome set, except
 * that a missing file is an answer, not a failure:
 *
 *  - `ok: true, state: "found"`    — the file's bytes, at most `maxBytes`
 *                                    of them and not decoded: whether they
 *                                    are text is the caller's judgement.
 *  - `ok: true, state: "absent"`   — no REGULAR file is at the path: the
 *                                    remote answered 404, or the path is a
 *                                    folder, a submodule or a symbolic link.
 *                                    The sync keeps only regular files (git
 *                                    modes 100644 and 100755), so a
 *                                    `.fabricignore` that is anything else
 *                                    has no rules for it either.
 *  - `ok: true, state: "tooLarge"` — the file is longer than `maxBytes`.
 *                                    The file itself is never read past the
 *                                    cap (see each provider for its bound).
 *  - "unauthorized"                — the stored credential was rejected
 *                                    (401/403, or Azure DevOps's 203 sign-in
 *                                    page).
 *  - "unreachable"                 — anything else: network failure,
 *                                    timeout, a 5xx, a body that is not the
 *                                    expected shape. NEVER an empty file.
 *  - "unsupported"                 — GitLab, or any provider
 *                                    `isRepositoryTreeProvider` does not
 *                                    list.
 *
 * SECURITY: the token is request-scoped — NEVER logged, NEVER returned — and
 * raw provider response bodies are never surfaced beyond the file's own
 * bytes. The helper never throws.
 */

/**
 * One request's time budget: one small file, longer than the 5 s the branch
 * helpers use and shorter than a recursive tree listing's 15 s.
 */
const FILE_REQUEST_TIMEOUT_MS = 10_000;

const ADO_API_VERSION = "7.1";

/**
 * Most bytes of Azure DevOps item metadata read. One item's metadata is a
 * few hundred bytes; anything past this is not the expected answer.
 */
const ADO_ITEM_METADATA_MAX_BYTES = 64 * 1024;

export type ReadRepositoryFileInput = ListRepositoryTreeInput & {
	/**
	 * What `branch` names: a branch (the default) or a commit id, for a read
	 * of one commit's version of the file (Fizzy #2878 §10). GitHub takes
	 * either in the same `ref`; Azure DevOps is told which.
	 */
	refType?: "branch" | "commit";
	/** Repository-relative, in the sync's plain spelling (no leading `/`). */
	path: string;
	/** The most bytes read; a longer file is `tooLarge`. */
	maxBytes: number;
};

export type ReadRepositoryFileOutcome =
	| "unauthorized"
	| "unreachable"
	| "unsupported";

export type ReadRepositoryFileResult =
	| { ok: true; state: "found"; bytes: Uint8Array }
	| { ok: true; state: "absent" }
	| { ok: true; state: "tooLarge" }
	| { ok: false; outcome: ReadRepositoryFileOutcome };

const ABSENT: ReadRepositoryFileResult = { ok: true, state: "absent" };
const TOO_LARGE: ReadRepositoryFileResult = { ok: true, state: "tooLarge" };
const UNREACHABLE: ReadRepositoryFileResult = {
	ok: false,
	outcome: "unreachable",
};

/** A non-OK status other than 404, as `listRepositoryTree` maps it. */
function failureFromStatus(status: number): ReadRepositoryFileResult {
	return {
		ok: false,
		outcome:
			status === 401 || status === 403 ? "unauthorized" : "unreachable",
	};
}

/**
 * The found file, undecoded: the caller decodes it as the sync does
 * (`decodeFabricIgnore`), which refuses what a lenient decoding would
 * quietly repair.
 */
function found(bytes: Uint8Array): ReadRepositoryFileResult {
	return { ok: true, state: "found", bytes };
}

function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the JSON text starting with `head` is an array. */
function startsJsonArray(head: Uint8Array): boolean {
	for (const byte of head) {
		// JSON's insignificant whitespace: space, tab, line feed, return.
		if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
			continue;
		}
		return byte === 0x5b; // `[`
	}
	return false;
}

/**
 * The most bytes of a GitHub contents answer read for a file of at most
 * `maxBytes`: base64 grows the file by 4/3, GitHub's line break every 60
 * characters (escaped in the JSON) by a thirtieth more, and the metadata
 * around it is a few kilobytes — twice the file plus 64 KiB always holds it.
 */
function gitHubContentsBound(maxBytes: number): number {
	return 2 * maxBytes + 64 * 1024;
}

/**
 * GitHub, through the contents API's JSON answer, which says what the path
 * is: an array for a folder, `type: "submodule"` for a submodule, and
 * `type: "symlink"` for a symbolic link GitHub did not follow — all
 * `absent`. A link to a regular file IS followed: the answer says
 * `type: "file"` and carries the target's content, but its `sha` still
 * names the link's own blob. So a file is only `found` when its content
 * hashes to the `sha` the answer gives; otherwise it is a link, `absent`.
 * (The raw media type followed links silently, and answered a folder or a
 * submodule with its JSON description as if that were the file's text.)
 *
 * `size` is checked against the cap before anything is decoded, and at most
 * `gitHubContentsBound(maxBytes)` bytes of the answer are read. An answer
 * longer than that is a folder's listing (an array: `absent`) or a file
 * longer than the cap (`tooLarge`) — including, unavoidably, a link to one,
 * whose `sha` cannot be checked without its content.
 */
async function readGitHubFile(
	input: ReadRepositoryFileInput,
): Promise<ReadRepositoryFileResult> {
	const encodedPath = input.path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	const params = new URLSearchParams({ ref: input.branch });
	const url = `https://api.github.com/repos/${encodeURIComponent(
		input.owner,
	)}/${encodeURIComponent(input.repo)}/contents/${encodedPath}?${params.toString()}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${input.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: repositoryRequestSignal(FILE_REQUEST_TIMEOUT_MS, input.signal),
	});
	if (response.status === 404) {
		return ABSENT;
	}
	if (!response.ok) {
		return failureFromStatus(response.status);
	}
	// The declared length is not refused up front: an answer over the bound
	// is still told apart (folder or file) by how it starts.
	const body = await readCappedBody(
		response,
		gitHubContentsBound(input.maxBytes),
		{ refuseDeclaredLength: false },
	);
	if (!body.complete) {
		return startsJsonArray(body.head) ? ABSENT : TOO_LARGE;
	}
	const data = parseJson(body.bytes);
	if (Array.isArray(data)) {
		return ABSENT; // A folder's listing.
	}
	if (!isRecord(data)) {
		return UNREACHABLE;
	}
	if (
		data.type === "dir" ||
		data.type === "symlink" ||
		data.type === "submodule"
	) {
		return ABSENT;
	}
	if (
		data.type !== "file" ||
		typeof data.size !== "number" ||
		typeof data.sha !== "string"
	) {
		return UNREACHABLE;
	}
	if (data.size > input.maxBytes) {
		return TOO_LARGE;
	}
	if (data.encoding !== "base64" || typeof data.content !== "string") {
		return UNREACHABLE;
	}
	const bytes = new Uint8Array(Buffer.from(data.content, "base64"));
	if (bytes.byteLength > input.maxBytes) {
		return TOO_LARGE;
	}
	const blobId = blobIdLike(bytes, data.sha);
	if (blobId === null) {
		return UNREACHABLE;
	}
	// A link GitHub followed: the content is its target's, not the blob at
	// the path, which the sync would not read.
	return blobId === data.sha.toLowerCase() ? found(bytes) : ABSENT;
}

/**
 * Azure DevOps, in two requests. The item's metadata first — `isFolder`,
 * `isSymLink` and `gitObjectType` say what the path is: a folder, a
 * symbolic link or a submodule (`commit`) is `absent`. Then the blob that
 * metadata names, by its object id, as an octet stream, so the bytes read
 * are exactly that regular file's even if the branch moves in between.
 * A declared length over the cap stops at the headers, and a streamed body
 * is cancelled once it passes the cap.
 */
async function readAzureDevOpsFile(
	input: ReadRepositoryFileInput,
): Promise<ReadRepositoryFileResult> {
	const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
	const organization = parsed?.organization ?? input.azureOrganization;
	if (!organization) {
		return UNREACHABLE;
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
	const repositoryBase = `${host}/${encodeURIComponent(
		organization,
	)}${projectSegment}/_apis/git/repositories/${encodeURIComponent(repoName)}`;
	const authorization = `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`;

	const itemParams = new URLSearchParams({
		path: `/${input.path}`,
		"versionDescriptor.version": input.branch,
		"versionDescriptor.versionType": input.refType ?? "branch",
		"api-version": ADO_API_VERSION,
	});
	const itemResponse = await fetch(
		`${repositoryBase}/items?${itemParams.toString()}`,
		{
			headers: {
				Authorization: authorization,
				Accept: "application/json",
			},
			signal: repositoryRequestSignal(
				FILE_REQUEST_TIMEOUT_MS,
				input.signal,
			),
		},
	);
	// ADO answers an invalid/expired PAT with a 203 + HTML sign-in page.
	if (itemResponse.status === 203) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (itemResponse.status === 404) {
		return ABSENT;
	}
	if (!itemResponse.ok) {
		return failureFromStatus(itemResponse.status);
	}
	const itemBody = await readCappedBody(
		itemResponse,
		ADO_ITEM_METADATA_MAX_BYTES,
		{ refuseDeclaredLength: true },
	);
	const item = itemBody.complete ? parseJson(itemBody.bytes) : undefined;
	if (!isRecord(item)) {
		return UNREACHABLE;
	}
	if (
		item.isFolder === true ||
		item.isSymLink === true ||
		item.gitObjectType === "tree" ||
		item.gitObjectType === "commit"
	) {
		return ABSENT;
	}
	if (
		item.gitObjectType !== "blob" ||
		typeof item.objectId !== "string" ||
		!/^[0-9a-f]{40}$/i.test(item.objectId)
	) {
		return UNREACHABLE;
	}

	const blobParams = new URLSearchParams({
		$format: "octetstream",
		"api-version": ADO_API_VERSION,
	});
	const blobResponse = await fetch(
		`${repositoryBase}/blobs/${item.objectId}?${blobParams.toString()}`,
		{
			headers: {
				Authorization: authorization,
				Accept: "application/octet-stream",
			},
			signal: repositoryRequestSignal(
				FILE_REQUEST_TIMEOUT_MS,
				input.signal,
			),
		},
	);
	if (blobResponse.status === 203) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (!blobResponse.ok) {
		// Including a 404: the metadata just named this blob, so its absence
		// is not an answer about the file.
		return failureFromStatus(blobResponse.status);
	}
	const blob = await readCappedBody(blobResponse, input.maxBytes, {
		refuseDeclaredLength: true,
	});
	return blob.complete ? found(blob.bytes) : TOO_LARGE;
}

/**
 * Read at most `maxBytes` of the regular file at `path` on `branch`. Never
 * throws — network, timeout and read failures resolve to `{ ok: false,
 * outcome: "unreachable" }`.
 */
export async function readRepositoryFile(
	input: ReadRepositoryFileInput,
): Promise<ReadRepositoryFileResult> {
	if (!isRepositoryTreeProvider(input.provider)) {
		// GitLab (and anything newer) has no listing to preview from.
		return { ok: false, outcome: "unsupported" };
	}
	try {
		switch (input.provider) {
			case "GITHUB":
				return await readGitHubFile(input);
			case "AZURE_DEVOPS":
				return await readAzureDevOpsFile(input);
			default:
				return { ok: false, outcome: "unsupported" };
		}
	} catch {
		return UNREACHABLE;
	}
}
