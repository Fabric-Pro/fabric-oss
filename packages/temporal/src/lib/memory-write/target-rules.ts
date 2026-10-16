/**
 * Where a Living Memory write folder may be (ADR-022). Pure: no I/O, no clock.
 *
 * A write target is a repository folder, inside what the project's repository
 * sync selects, that agents' files are written into. The same function decides
 * it when an administrator creates or edits a target and again when a write is
 * admitted (`validate-memory-write.ts`), so a target a later `configure` has
 * left outside the selection is refused at admission as stale, by the rule that
 * would have refused it today.
 *
 * The rules are the sync's own, imported rather than copied: the canonical
 * spelling and length (`contextSyncPathSpellingProblem`), the whole-segment
 * containment (`isStrictlyInsideContextSyncPath`), the member's left-out paths
 * (`isAtOrUnderLeftOutKey`), and the default exclusions matched relative to
 * the selected path the folder sits in, as a run matches them. Whatever a run
 * would leave out, a target cannot be.
 *
 * Two things are never targets, whatever the sync selects. Reserved folders
 * (`reservedProblem`): the repository root and anything with a dot-prefixed
 * segment, because CI and tool configuration must never be agent-writable.
 * Instruction folders: a folder that overlaps, in either direction, the root
 * of a coding-instructions sync on the same repository integration is refused.
 * Coding instructions keep their own reviewed path.
 *
 * The order is the order a person would fix them in: spelling, reserved,
 * selection, exclusion, instructions, then the other targets. The first
 * refusal is returned, as `configure` returns its first.
 */
import { isStrictlyInsideContextSyncPath } from "@repo/database";
import { contextSyncPathSpellingProblem } from "@repo/instructions/context-sync-rules";
import {
	buildContextIgnoreRules,
	isAtOrUnderLeftOutKey,
	matchContextEntry,
	relativeToSelectedFolder,
} from "../../activities/lib/context-sync-rules";

/** A sync names at most this many write folders. */
export const MAX_CONTEXT_WRITE_TARGETS = 10;

/** Git's tree-entry mode for a folder: matched as a file or a folder. */
const GIT_TREE_MODE = "040000";

type WriteTargetProblemCode =
	| "INVALID_PATH"
	| "TARGET_RESERVED"
	| "TARGET_OUTSIDE_SELECTION"
	| "TARGET_EXCLUDED"
	| "TARGET_OVERLAP"
	| "TARGET_OVERLAPS_INSTRUCTIONS"
	| "TOO_MANY_TARGETS";

export type WriteTargetProblem = {
	code: WriteTargetProblemCode;
	/** The folder asked for. */
	path: string;
	/** The other target or instruction root it overlaps, where there is one. */
	withPath?: string;
	message: string;
};

/** The part of a sync's configuration a target is judged against. */
export type WriteTargetSelection = {
	paths: readonly string[];
	excludedPaths: readonly string[];
};

/** `a` is `b`'s ancestor or equal, by whole segments. */
function isSegmentPrefix(a: string, b: string): boolean {
	return a === b || isStrictlyInsideContextSyncPath(a, b);
}

/** The selected path the folder sits in or equals; sync paths never nest. */
export function selectedPathContaining(
	selection: WriteTargetSelection,
	folder: string,
): string | null {
	return (
		selection.paths.find((path) => isSegmentPrefix(path, folder)) ?? null
	);
}

function spellingProblem(folder: string): WriteTargetProblem | null {
	switch (contextSyncPathSpellingProblem(folder)) {
		case null:
			return null;
		case "too-long":
			return {
				code: "INVALID_PATH",
				path: folder,
				message: "A write folder's path is too long.",
			};
		case "not-canonical":
			return {
				code: "INVALID_PATH",
				path: folder,
				message: `"${folder}" is not a repository path in its plain form: use '/' between folders, with no leading './' or '/', no trailing '/', no '.' or '..' segments and no surrounding spaces.`,
			};
	}
}

/**
 * A folder agents never write into, whatever the sync selects: the repository
 * root, or any folder with a segment that starts with a dot (`.github`,
 * `.gitlab`, `.azuredevops`, `.circleci`, `.devcontainer`, `.vscode`,
 * `.husky`, and the Fabric CLI's own `.fabric`). Those hold CI and tool
 * configuration, which a build system or an editor runs, so a file written
 * there would turn a memory write into code execution. A rule on the shape
 * of the name needs no list to keep current. Checked on the spelled folder
 * alone, so it holds whatever the selection becomes.
 */
