export async function sha256Hex(
	bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
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
 * The one normalisation every mode-aware comparison in the coding-instructions
 * feature applies before comparing or hashing: `null`/`undefined` reads as the
 * default `0o644`, and anything else is masked down to its permission bits.
 *
 * The mask matters because the wire contract admits more than bare permission
 * bits: `isAllowedMode` (`packages/cli/src/lib/instructions/safe-write.ts`)
 * validates a manifest entry's mode on `mode & 0o7777` and explicitly accepts
 * a full `st_mode` (e.g. `0o100644`), not only `0o644` itself. Two
 * representations of the same permission that fail this normalisation would
 * hash — and diff, and chmod-compare — differently even though the installer
 * (`permissionBits` in the same file) applies them identically.
 */
function normalizeMode(mode: number | null | undefined): number {
	return mode == null ? DEFAULT_MODE : mode & PERMISSION_MASK;
}

/**
 * sha256 over the snapshot's sorted `path\0sha256\n` lines — the sync key
 * every `sinceDigest` consumer compares against.
 *
 * A file's mode is folded in, but only when its normalised value
 * (`normalizeMode`) is not the default: a line for a `null`, `undefined`,
 * `0o644` or `0o100644` entry is byte-identical to the pre-mode-aware recipe
 * (`path\0sha256\n`), and only a non-default mode appends a third field
 * (`path\0sha256\0755\n`, always the normalised permission bits). That keeps
 * every snapshot already published without an executable file at the same
 * digest an old CLI still verifies, while making the digest change exactly
 * when `treesEqual`
 * (`packages/temporal/src/activities/lib/instruction-sync-tree.ts`) would
 * report a different tree — that check applies the same normalisation.
 */
export async function computeSnapshotDigest(
	entries: ReadonlyArray<{
		path: string;
		sha256: string;
		mode?: number | null;
	}>,
): Promise<string> {
	const lines = [...entries]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((e) => {
			const mode = normalizeMode(e.mode);
			return mode === DEFAULT_MODE
				? `${e.path}\0${e.sha256}\n`
				: `${e.path}\0${e.sha256}\0${mode.toString(8)}\n`;
		})
		.join("");
	return sha256Hex(new TextEncoder().encode(lines));
}
