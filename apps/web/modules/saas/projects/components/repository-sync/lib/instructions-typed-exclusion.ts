/**
 * Coding Instructions' typed "leave out" input, offered where the tree
 * cannot reach every path (no listing, a truncated one, or a failed one).
 * Pure. A typed path stages the same edit unticking its row would
 * (`addRule`, `./instructions-selection`): `F/**` for a folder (typed with a
 * trailing `/`), the path relative to the synced folder for a file, refused
 * on the same grounds a tick is — a replacing `.fabricignore`, unknown
 * rules, a name with `*` or `?`, a pattern too long to store, a full list
 * (the defaults a first custom rule copies in counted) — and when it is not
 * inside the synced folder or is already a rule.
 */
import {
	PROJECT_IGNORE_GLOB_LIMITS,
	validateRelativePath,
} from "@repo/instructions";
import {
	folderExclusionPattern,
	sameRule,
	stagedProjectGlobs,
} from "../../../lib/instructions-sync-exclusions";
import {
	applyInstructionsAction,
	type InstructionsAction,
	type InstructionsSelectionModel,
} from "./instructions-selection";
import { isStrictlyInside } from "./repository-tree";
import type { SelectionMessage } from "./selection-row";

const TYPED = "configureDialog.typedExclusion";

/** Why the input takes no paths now, or `null` when it does. */
export function instructionsTypedExclusionBlock(
	model: InstructionsSelectionModel,
): SelectionMessage | null {
	if (model.selection.root === null) {
		return { key: `${TYPED}.noFolder` };
	}
	if (model.rules === "loading") {
		return { key: "tree.selection.cantTellYet" };
	}
	if (model.rules === "failed") {
		return { key: `${TYPED}.rulesUnknown` };
	}
	return model.layer === "fabricignore"
		? { key: `${TYPED}.fabricignore` }
		: null;
}

/** The edit a typed path stages, or why it is refused. */
export function instructionsTypedExclusion(input: {
	raw: string;
	model: InstructionsSelectionModel;
	/** The project's saved list: `null` for no setting. */
	savedGlobs: readonly string[] | null | undefined;
}):
	| { ok: true; action: InstructionsAction }
	| { ok: false; message: SelectionMessage } {
	const { model } = input;
	const refuse = (
		message: SelectionMessage,
	): { ok: false; message: SelectionMessage } => ({ ok: false, message });
	const block = instructionsTypedExclusionBlock(model);
	const root = model.selection.root;
	if (block || root === null) {
		return refuse(block ?? { key: `${TYPED}.noFolder` });
	}
	const raw = input.raw.trim();
	if (raw === "") {
		return refuse({ key: `${TYPED}.empty` });
	}
	// Before the spelling check, which refuses these too: a name with `*`
	// or `?` would be read as a pattern, not as itself.
	if (/[*?]/.test(raw)) {
		return refuse({ key: "tree.selection.wildcard" });
	}
	const folder = /[/\\]$/.test(raw);
	const canonical = validateRelativePath(raw);
	if (!canonical.ok) {
		return refuse({ key: `${TYPED}.invalid`, values: { path: raw } });
	}
	const path = canonical.path;
	if (root !== "" && !isStrictlyInside(root, path)) {
		return refuse({
			key: `${TYPED}.outside`,
			values: { path, folder: root },
		});
	}
	const relative = root === "" ? path : path.slice(root.length + 1);
	const pattern = folder ? folderExclusionPattern(relative) : relative;
	if (pattern.length > PROJECT_IGNORE_GLOB_LIMITS.maxGlobLength) {
		return refuse({ key: "tree.selection.tooLong" });
	}
	const saved = input.savedGlobs ?? null;
	const staged = stagedProjectGlobs(saved, model.selection.edits) ?? [];
	if (staged.some((rule) => sameRule(rule, pattern))) {
		return refuse({ key: `${TYPED}.duplicate`, values: { path } });
	}
	const action: InstructionsAction = {
		type: "addRule",
		pattern,
		coveredFolder: folder ? relative : null,
	};
	const next = stagedProjectGlobs(
		saved,
		applyInstructionsAction(model.selection, action).edits,
	);
	if ((next ?? []).length > PROJECT_IGNORE_GLOB_LIMITS.maxGlobs) {
		return refuse({
			key: "tree.selection.full",
			values: { max: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs },
		});
	}
	return { ok: true, action };
}
