/**
 * `fabric instructions push --rebase`: carry this checkout's edits onto the
 * version published since the last sync, instead of refusing with
 * `PULL_FIRST`.
 *
 * ## The three versions of a file
 *
 *   base     the version the lock names: what the last sync wrote
 *   ours     the checkout's file now
 *   theirs   the version published now
 *
 * `base` is read from that version's own record (the `versions/:id/files`
 * route) and every byte is checked against the lock's ledger, so a lock
 * edited by hand is refused exactly as a plain push refuses it. `theirs` is
 * read the way sync reads it, checked against the published manifest. Each
 * path the checkout changed is merged by `mergeInstructionPath`; paths only
 * the published side changed are not touched at all.
 *
 * ## What is written, and what never is
 *
 * The LOCK is never written, on any outcome: the checkout has still synced
 * only the version it names. A clean merge writes the merged text into the
 * working tree, so what is sent is what is on disk. A conflict writes the
 * file with git-style conflict markers when it is text, leaves a binary or
 * delete-against-edit file alone, and sends NOTHING.
 *
 * ## Resolving a conflict
 *
 * Merging a resolved file again would conflict again: its resolution is a
 * third text neither side wrote. So a conflicted run records, in
 * `.fabric/rebase.json`, the version it rebased onto and the paths it wrote.
 * The next `push --rebase` onto that same version takes those files as they
 * are on disk, refusing any that still hold a conflict marker, and merges the
 * rest as before. A run onto any other version ignores the record. A
 * successful push removes it. The record only ever makes a file be taken as
 * the checkout holds it, so a tampered one cannot send anything the
 * developer did not write.
 */
import { createHash } from "node:crypto";
import type { FabricClient, InstructionManifestEntry } from "@fabricorg/sdk";
import { fetchBundle } from "./bundle.js";
import { fetchFilesByUrl } from "./file-downloads.js";
import type { OverrideMatcher } from "./local-overrides.js";
import { type InstructionsLock, LOCK_DIRECTORY } from "./lock.js";
import { checkRelativePath, isReservedPath } from "./paths.js";
import {
	computePushPlan,
	type LedgerManifestEntry,
	MAX_INLINE_PUSH_BYTES,
	type PushPlan,
	type PushPlanEntry,
	setAsideOverridden,
} from "./push.js";
import {
	deleteFileSafely,
	isAllowedMode,
	readFileSafely,
	writeFileSafely,
} from "./safe-write.js";
import {
	type ConflictReason,
	hasConflictMarkers,
	type MergeSide,
	mergeInstructionPath,
} from "./three-way-merge.js";

const REBASE_STATE_PATH = `${LOCK_DIRECTORY}/rebase.json`;

const REBASE_STATE_VERSION = 1;

/** The most paths one version-files request names; the server's own limit. */
const VERSION_FILES_CHUNK = 200;

const DEFAULT_MODE = 0o100644;

interface RebaseState {
	version: typeof REBASE_STATE_VERSION;
	projectId: string;
	fromSnapshotId: string;
	ontoSnapshotId: string;
	paths: string[];
}

interface RebaseConflict {
	path: string;
	reason: ConflictReason | "unresolved";
	/** Whether the file now holds conflict markers to resolve. */
	markers: boolean;
}

export type RebaseOutcome =
	| {
			kind: "clean";
			/** The change set against the published version. */
			plan: PushPlan;
			/** Paths whose merged text was written into the checkout. */
			merged: string[];
			overridden: string[];
	  }
	| {
			kind: "conflicts";
			conflicts: RebaseConflict[];
			merged: string[];
			overridden: string[];
	  };

export interface RebaseInput {
	client: {
		instructions: Pick<
			FabricClient["instructions"],
			"createVersionFileDownloadUrls" | "createFileDownloadUrls"
		>;
	};
	projectId: string;
	org?: string;
	/** An already-canonical root. */
	root: string;
	lock: InstructionsLock;
	published: {
		snapshot: { id: string; version: number; digest: string };
		manifest: readonly InstructionManifestEntry[];
	};
	added: readonly string[];
	isOverridden: OverrideMatcher;
	dryRun: boolean;
	timeoutMs: number;
}

interface BaseFile {
	sha256: string;
	size: number;
	url: string;
}

/** The server no longer keeps the version the lock names. */
export class BaseVersionRemovedError extends Error {
	constructor(readonly version: number) {
		super(`Version ${version} is no longer kept.`);
		this.name = "BaseVersionRemovedError";
	}
}

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sideOf(bytes: Uint8Array | null): MergeSide {
	if (bytes === null) {
		return null;
	}
	let text: string | null;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		text = null;
	}
	return { hash: sha256Of(bytes), text };
}

/**
 * The version the lock names, path by path, as that version's own record
 * holds it. A path the record does not hold is simply absent from the
 * answer, so the ledger check refuses a lock that lists one.
 */
