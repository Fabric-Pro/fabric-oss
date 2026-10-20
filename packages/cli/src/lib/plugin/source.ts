/**
 * Reading a project's instructions for a plugin.
 *
 * Two sources, one result. A repository project is read directly from its
 * repository at the pinned commit; an uploaded project is read from its
 * published manifest and the files it names. Only the files a plugin can use
 * are fetched (`isWantedPath`), and every file is kept in a cache keyed by what
 * identifies its bytes -- the git blob id, or the manifest's sha256 -- so a
 * render that finds the same file again reads it from disk instead of the
 * network. The cache is checked against that identity on every read: a damaged
 * or planted file is a miss, never an instruction.
 *
 * A plugin that silently lost a skill would make a session worse than no
 * update at all, so anything the read cannot complete (a tree the server
 * reports as partial, a file that cannot be fetched) fails the render. Claude
 * Code then keeps the plugin it already has.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	DirectInstructionRepositoryFile,
	FabricClient,
	PublishedInstructions,
} from "@fabricorg/sdk";
import { projectRulePathFor } from "@fabricorg/sdk";
import { matchesBlobOid, objectFormatOf } from "../git-blob.js";
import { downloadFilesByUrl } from "../instructions/file-downloads.js";
import { checkRelativePath, findCollision } from "../instructions/paths.js";
import type {
	InstructionCatalogEntry,
	InstructionSourceIdentity,
} from "./instruction-access.js";
import { type InstructionFile, pluginPathFor } from "./layout.js";

const READ_BATCH_SIZE = 200;
const MAX_INLINE_BYTES = 256 * 1024;

/** The root files a plugin turns into the session's context; project rules are read too, for delivery outside the plugin. */
const ALWAYS_ON = new Set(["CLAUDE.md", "AGENTS.md"]);

function isWantedPath(instructionPath: string): boolean {
	return (
		ALWAYS_ON.has(instructionPath) ||
		pluginPathFor(instructionPath) !== null ||
		projectRulePathFor(instructionPath) !== null
	);
}

export interface InstructionRead {
	/** Names the exact content: the same pin is the same files. */
	pin: string;
	source: InstructionSourceIdentity;
	files: InstructionFile[];
	/** Files the plugin would have carried that could not be read as text. */
	skipped: string[];
	/** Every file the instructions hold, read or not, for what the plugin leaves out. */
	listed: InstructionCatalogEntry[];
}

