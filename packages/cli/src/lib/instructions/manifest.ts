/**
 * Deciding whether a server response is a manifest at all.
 *
 * An absent manifest used to become `[]`, and an empty manifest means
 * "delete everything the lock names". A version-skewed server, a truncated
 * proxy response or a field rename was therefore one step away from wiping
 * the tree and writing an empty ledger. A manifest is now either complete
 * and self-consistent or it is a refusal.
 *
 * Three independent things are checked, because each catches a different
 * failure:
 *
 *   - every ENTRY is well-formed, and no two name the same file;
 *   - the COUNT matches the snapshot's own `fileCount`, which catches a
 *     truncated list that is otherwise perfectly well-formed;
 *   - the DIGEST recomputed from the entries matches the snapshot's, which
 *     catches a list that is the right length and the wrong content.
 *
 * The digest recipe is the server's (`packages/instructions/src/manifest.ts`):
 * sha256 over `path\0sha256\n` lines sorted by path, with a mode appended to
 * a line when the file's mode is not the default `0o644`. It is
 * reimplemented here rather than imported because `@repo/instructions` is a
 * private workspace package and this one is published to npm. Keep the two
 * copies in step — a divergence turns every sync into a refusal.
 */
import { createHash } from "node:crypto";
import type { InstructionManifestEntry } from "@fabricorg/sdk";
import {
	checkRelativePath,
	describeRejection,
	findCollision,
	isReservedPath,
} from "./paths.js";
import { isAllowedMode } from "./safe-write.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * What a published snapshot can legitimately be.
 *
 * Mirrors `SNAPSHOT_LIMITS` in `packages/instructions/src/limits.ts`, which
 * bounds what publishing will ACCEPT; these bound what a client will act on.
 * Reimplemented rather than imported for the same reason the digest recipe is:
 * that package is private and this one is published to npm.
 *
 * The point is memory, not policy. Before this, `fileCount` and the per-entry
 * sizes were checked against each other but never against an absolute, so a
 * manifest claiming a million files of 4 GB each was internally consistent and
 * sized the download bound off its own claim.
 *
 * `maxPathBytes` and `maxDepth` are deliberately LOOSER than the server's 512
 * and 32: a client that refuses what the server would happily publish breaks
 * the moment those limits are raised, and 1024 bytes across 5000 files is
 * still bounded. Everything else matches exactly.
 */
const MANIFEST_LIMITS = {
	maxFiles: 5000,
	maxTotalBytes: 52_428_800,
	maxFileBytes: 5_242_880,
	maxPathBytes: 1024,
	maxDepth: 64,
} as const;

/**
 * Per-entry zip framing, in bytes, before the path itself.
 *
 * A zip carries each file twice in structure: a 30-byte local header and a
 * 46-byte central-directory header, each followed by the name, plus optional
 * extra fields and a data descriptor. 512 is generous for all of it, and
 * generous is the right direction — this is a ceiling on what will be
 * DOWNLOADED, and a bound that is too tight refuses a snapshot the server
 * considers perfectly valid.
 */
const ZIP_ENTRY_OVERHEAD_BYTES = 512;

/**
 * The largest archive worth downloading for this manifest.
 *
 * A flat slack was wrong: zip framing grows with the number of entries and
 * the length of their names, so a legitimate snapshot of 5000 empty files
 * with 200-byte paths needs about 2.4 MB of pure structure and could not be
 * synced at all. The bound now scales the way the format does.
 */
export function maxArchiveBytes(
	entries: ReadonlyArray<{ path: string; size: number }>,
): number {
	let total = 1_048_576;
	for (const entry of entries) {
		total +=
			entry.size +
			ZIP_ENTRY_OVERHEAD_BYTES +
			2 * Buffer.byteLength(entry.path, "utf8");
	}
	return total;
}

/**
 * `0o644` is the mode a file has when no source recorded one at all (an
 * upload's `mode: null`), so it is the one value that never needs to change
 * the digest.
 */
const DEFAULT_MODE = 0o644;

/** Everything but the permission bits — setuid/setgid/sticky and the file-type nibble. */
const PERMISSION_MASK = 0o7777;

