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
 * are on disk and merges the rest as before. A run onto any other version
 * merges them too. Whichever version a push is stated against, a plain push
 * included, a file the record names is refused while it still holds a conflict
 * marker, so the markers are never sent. A file the record does not name is
 * never refused for its text, and a marker has to start a line, so a document
 * that mentions one in a sentence is not refused either. A successful rebased
 * push removes the record. The record only ever makes a file be taken as the
 * checkout holds it or refused, so a tampered one cannot send anything the
 * developer did not write.
 *
 * ## The proposal a rebase replaces
 *
 * The proposal the checkout's last push opened is stated against the version
 * the lock names. `proposalReplacedByRebase` names it only when there is no
 * guess in it: the caller's one open proposal on that version touching a path
 * this rebase sends. The server's supersede path then closes it when the new
 * proposal is READY, and only if it is the caller's own.
 */
import { createHash } from "node:crypto";
import type {
	FabricClient,
	InstructionManifestEntry,
	OpenInstructionProposal,
} from "@fabricorg/sdk";
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

/**
 * The way out for a file that is meant to hold lines that look like conflict
 * markers, such as a document that shows one at the start of a line.
 */
export const UNRESOLVED_MARKERS_ESCAPE = `If a listed file is meant to hold those lines, delete ${REBASE_STATE_PATH}, which is what makes this check.`;

/** The most paths one version-files request names; the server's own limit. */
const VERSION_FILES_CHUNK = 200;

const DEFAULT_MODE = 0o100644;

interface RebaseState {
	version: typeof REBASE_STATE_VERSION;
	projectId: string;
	fromSnapshotId: string;
	ontoSnapshotId: string;
	paths: string[];
	/**
	 * Paths an earlier rebase onto another version wrote that still hold its
	 * markers. Refused until resolved, then merged: a resolution of those
	 * markers was not made against this rebase's version.
	 */
	earlierPaths?: string[];
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

function isRecordedPathList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every(
			(p) =>
				typeof p === "string" &&
				checkRelativePath(p).ok &&
				!isReservedPath(p),
		)
	);
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
		isRecordedPathList(state.paths) &&
		(state.earlierPaths === undefined ||
			isRecordedPathList(state.earlierPaths))
	);
}

/** This project's record, or null when there is none this build can read. */
async function readRebaseState(
	root: string,
	projectId: string,
): Promise<RebaseState | null> {
	const read = await readFileSafely(root, REBASE_STATE_PATH, {
		maxBytes: 1024 * 1024,
	});
	if (read === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
	} catch {
		return null;
	}
	return isRebaseState(parsed) && parsed.projectId === projectId
		? parsed
		: null;
}

function recordedPathsOf(state: RebaseState): Set<string> {
	return new Set([...state.paths, ...(state.earlierPaths ?? [])]);
}

function holdsConflictMarkers(bytes: Uint8Array): boolean {
	const text = sideOf(bytes)?.text;
	return typeof text === "string" && hasConflictMarkers(text);
}

/**
 * Of the changes a plain push would send, the files a recorded rebase wrote
 * that still hold conflict markers.
 */
export async function unresolvedRebasePaths(input: {
	root: string;
	projectId: string;
	entries: readonly PushPlanEntry[];
}): Promise<string[]> {
	const state = await readRebaseState(input.root, input.projectId);
	if (state === null) {
		return [];
	}
	const recorded = recordedPathsOf(state);
	const unresolved: string[] = [];
	for (const entry of input.entries) {
		if (entry.action !== "put" || !recorded.has(entry.path)) {
			continue;
		}
		const read = await readFileSafely(input.root, entry.path, {
			maxBytes: MAX_INLINE_PUSH_BYTES,
		});
		if (read !== null && holdsConflictMarkers(read.bytes)) {
			unresolved.push(entry.path);
		}
	}
	return unresolved;
}