export interface ReadInstructionsInput {
	client: Pick<FabricClient, "instructions">;
	projectId: string;
	org?: string;
	published: PublishedInstructions;
	/** The CLI's cache folder. */
	cacheDirectory: string;
	timeoutMs: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

function blobPath(cacheDirectory: string, key: string): string {
	return path.join(cacheDirectory, "blobs", key);
}

async function cached(
	cacheDirectory: string,
	key: string,
	valid: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array | null> {
	try {
		const bytes = await readFile(blobPath(cacheDirectory, key));
		return valid(bytes) ? bytes : null;
	} catch {
		return null;
	}
}

async function remember(
	cacheDirectory: string,
	key: string,
	bytes: Uint8Array,
): Promise<void> {
	const file = blobPath(cacheDirectory, key);
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(temporary, bytes);
		await rename(temporary, file);
	} catch {
		// A cache that cannot be written is a cache miss next time, no more.
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readDirect(
	input: ReadInstructionsInput,
): Promise<InstructionRead> {
	const listing = await input.client.instructions.listRepositoryFiles(
		input.projectId,
		{ org: input.org },
		{ signal: input.signal },
	);
	if (listing.incomplete || listing.refusal !== null) {
		throw new Error(
			"The repository's file list is incomplete, so a plugin built from it could be missing instructions. Try again later.",
		);
	}
	const pin = {
		generation: listing.generation,
		commitSha: listing.commitSha,
	};
	const listed = listing.files.map((file) => ({
		path: file.path,
		size: file.size,
		kind: file.kind,
		blobId: file.blobId,
		mode: file.mode,
	}));
	const wanted = listing.files.filter((file) => isWantedPath(file.path));
	const files: InstructionFile[] = [];
	const skipped: string[] = [];
	const missing: DirectInstructionRepositoryFile[] = [];
	if (
		listing.files.some((file) => !checkRelativePath(file.path).ok) ||
		findCollision(listing.files.map((file) => file.path)) !== null
	) {
		throw new Error("The repository returned unsafe or colliding paths.");
	}

	for (const file of wanted) {
		input.signal?.throwIfAborted();
		const blobId = file.blobId;
		if (blobId === undefined || objectFormatOf(blobId) === null) {
			throw new Error(
				`The repository did not identify the Git blob for ${file.path}.`,
			);
		}
		const hit = await cached(
			input.cacheDirectory,
			`git-${blobId}`,
			(b) =>
				b.byteLength <= MAX_INLINE_BYTES && matchesBlobOid(b, blobId),
		);
		if (hit !== null) {
			files.push({
				path: file.path,
				bytes: hit,
				mode: modeOf(file.mode),
			});
			continue;
		}
		missing.push(file);
	}
	for (let offset = 0; offset < missing.length; offset += READ_BATCH_SIZE) {
		const batch = missing.slice(offset, offset + READ_BATCH_SIZE);
		const paths = batch.map((file) => file.path);
		let startIndex = 0;
		for (;;) {
			input.signal?.throwIfAborted();
			const page = await input.client.instructions.readRepositoryFiles(
				input.projectId,
				{ ...pin, paths, startIndex },
				{ org: input.org, signal: input.signal },
			);
			input.signal?.throwIfAborted();
			const end = page.nextIndex === null ? paths.length : page.nextIndex;
			if (
				page.generation !== pin.generation ||
				page.commitSha !== pin.commitSha ||
				!Number.isInteger(end) ||
				end <= startIndex ||
				end > paths.length ||
				!Array.isArray(page.files) ||
				page.files.length !== end - startIndex
			) {
				throw new Error(
					"The repository returned an invalid pinned batch.",
				);
			}
			for (const [index, result] of page.files.entries()) {
				const file = batch[startIndex + index];
				if (file === undefined || result.path !== file.path) {
					throw new Error(
						"The repository returned unexpected or missing paths.",
					);
				}
				const read = result.read;
				if (read.state === "binary" || read.state === "tooLarge") {
					skipped.push(file.path);
					continue;
				}
				if (read.state !== "found" || typeof read.text !== "string") {
					throw new Error(
						`The repository could not read ${file.path}.`,
					);
				}
				const bytes = new TextEncoder().encode(read.text);
				if (
					bytes.byteLength !== read.size ||
					bytes.byteLength > MAX_INLINE_BYTES ||
					file.blobId === undefined ||
					!matchesBlobOid(bytes, file.blobId)
				) {
					throw new Error(
						`The repository returned different bytes for ${file.path}.`,
					);
				}
				await remember(
					input.cacheDirectory,
					`git-${file.blobId}`,
					bytes,
				);
				files.push({ path: file.path, bytes, mode: modeOf(file.mode) });
			}
			if (page.nextIndex === null) {
				break;
			}
			startIndex = end;
		}
	}
	input.signal?.throwIfAborted();
	return {
		pin: `repo:${pin.generation}:${pin.commitSha}`,
		source: { kind: "repository", ...pin },
		files,
		skipped: skipped.sort(),
		listed,
	};
}

/** A git mode such as `100755`, or `null` when unrecorded. */
function modeOf(mode: string | undefined): number | null {
	if (mode === undefined) {
		return null;
	}
	const parsed = Number.parseInt(mode, 8);
	return Number.isFinite(parsed) ? parsed & 0o777 : null;
}

async function readUploaded(
	input: ReadInstructionsInput,
): Promise<InstructionRead> {
	const { published } = input;
	if (!published.published || published.snapshot === undefined) {
		return {
			pin: "upload:none",
			source: { kind: "upload", digest: null },
			files: [],
			skipped: [],
			listed: [],
		};
	}
	const digest = published.snapshot.digest;
	const listed = (published.manifest ?? []).map((entry) => ({
		path: entry.path,
		size: entry.size,
		kind: entry.kind,
		sha256: entry.sha256,
		mode: entry.mode,
	}));
	const manifest = (published.manifest ?? []).filter((entry) =>
		isWantedPath(entry.path),
	);
	const files: InstructionFile[] = [];
	const missing: typeof manifest = [];
	for (const entry of manifest) {
		const hit = await cached(
			input.cacheDirectory,
			`sha256-${entry.sha256}`,
			(bytes) => sha256Of(bytes) === entry.sha256,
		);
		if (hit === null) {
			missing.push(entry);
		} else {
			files.push({ path: entry.path, bytes: hit, mode: entry.mode });
		}
	}
	if (missing.length > 0) {
		const byPath = new Map(missing.map((entry) => [entry.path, entry]));
		await downloadFilesByUrl(
			{
				client: input.client,
				projectId: input.projectId,
				org: input.org,
				digest,
				files: missing,
				timeoutMs: input.timeoutMs,
				signal: input.signal,
				fetchImpl: input.fetchImpl,
			},
			async (file, bytes) => {
				await remember(
					input.cacheDirectory,
					`sha256-${file.sha256}`,
					bytes,
				);
				files.push({
					path: file.path,
					bytes,
					mode: byPath.get(file.path)?.mode ?? null,
				});
			},
		);
	}
	return {
		pin: `upload:${digest}`,
		source: { kind: "upload", digest },
		files,
		skipped: [],
		listed,
	};
}

export async function readInstructions(
	input: ReadInstructionsInput,
): Promise<InstructionRead> {
	const direct = input.published.direct;
	if (input.published.sourceOfTruth === "REPOSITORY") {
		if (direct?.availability !== "READY") {
			throw new Error(
				"This project reads its instructions from a repository that is not available right now. The plugin was left as it was.",
			);
		}
		return readDirect(input);
	}
	return readUploaded(input);
}
