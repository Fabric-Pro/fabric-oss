/**
 * Living Memory's write folders (ADR-022) as the settings dialog uses them:
 * the shapes `projects.contexts.repositorySync.writeTargets.*` return, the
 * client-side checks that decide which folders the tree offers, and the
 * words for every refusal the server answers with. Pure — the dialog and its
 * tests share one answer.
 *
 * The checks only mirror the server's (`validateWriteTargetFolder`), which
 * stays authoritative: what the client cannot see (the coding-instructions
 * folders, the sync's default skips, a concurrent change) is refused there and
 * shown through `writeTargetErrorMessage`.
 */
import { contextSyncPathSpellingProblem } from "@repo/instructions/context-sync-rules";

export type WriteTargetMode = "PULL_REQUEST" | "DIRECT_PUSH";

export type WriteTargetView = {
	id: string;
	folder: string;
	mode: WriteTargetMode;
	version: number;
	directPushEnabledById: string | null;
	directPushEnabledAt: string | Date | null;
	updatedById: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
};

export type WriteTargetsList = {
	canConfigure: boolean;
	canEnableDirectPush: boolean;
	maxTargets: number;
	targets: WriteTargetView[];
};

/** The part of the sync's configuration a folder is judged against. */
export type WriteFolderSelection = {
	paths: readonly string[];
	excludedPaths: readonly string[];
};

/** Why a folder cannot be a write folder, as far as the client can tell. */
export type WriteFolderProblem =
	| "INVALID_PATH"
	| "TARGET_RESERVED"
	| "TARGET_OUTSIDE_SELECTION"
	| "TARGET_EXCLUDED"
	| "TARGET_OVERLAP";

/** `a` is `b` or an ancestor of it, by whole path segments. */
function isAtOrAbove(a: string, b: string): boolean {
	return a === "" || a === b || b.startsWith(`${a}/`);
}

/**
 * The first reason `folder` cannot be a write folder, in the server's order,
 * or `null`. `siblings` is every other write folder, so an edit does not
 * overlap the folder it replaces.
 */
export function writeFolderProblem(
	folder: string,
	selection: WriteFolderSelection,
	siblings: readonly string[],
): WriteFolderProblem | null {
	if (contextSyncPathSpellingProblem(folder) !== null) {
		return "INVALID_PATH";
	}
	if (folder === "" || folder.split("/").some((s) => s.startsWith("."))) {
		return "TARGET_RESERVED";
	}
	if (!selection.paths.some((path) => isAtOrAbove(path, folder))) {
		return "TARGET_OUTSIDE_SELECTION";
	}
	if (
		selection.excludedPaths.some(
			(left) => left !== "" && isAtOrAbove(left, folder),
		)
	) {
		return "TARGET_EXCLUDED";
	}
	if (
		siblings.some(
			(other) => isAtOrAbove(other, folder) || isAtOrAbove(folder, other),
		)
	) {
		return "TARGET_OVERLAP";
	}
	return null;
}

/** The codes the write-folder procedures refuse with that have their own copy. */
const WRITE_TARGET_ERROR_CODES = new Set([
	"INVALID_PATH",
	"TARGET_RESERVED",
	"TARGET_OUTSIDE_SELECTION",
	"TARGET_EXCLUDED",
	"TARGET_OVERLAP",
	"TARGET_OVERLAPS_INSTRUCTIONS",
	"TOO_MANY_TARGETS",
	"DIRECT_PUSH_REQUIRES_ADMIN",
	"NOT_CONFIGURED",
	"NOTHING_TO_UPDATE",
]);

function errorData(error: unknown): Record<string, unknown> | undefined {
	if (error && typeof error === "object" && "data" in error) {
		const data = (error as { data?: unknown }).data;
		return data && typeof data === "object"
			? (data as Record<string, unknown>)
			: undefined;
	}
	return undefined;
}

/**
 * The copy for a failed create, update or delete: the refusal's own sentence
 * where it has one (keyed under `errors.`), else a generic line. `values`
 * carries the folder and the other folder it clashed with, when the server
 * named them.
 */
export function writeTargetErrorMessage(
	error: unknown,
	limits: { maxTargets: number },
): { key: string; values: Record<string, string | number> } {
	const data = errorData(error);
	const code = typeof data?.code === "string" ? data.code : undefined;
	const values: Record<string, string | number> = {
		path: typeof data?.path === "string" ? data.path : "",
		withPath: typeof data?.withPath === "string" ? data.withPath : "",
		max: limits.maxTargets,
	};
	if (code && WRITE_TARGET_ERROR_CODES.has(code)) {
		return { key: `errors.${code}`, values };
	}
	return { key: "errors.generic", values };
}