/**
 * What the record says about this rebase: every file it names, which are
 * refused while they hold markers, and those it wrote for THIS rebase, which
 * are taken as the checkout holds them.
 */
async function rebaseRecord(
	input: RebaseInput,
): Promise<{ recorded: Set<string>; resolved: Set<string> }> {
	const state = await readRebaseState(input.root, input.projectId);
	if (state === null) {
		return { recorded: new Set(), resolved: new Set() };
	}
	const sameRebase =
		state.fromSnapshotId === input.lock.snapshotId &&
		state.ontoSnapshotId === input.published.snapshot.id;
	return {
		recorded: recordedPathsOf(state),
		resolved: new Set(sameRebase ? state.paths : []),
	};
}

async function writeRebaseState(
	input: RebaseInput,
	paths: readonly string[],
	earlierPaths: readonly string[],
): Promise<void> {
	const state: RebaseState = {
		version: REBASE_STATE_VERSION,
		projectId: input.projectId,
		fromSnapshotId: input.lock.snapshotId,
		ontoSnapshotId: input.published.snapshot.id,
		paths: [...new Set(paths)].sort(),
		...(earlierPaths.length > 0
			? { earlierPaths: [...earlierPaths].sort() }
			: {}),
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
	if (outcome.conflicts.some((c) => c.reason === "unresolved")) {
		lines.push(UNRESOLVED_MARKERS_ESCAPE);
	}
	return lines;
}

/**
 * The proposal a rebase replaces, or none, and every other open proposal the
 * caller keeps. Without one candidate to name, nothing is closed.
 */
export type RebaseReplacement = {
	replaces: { snapshotId: string; version: number } | null;
	stillOpen: Array<{ snapshotId: string; version: number }>;
};

/**
 * Names the caller's open proposal this rebase replaces: on the version the
 * rebase started from, touching a path it sends, and the only one that is. It
 * must have finished its checks and be one Fabric reviews itself, as the
 * server's supersede path requires, or nothing is named.
 */
export function proposalReplacedByRebase(input: {
	proposals: readonly OpenInstructionProposal[];
	fromSnapshotId: string;
	paths: readonly string[];
}): RebaseReplacement {
	const sent = new Set(input.paths);
	const snapshots = input.proposals.flatMap((proposal) =>
		proposal.kind === "native" ? [] : [proposal],
	);
	const candidates = snapshots.filter(
		(proposal) =>
			proposal.baseSnapshotId === input.fromSnapshotId &&
			proposal.changes.some((change) => sent.has(change.path)),
	);
	const only = candidates.length === 1 ? candidates[0] : undefined;
	const replaced =
		only?.status === "READY" && only.pullRequest === null ? only : null;
	return {
		replaces: replaced
			? { snapshotId: replaced.snapshotId, version: replaced.version }
			: null,
		stillOpen: snapshots
			.filter((proposal) => proposal !== replaced)
			.map((proposal) => ({
				snapshotId: proposal.snapshotId,
				version: proposal.version,
			})),
	};
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
	const { recorded, resolved } = await rebaseRecord(input);
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

		if (
			recorded.has(entry.path) &&
			ours !== null &&
			holdsConflictMarkers(ours.bytes)
		) {
			conflicts.push({
				path: entry.path,
				reason: "unresolved",
				markers: true,
			});
			continue;
		}

		if (resolved.has(entry.path)) {
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
			const earlier = conflicts
				.filter(
					(conflict) =>
						conflict.reason === "unresolved" &&
						!resolved.has(conflict.path),
				)
				.map((conflict) => conflict.path);
			await writeRebaseState(
				input,
				[
					...writes.map((write) => write.path),
					...conflicts
						.map((conflict) => conflict.path)
						.filter((path) => !earlier.includes(path)),
					...[...resolved].filter((p) =>
						planned.plan.entries.some((entry) => entry.path === p),
					),
				],
				earlier,
			);
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