function reservedProblem(folder: string): WriteTargetProblem | null {
	if (folder === "") {
		return {
			code: "TARGET_RESERVED",
			path: folder,
			message:
				"Agents never write to the repository root. Choose a folder inside it.",
		};
	}
	const hidden = folder.split("/").find((segment) => segment.startsWith("."));
	if (hidden !== undefined) {
		return {
			code: "TARGET_RESERVED",
			path: folder,
			message: `"${folder}" has a segment that starts with a dot ("${hidden}"). Such folders hold CI and tool configuration, which agents never write.`,
		};
	}
	return null;
}

/**
 * Whether the folder is a valid write target for the sync as configured now:
 * spelling, not reserved, inside the selection, and not left out by anything
 * the sync leaves out. Not the target set: that is `validateWriteTargetFolder`.
 * Admission runs this alone, because the other targets cannot change under it.
 */
export function checkWriteTargetFolder(input: {
	folder: string;
	selection: WriteTargetSelection;
	instructionRoots: readonly string[];
}): WriteTargetProblem | null {
	const { folder, selection, instructionRoots } = input;

	const spelling = spellingProblem(folder);
	if (spelling) {
		return spelling;
	}
	const reserved = reservedProblem(folder);
	if (reserved) {
		return reserved;
	}

	const selected = selectedPathContaining(selection, folder);
	if (selected === null) {
		return {
			code: "TARGET_OUTSIDE_SELECTION",
			path: folder,
			message: `"${folder}" is not inside a folder this project's Living Memory syncs, so nothing written there would be read back.`,
		};
	}

	if (isAtOrUnderLeftOutKey(folder, selection.excludedPaths)) {
		return {
			code: "TARGET_EXCLUDED",
			path: folder,
			message: `"${folder}" is left out of this project's Living Memory sync.`,
		};
	}
	// The defaults apply inside a selected folder, relative to it: the selected
	// path itself is never judged by them (a selected `skills` folder syncs its
	// own files), only the folders beneath it.
	const relative = relativeToSelectedFolder(selected, folder);
	if (
		relative !== null &&
		matchContextEntry(
			buildContextIgnoreRules(),
			relative,
			GIT_TREE_MODE,
		) !== "kept"
	) {
		return {
			code: "TARGET_EXCLUDED",
			path: folder,
			message: `"${folder}" is a folder Living Memory never syncs (version-control and tool state, or coding instructions), so nothing written there would be read back.`,
		};
	}

	for (const root of instructionRoots) {
		if (isSegmentPrefix(root, folder) || isSegmentPrefix(folder, root)) {
			return {
				code: "TARGET_OVERLAPS_INSTRUCTIONS",
				path: folder,
				withPath: root,
				message:
					root === ""
						? `"${folder}" is in the folder this project's coding instructions are read from, which agents never write into.`
						: `"${folder}" overlaps "${root}", where this project's coding instructions are read from, which agents never write into.`,
			};
		}
	}
	return null;
}

/**
 * Whether the folder may join the sync's targets: valid on its own
 * (`checkWriteTargetFolder`), no prefix overlap with another target, and room
 * for it. `siblingFolders` is every OTHER target of the sync, so an edit does
 * not overlap the target it replaces.
 */
export function validateWriteTargetFolder(input: {
	folder: string;
	selection: WriteTargetSelection;
	instructionRoots: readonly string[];
	siblingFolders: readonly string[];
}): WriteTargetProblem | null {
	const own = checkWriteTargetFolder(input);
	if (own) {
		return own;
	}
	const { folder, siblingFolders } = input;
	for (const sibling of siblingFolders) {
		if (
			isSegmentPrefix(sibling, folder) ||
			isSegmentPrefix(folder, sibling)
		) {
			return {
				code: "TARGET_OVERLAP",
				path: folder,
				withPath: sibling,
				message:
					sibling === folder
						? `"${folder}" is already a write folder.`
						: `"${folder}" overlaps "${sibling}", which is already a write folder.`,
			};
		}
	}
	if (siblingFolders.length >= MAX_CONTEXT_WRITE_TARGETS) {
		return {
			code: "TOO_MANY_TARGETS",
			path: folder,
			message: `A project's Living Memory has at most ${MAX_CONTEXT_WRITE_TARGETS} write folders.`,
		};
	}
	return null;
}
