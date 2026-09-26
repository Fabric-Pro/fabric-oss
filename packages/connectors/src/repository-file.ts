import { createHash } from "node:crypto";
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
 *  - `ok: true, state: "found"`    — the file's text, at most `maxBytes`
 *                                    bytes, decoded as UTF-8 the way the
 *                                    sync decodes the blob it reads.
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
	| { ok: true; state: "found"; text: string }
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

type CappedBody =
	| { complete: true; bytes: Uint8Array }
	/** Longer than the cap. `head` is the first chunk read, if any was. */
	| { complete: false; head: Uint8Array };

/**
 * The body's bytes, or — once it is longer than `maxBytes` — the fact that
 * it is. A streamed body is read chunk by chunk and cancelled as soon as it
 * passes the cap, so a large body is never downloaded whole.
 *
 * With `refuseDeclaredLength`, a declared `Content-Length` over the cap is
 * refused without reading the body at all. Only an unencoded body's length
 * is believed: a compressed length says nothing exact about the bytes it
 * decodes to.
 */
async function readCappedBody(
	response: Response,
	maxBytes: number,
	options: { refuseDeclaredLength: boolean },
): Promise<CappedBody> {
	const declared =
		!options.refuseDeclaredLength ||
		response.headers.get("content-encoding")
			? Number.NaN
			: Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		return { complete: false, head: new Uint8Array(0) };
	}
	if (!response.body) {
		const whole = new Uint8Array(await response.arrayBuffer());
		return whole.byteLength > maxBytes
			? { complete: false, head: whole.subarray(0, maxBytes) }
			: { complete: true, bytes: whole };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return { complete: false, head: chunks[0] ?? value };
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { complete: true, bytes };
}

/** The found file: decoded exactly as the sync decodes the blob it reads. */
function found(bytes: Uint8Array): ReadRepositoryFileResult {
	// `Buffer#toString("utf8")`, as the sync activity decodes the
	// `.fabricignore` blob, so the preview parses the same text.
	return {
		ok: true,
		state: "found",
		text: Buffer.from(bytes).toString("utf8"),
	};
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
 * The git object id of a blob holding `bytes` — `git hash-object` — in the
 * hash `objectId` is spelled in, or null when `objectId` is neither a SHA-1
 * nor a SHA-256 id.
 */
function blobIdLike(bytes: Uint8Array, objectId: string): string | null {
	const algorithm = /^[0-9a-f]{40}$/i.test(objectId)
		? "sha1"
		: /^[0-9a-f]{64}$/i.test(objectId)
			? "sha256"
			: null;
	if (!algorithm) {
		return null;
	}
	return createHash(algorithm)
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");
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
		signal: AbortSignal.timeout(FILE_REQUEST_TIMEOUT_MS),
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
		"versionDescriptor.versionType": "branch",
		"api-version": ADO_API_VERSION,
	});
	const itemResponse = await fetch(
		`${repositoryBase}/items?${itemParams.toString()}`,
		{
			headers: {
				Authorization: authorization,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(FILE_REQUEST_TIMEOUT_MS),
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
			signal: AbortSignal.timeout(FILE_REQUEST_TIMEOUT_MS),
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