/**
 * The one normalisation every mode-aware comparison in this feature applies
 * before comparing or hashing: `null`/`undefined` reads as the default
 * `0o644`, and anything else is masked down to its permission bits.
 *
 * The mask matters because `isAllowedMode` below validates a manifest
 * entry's mode on `mode & 0o7777` and explicitly accepts a full `st_mode`
 * (e.g. `0o100644`), not only `0o644` itself — two representations of the
 * same permission that skipped this normalisation would hash differently
 * even though `permissionBits` (also below) applies them identically.
 */
function normalizeMode(mode: number | null | undefined): number {
	return mode == null ? DEFAULT_MODE : mode & PERMISSION_MASK;
}

/**
 * The snapshot digest, computed the way the server computes it.
 *
 * Keep in step with `computeSnapshotDigest` in `@repo/instructions`. A
 * divergence here turns every sync into a refusal, which is the safe
 * direction but still a break.
 *
 * A file's mode is folded in, but only when its normalised value
 * (`normalizeMode`) is not the default: a line for a `null`, `undefined`,
 * `0o644` or `0o100644` entry is byte-identical to the pre-mode-aware recipe
 * (`path\0sha256\n`), and only a non-default mode appends a third field
 * (`path\0sha256\0755\n`, always the normalised permission bits). That is
 * what lets every snapshot already published without an executable file
 * keep a digest an old CLI can still verify.
 */
export function computeSnapshotDigest(
	entries: ReadonlyArray<{
		path: string;
		sha256: string;
		mode?: number | null;
	}>,
): string {
	const lines = [...entries]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((entry) => {
			const mode = normalizeMode(entry.mode);
			return mode === DEFAULT_MODE
				? `${entry.path}\0${entry.sha256}\n`
				: `${entry.path}\0${entry.sha256}\0${mode.toString(8)}\n`;
		})
		.join("");
	return createHash("sha256")
		.update(Buffer.from(lines, "utf8"))
		.digest("hex");
}

/**
 * The digest a snapshot published BEFORE this change would carry, even if it
 * contains a `0755` file: the pre-mode-aware recipe, computed by stripping
 * every entry's mode before hashing rather than duplicating the hashing code
 * a third time.
 *
 * Such a snapshot is never recomputed after the fact, so a new CLI must still
 * be able to install it. Accepting EITHER value is therefore not a laxer
 * check — it is the same check against the two digests a manifest can
 * legitimately carry.
 */
function computeLegacySnapshotDigest(
	entries: ReadonlyArray<{ path: string; sha256: string }>,
): string {
	return computeSnapshotDigest(
		entries.map((entry) => ({ ...entry, mode: undefined })),
	);
}

/**
 * Validate a published manifest, or explain why it is not one.
 *
 * Throws rather than returning a result: every caller's only response to a
 * bad manifest is to stop, and under `--hook` the message becomes the one
 * line a developer sees.
 */