async function readBaseRecord(
	input: RebaseInput,
): Promise<Map<string, BaseFile>> {
	const paths = Object.keys(input.lock.files).sort();
	const base = new Map<string, BaseFile>();
	for (let i = 0; i < paths.length; i += VERSION_FILES_CHUNK) {
		const chunk = paths.slice(i, i + VERSION_FILES_CHUNK);
		const asked = new Set(chunk);
		const response = await input.client.instructions
			.createVersionFileDownloadUrls(
				input.projectId,
				input.lock.snapshotId,
				chunk,
				{ org: input.org },
			)
			.catch((error: unknown) => {
				// The project was just read successfully through the same gate, so
				// a 404 here is the version, not the project.
				if ((error as { status?: number }).status === 404) {
					throw new BaseVersionRemovedError(
						input.lock.snapshotVersion,
					);
				}
				throw error;
			});
		if (response.snapshotId !== input.lock.snapshotId) {
			throw new Error(
				"The server answered for a different version than the one this checkout last synced. Nothing was sent.",
			);
		}
		for (const file of response.files) {
			if (!asked.has(file.path) || base.has(file.path)) {
				throw new Error(
					"The server returned a file that was not asked for. Nothing was sent.",
				);
			}
			base.set(file.path, {
				sha256: file.sha256,
				size: file.size,
				url: file.url,
			});
		}
	}
	return base;
}

async function downloadBase(
	path: string,
	file: BaseFile,
	timeoutMs: number,
): Promise<Uint8Array> {
	const bytes = await fetchBundle(file.url, {
		timeoutMs,
		maxBytes: file.size,
	});
	if (bytes.length !== file.size || sha256Of(bytes) !== file.sha256) {
		throw new Error(
			`A downloaded file does not match the version this checkout last synced (${path}). Nothing was sent.`,
		);
	}
	return bytes;
}

async function readOurs(
	root: string,
	entry: PushPlanEntry,
): Promise<{ bytes: Uint8Array; mode: number } | null> {
	if (entry.action === "delete") {
		return null;
	}
	const read = await readFileSafely(root, entry.path, {
		maxBytes: MAX_INLINE_PUSH_BYTES,
	});
	if (read === null || sha256Of(read.bytes) !== entry.sha256) {
		throw new Error(
			`Refusing to push: ${entry.path} changed while this command ran. Run it again.`,
		);
	}
	return read;
}

function isRebaseState(value: unknown): value is RebaseState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const state = value as Record<string, unknown>;
	return (
		state.version === REBASE_STATE_VERSION &&
		typeof state.projectId === "string" &&
		typeof state.fromSnapshotId === "string" &&
		typeof state.ontoSnapshotId === "string" &&
		Array.isArray(state.paths) &&
		state.paths.every(
			(p) =>
				typeof p === "string" &&
				checkRelativePath(p).ok &&
				!isReservedPath(p),
		)
	);
}

/**
 * The paths an earlier conflicted run wrote for THIS rebase, which are taken
 * as the checkout holds them. Anything else, a record for another rebase
 * or one this build cannot read, resolves nothing.
 */
async function resolvedPaths(input: RebaseInput): Promise<Set<string>> {
	const read = await readFileSafely(input.root, REBASE_STATE_PATH, {
		maxBytes: 1024 * 1024,
	});
	if (read === null) {
		return new Set();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
	} catch {
		return new Set();
	}
	if (
		!isRebaseState(parsed) ||
		parsed.projectId !== input.projectId ||
		parsed.fromSnapshotId !== input.lock.snapshotId ||
		parsed.ontoSnapshotId !== input.published.snapshot.id
	) {
		return new Set();
	}
	return new Set(parsed.paths);
}

