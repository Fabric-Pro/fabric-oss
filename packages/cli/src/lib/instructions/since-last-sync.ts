/**
 * The session hook's one-line "what changed since your last sync" note, for a
 * folder that keeps a copy of the instructions. Computed locally from the
 * lock's version before the run, the version it applied, and the files the
 * run wrote: there is no server-side "seen" state for the CLI.
 *
 * Null when there is nothing worth a line: a first sync (no previous lock),
 * a dry run, the same version again (a drift repair is reported elsewhere),
 * or a new version that changed no file in this folder.
 */
const NAMED_PATHS = 3;

export function changedSinceLastSyncLine(input: {
	previousVersion: number | null;
	version: number | null;
	dryRun: boolean;
	added: readonly string[];
	updated: readonly string[];
	replaced: readonly string[];
	removed: readonly string[];
}): string | null {
	if (
		input.dryRun ||
		input.previousVersion === null ||
		input.version === null ||
		input.version === input.previousVersion
	) {
		return null;
	}
	const paths = [
		...new Set([
			...input.added,
			...input.updated,
			...input.replaced,
			...input.removed,
		]),
	].sort((a, b) => a.localeCompare(b));
	if (paths.length === 0) {
		return null;
	}
	const named = paths.slice(0, NAMED_PATHS).join(", ");
	const more =
		paths.length > NAMED_PATHS
			? ` and ${paths.length - NAMED_PATHS} more`
			: "";
	const noun = paths.length === 1 ? "file" : "files";
	return `fabric: ${paths.length} instruction ${noun} changed since your last sync (v${input.previousVersion} → v${input.version}): ${named}${more}`;
}