export function assertValidManifest(input: {
	manifest: unknown;
	snapshot: { digest: string; fileCount: number; version: number };
}): InstructionManifestEntry[] {
	const { manifest, snapshot } = input;

	if (!Array.isArray(manifest)) {
		throw new Error(
			`The server described version ${snapshot.version} as published but sent no file manifest. Nothing was changed.`,
		);
	}

	if (manifest.length > MANIFEST_LIMITS.maxFiles) {
		throw new Error(
			`The manifest for version ${snapshot.version} lists ${manifest.length} files and a published snapshot holds at most ${MANIFEST_LIMITS.maxFiles}. Nothing was changed.`,
		);
	}

	const entries: InstructionManifestEntry[] = [];
	for (const raw of manifest) {
		entries.push(validateEntry(raw));
	}

	const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
	if (totalBytes > MANIFEST_LIMITS.maxTotalBytes) {
		throw new Error(
			`The manifest for version ${snapshot.version} describes ${totalBytes} bytes and a published snapshot holds at most ${MANIFEST_LIMITS.maxTotalBytes}. Nothing was changed.`,
		);
	}

	const collision = findCollision(entries.map((entry) => entry.path));
	if (collision !== null) {
		throw new Error(
			`Refusing to sync: ${describeRejection({
				ok: false,
				reason: "collision",
				detail: `${collision.first} and ${collision.second}`,
			})}.`,
		);
	}

	if (entries.length !== snapshot.fileCount) {
		throw new Error(
			`The manifest for version ${snapshot.version} lists ${entries.length} files and the snapshot says ${snapshot.fileCount}. Nothing was changed.`,
		);
	}

	// A snapshot published before mode joined the digest recipe carries the
	// LEGACY (mode-less) value even when one of its files is 0755, and that
	// snapshot is never recomputed — so a manifest is accepted when it
	// matches either recipe. The error still reports the new recipe's hash:
	// that is the one a fresh publish is expected to match, and the message
	// is unchanged either way.
	const recomputed = computeSnapshotDigest(entries);
	if (
		recomputed !== snapshot.digest &&
		computeLegacySnapshotDigest(entries) !== snapshot.digest
	) {
		throw new Error(
			`The manifest for version ${snapshot.version} does not match its own digest (${snapshot.digest}); it hashes to ${recomputed}. Nothing was changed.`,
		);
	}

	return entries;
}

function validateEntry(raw: unknown): InstructionManifestEntry {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(
			"The server sent a manifest entry that is not an object. Nothing was changed.",
		);
	}
	const entry = raw as Record<string, unknown>;

	if (typeof entry.path !== "string") {
		throw new Error(
			"The server sent a manifest entry with no path. Nothing was changed.",
		);
	}
	const check = checkRelativePath(entry.path);
	if (!check.ok) {
		throw new Error(
			`Refusing to sync: ${describeRejection(check)}. The published snapshot names a path this tool will not write.`,
		);
	}
	const pathBytes = Buffer.byteLength(entry.path, "utf8");
	if (pathBytes > MANIFEST_LIMITS.maxPathBytes) {
		throw new Error(
			`The manifest entry for ${entry.path.slice(0, 80)}… has a ${pathBytes}-byte path and at most ${MANIFEST_LIMITS.maxPathBytes} is accepted. Nothing was changed.`,
		);
	}
	if (entry.path.split("/").length > MANIFEST_LIMITS.maxDepth) {
		throw new Error(
			`The manifest entry for ${entry.path} is nested deeper than ${MANIFEST_LIMITS.maxDepth} directories. Nothing was changed.`,
		);
	}
	if (isReservedPath(entry.path)) {
		throw new Error(
			`Refusing to sync: ${describeRejection({
				ok: false,
				reason: "reserved_path",
				detail: entry.path,
			})}.`,
		);
	}
	if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
		throw new Error(
			`The manifest entry for ${entry.path} has no 64-character hex sha256. Nothing was changed.`,
		);
	}
	if (
		typeof entry.size !== "number" ||
		!Number.isInteger(entry.size) ||
		entry.size < 0
	) {
		throw new Error(
			`The manifest entry for ${entry.path} has no non-negative integer size. Nothing was changed.`,
		);
	}
	if (entry.size > MANIFEST_LIMITS.maxFileBytes) {
		throw new Error(
			`The manifest entry for ${entry.path} declares ${entry.size} bytes and a published file holds at most ${MANIFEST_LIMITS.maxFileBytes}. Nothing was changed.`,
		);
	}
	if (
		entry.mode !== null &&
		(typeof entry.mode !== "number" || !Number.isInteger(entry.mode))
	) {
		throw new Error(
			`The manifest entry for ${entry.path} has a mode that is neither null nor an integer. Nothing was changed.`,
		);
	}
	if (!isAllowedMode(entry.mode as number | null)) {
		throw new Error(
			`Refusing to sync: ${entry.path} asks for file mode ${((entry.mode as number) ?? 0).toString(8)}, and only 644 and 755 are accepted.`,
		);
	}

	return {
		path: entry.path,
		sha256: entry.sha256,
		size: entry.size,
		mode: entry.mode as number | null,
		kind: (entry.kind ?? "OTHER") as InstructionManifestEntry["kind"],
	};
}