async function writeRebaseState(
	input: RebaseInput,
	paths: readonly string[],
): Promise<void> {
	const state: RebaseState = {
		version: REBASE_STATE_VERSION,
		projectId: input.projectId,
		fromSnapshotId: input.lock.snapshotId,
		ontoSnapshotId: input.published.snapshot.id,
		paths: [...new Set(paths)].sort(),
	};
	await writeFileSafely({
		root: input.root,
		relativePath: REBASE_STATE_PATH,
		bytes: new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`),
	});
}

/** Remove the conflict record once the rebased change set was accepted. */
export async function clearRebaseState(root: string): Promise<void> {
	const read = await readFileSafely(root, REBASE_STATE_PATH, {
		maxBytes: 1024 * 1024,
	});
	if (read !== null) {
		await deleteFileSafely(root, REBASE_STATE_PATH, sha256Of(read.bytes));
	}
}

/** What a conflicted rebase tells the developer, line by line. */
export function rebaseConflictLines(
	outcome: Extract<RebaseOutcome, { kind: "conflicts" }>,
	ontoVersion: number,
	againCommand: string,
	dryRun: boolean,
): string[] {
	const lines = [
		`Could not merge every edit onto version ${ontoVersion}. Nothing was sent, and the lock was not changed.`,
	];
	if (dryRun) {
		lines.push(
			"This was a dry run: no file was written. Without --dry-run, the files below would be.",
		);
	}
	const section = (label: string, paths: readonly string[]) => {
		if (paths.length > 0) {
			lines.push(`  ${label}:`, ...paths.map((p) => `    ${p}`));
		}
	};
	section(
		"conflicts written into the file, between <<<<<<< and >>>>>>> markers",
		outcome.conflicts
			.filter((c) => c.markers && c.reason !== "unresolved")
			.map((c) => c.path),
	);
	section(
		"still holding conflict markers",
		outcome.conflicts
			.filter((c) => c.reason === "unresolved")
			.map((c) => c.path),
	);
	section(
		"left as they were: binary files, which cannot hold conflict markers",
		outcome.conflicts.filter((c) => !c.markers).map((c) => c.path),
	);
	section("merged cleanly", outcome.merged);
	lines.push(
		`Make each listed file what it should be (delete it to propose its removal), then run \`${againCommand}\` again.`,
	);
	return lines;
}

function putEntry(path: string, bytes: Uint8Array): PushPlanEntry {
	return {
		path,
		action: "put",
		size: bytes.length,
		sha256: sha256Of(bytes),
	};
}

export async function rebasePush(input: RebaseInput): Promise<RebaseOutcome> {
	const base = await readBaseRecord(input);
	const baseManifest: LedgerManifestEntry[] = [...base].map(
		([path, file]) => ({ path, sha256: file.sha256 }),
	);
	const planned = setAsideOverridden(
		await computePushPlan({
			root: input.root,
			lock: input.lock,
			manifest: baseManifest,
			added: input.added,
		}),
		input.isOverridden,
	);
	const resolved = await resolvedPaths(input);
	const published = new Map(
		input.published.manifest.map((entry) => [entry.path, entry]),
	);
	const theirsBytes = await fetchFilesByUrl({
		client: input.client,
		projectId: input.projectId,
		org: input.org,
		digest: input.published.snapshot.digest,
		files: planned.plan.entries.flatMap((entry) => {
			const file = published.get(entry.path);
			return file === undefined
				? []
				: [{ path: file.path, size: file.size, sha256: file.sha256 }];
		}),
		timeoutMs: input.timeoutMs,
	});
	const labels = {
		ours: "local",
		theirs: `published-v${input.published.snapshot.version}`,
	};

	const entries: PushPlanEntry[] = [];
	const writes: Array<{ path: string; bytes: Uint8Array; mode: number }> = [];
	const merged: string[] = [];
	const conflicts: RebaseConflict[] = [];

	for (const entry of planned.plan.entries) {
		const ours = await readOurs(input.root, entry);
		const theirs = theirsBytes.get(entry.path) ?? null;
		const theirsEntry = published.get(entry.path);
		const mode =
			ours !== null && isAllowedMode(ours.mode)
				? ours.mode
				: isAllowedMode(theirsEntry?.mode)
					? (theirsEntry?.mode ?? DEFAULT_MODE)
					: DEFAULT_MODE;

		if (resolved.has(entry.path)) {
			const text = ours === null ? null : sideOf(ours.bytes)?.text;
			if (typeof text === "string" && hasConflictMarkers(text)) {
				conflicts.push({
					path: entry.path,
					reason: "unresolved",
					markers: true,
				});
				continue;
			}
			const sameAsPublished =
				ours === null
					? theirs === null
					: theirs !== null &&
						sha256Of(theirs) === sha256Of(ours.bytes);
			if (!sameAsPublished) {
				entries.push(entry);
			}
			continue;
		}

		const baseFile = base.get(entry.path);
		const baseBytes =
			baseFile === undefined
				? null
				: await downloadBase(entry.path, baseFile, input.timeoutMs);
		const result = mergeInstructionPath({
			base: sideOf(baseBytes),
			ours: sideOf(ours?.bytes ?? null),
			theirs: sideOf(theirs),
			labels,
		});
		switch (result.kind) {
			case "unchanged":
			case "take-theirs":
				break;
			case "take-ours":
				entries.push(entry);
				break;
			case "merged": {
				const bytes = new TextEncoder().encode(result.text);
				writes.push({ path: entry.path, bytes, mode });
				entries.push(putEntry(entry.path, bytes));
				merged.push(entry.path);
				break;
			}
			case "conflict":
				if (result.text !== null) {
					writes.push({
						path: entry.path,
						bytes: new TextEncoder().encode(result.text),
						mode,
					});
				}
				conflicts.push({
					path: entry.path,
					reason: result.reason,
					markers: result.text !== null,
				});
				break;
			default: {
				const unreachable: never = result;
				throw new Error(
					`Unhandled merge result: ${String(unreachable)}`,
				);
			}
		}
	}

	if (!input.dryRun) {
		for (const write of writes) {
			await writeFileSafely({
				root: input.root,
				relativePath: write.path,
				bytes: write.bytes,
				mode: write.mode,
			});
		}
		if (conflicts.length > 0) {
			await writeRebaseState(input, [
				...writes.map((write) => write.path),
				...conflicts.map((conflict) => conflict.path),
				...[...resolved].filter((p) =>
					planned.plan.entries.some((entry) => entry.path === p),
				),
			]);
		}
	}

	if (conflicts.length > 0) {
		return {
			kind: "conflicts",
			conflicts,
			merged,
			overridden: planned.overridden,
		};
	}
	return {
		kind: "clean",
		plan: { entries, unchanged: planned.plan.unchanged },
		merged,
		overridden: planned.overridden,
	};
}
