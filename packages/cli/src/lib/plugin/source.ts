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
import { matchesBlobOid } from "../git-blob.js";
import { downloadFilesByUrl } from "../instructions/file-downloads.js";
import { type InstructionFile, pluginPathFor } from "./layout.js";

/** Files read at once. */
const READ_CONCURRENCY = 6;

/** A text page of a direct file; the server's own cap is lower, this only bounds a runaway loop. */
const MAX_PAGES_PER_FILE = 64;

/** The root files a plugin turns into the session's context. */
const ALWAYS_ON = new Set(["CLAUDE.md", "AGENTS.md"]);

function isWantedPath(instructionPath: string): boolean {
	return (
		ALWAYS_ON.has(instructionPath) ||
		pluginPathFor(instructionPath) !== null
	);
}

export interface InstructionRead {
	/** Names the exact content: the same pin is the same files. */
	pin: string;
	files: InstructionFile[];
	/** Files the plugin would have carried that could not be read as text. */
	skipped: string[];
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

async function inBatches<T>(
	items: readonly T[],
	work: (item: T) => Promise<void>,
): Promise<void> {
	const queue = items.values();
	const failures: unknown[] = [];
	const worker = async () => {
		for (;;) {
			const next = queue.next();
			if (next.done || failures.length > 0) {
				return;
			}
			try {
				await work(next.value);
			} catch (error) {
				failures.push(error);
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(READ_CONCURRENCY, items.length) },
			worker,
		),
	);
	if (failures.length > 0) {
		throw failures[0];
	}
}

async function readDirect(
	input: ReadInstructionsInput,
): Promise<InstructionRead> {
	const listing = await input.client.instructions.listRepositoryFiles(
		input.projectId,
		{ org: input.org },
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
	const wanted = listing.files.filter((file) => isWantedPath(file.path));
	const files: InstructionFile[] = [];
	const skipped: string[] = [];

	const readOne = async (file: DirectInstructionRepositoryFile) => {
		const blobId = file.blobId;
		if (blobId !== undefined) {
			const hit = await cached(
				input.cacheDirectory,
				`git-${blobId}`,
				(b) => matchesBlobOid(b, blobId),
			);
			if (hit !== null) {
				files.push({
					path: file.path,
					bytes: hit,
					mode: modeOf(file.mode),
				});
				return;
			}
		}
		const chunks: string[] = [];
		let offset = 0;
		for (let page = 0; page < MAX_PAGES_PER_FILE; page++) {
			const read = await input.client.instructions.getRepositoryFile(
				input.projectId,
				{ ...pin, path: file.path, offset, org: input.org },
			);
			if (read.state !== "found") {
				skipped.push(file.path);
				return;
			}
			chunks.push(read.body);
			if (read.nextOffset === null) {
				const bytes = new TextEncoder().encode(chunks.join(""));
				if (blobId !== undefined && matchesBlobOid(bytes, blobId)) {
					await remember(
						input.cacheDirectory,
						`git-${blobId}`,
						bytes,
					);
				}
				files.push({ path: file.path, bytes, mode: modeOf(file.mode) });
				return;
			}
			offset = read.nextOffset;
		}
		throw new Error(`${file.path} is too long to read.`);
	};
	await inBatches(wanted, readOne);
	return {
		pin: `repo:${pin.generation}:${pin.commitSha}`,
		files,
		skipped: skipped.sort(),
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
		return { pin: "upload:none", files: [], skipped: [] };
	}
	const digest = published.snapshot.digest;
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
	return { pin: `upload:${digest}`, files, skipped: [] };
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
