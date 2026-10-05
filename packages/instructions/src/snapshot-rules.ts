/**
 * The rules a version of a project's coding instructions was admitted under,
 * read back from the `settingsFrozen` column of its snapshot (Fizzy #2878).
 * Three places apply them to a path and have to agree: the inline change
 * validator (`validateInstructionChanges` in the API), the commit diff's
 * path filter, and the revert of a commit on the synced branch.
 */
import { buildIgnoreMatcher, FABRIC_IGNORE_FILE } from "./ignore";
import { validateRelativePath } from "./paths";

/**
 * The frozen `ignoreGlobs`/`layer` pair a snapshot carries, or null when the
 * `Json` column does not hold that shape.
 *
 * Mirrors `readFrozenIgnoreSettings` in the validation activity, and for the
 * same reason: nothing in the database constrains the column, and an older row
 * can hold anything. A shape this cannot read means only the snapshot's OWN
 * frozen rules are skipped, rather than refusing an edit over a column
 * surprise; the always-excluded paths (`ALWAYS_IGNORE_GLOBS`) still apply,
 * because nothing downstream re-checks them: the gate re-applies the stored
 * `.fabricignore` provenance, not the always layer (Fizzy #2704).
 */
export function readFrozenIgnoreGlobs(
	settingsFrozen: unknown,
): { globs: string[]; layer: "fabricignore" | "project" | "default" } | null {
	if (
		settingsFrozen === null ||
		typeof settingsFrozen !== "object" ||
		Array.isArray(settingsFrozen)
	) {
		return null;
	}
	const { layer, ignoreGlobs } = settingsFrozen as Record<string, unknown>;
	if (
		layer !== "fabricignore" &&
		layer !== "project" &&
		layer !== "default"
	) {
		return null;
	}
	if (
		!Array.isArray(ignoreGlobs) ||
		ignoreGlobs.some((glob) => typeof glob !== "string")
	) {
		return null;
	}
	return { globs: ignoreGlobs as string[], layer };
}

/**
 * Whether a version admitted under `settingsFrozen` can carry a change to
 * `path`, relative to the synced folder: false for a path the rules leave out
 * of a version, which is what makes it a file Fabric's copy never held. A path
 * is left out when it is not a valid relative path in its own spelling, when it
 * is the `.fabricignore` file (which decides the exclusion rules and can only
 * change by uploading the folder), or when the always-excluded globs or the
 * snapshot's own frozen rules match it. Credential-shaped names are not part
 * of this: they have their own refusals where they matter.
 */
export function snapshotRulesLeaveOut(
	path: string,
	settingsFrozen: unknown,
): boolean {
	const checked = validateRelativePath(path);
	if (
		!checked.ok ||
		checked.path !== path ||
		checked.path === FABRIC_IGNORE_FILE
	) {
		return true;
	}
	const isIgnored = buildIgnoreMatcher(
		readFrozenIgnoreGlobs(settingsFrozen) ?? {
			globs: [],
			layer: "default",
		},
	);
	return isIgnored(checked.path) !== null;
}
