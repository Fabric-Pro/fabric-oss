/**
 * Living Memory's typed "leave out" paths: client-side validation mirroring
 * `canonicalizeContextSyncExcludedPaths` in
 * `packages/api/modules/projects/procedures/contexts/repository-sync/paths.ts`,
 * offered where the tree cannot reach every path. The per-path rule (the
 * spelling and length rule, `.fabric`, a `.contextignore`) is the canonical
 * module's `contextSyncExclusionProblem`, which the server applies too, so
 * the dialog refuses exactly what `configure` would; the server stays
 * authoritative either way. What the path covers, and the 200-path cap, are
 * the selection reducer's (`applyContextAction`'s `exclude`), as for a tick.
 */
import {
	contextSyncExclusionProblem,
	MAX_CONTEXT_SYNC_PATH_LENGTH,
} from "@repo/instructions/context-sync-rules";
import { isStrictlyInside } from "../components/repository-sync/lib/repository-tree";
import type { ContextSyncMessage } from "./context-repository-sync";

export type ContextSyncExclusionError =
	| { code: "WHOLE_REPOSITORY" }
	| { code: "PATH_TOO_LONG" }
	| { code: "INVALID_PATH"; path: string }
	| { code: "EXCLUDED_FABRIC_PATH"; path: string }
	| { code: "EXCLUDED_PATH_POLICY_FILE"; path: string }
	| { code: "NOTHING_SELECTED" }
	| { code: "SELECTED"; path: string }
	| { code: "OUTSIDE_SELECTION"; path: string }
	| { code: "DUPLICATE"; path: string }
	| { code: "OVERLAP"; path: string; withPath: string };

/**
 * Validate one typed path against the selection before the reducer leaves
 * it out: a path `configure` accepts as left out, strictly inside a selected
 * path (never one itself), not already left out, and not inside a path that
 * is. A path that HOLDS left-out paths is not an error: leaving it out
 * absorbs them, as unticking a partial folder does.
 */
export function validateContextSyncExclusionAddition(
	raw: string,
	selection: {
		paths: readonly string[];
		excludedPaths: readonly string[];
	},
):
	| { ok: true; path: string }
	| { ok: false; error: ContextSyncExclusionError } {
	const path = raw;
	const problem = contextSyncExclusionProblem(path);
	switch (problem) {
		case null:
			break;
		case "whole-repository":
			return { ok: false, error: { code: "WHOLE_REPOSITORY" } };
		case "too-long":
			return { ok: false, error: { code: "PATH_TOO_LONG" } };
		case "not-canonical":
			return { ok: false, error: { code: "INVALID_PATH", path } };
		case "fabric":
			return { ok: false, error: { code: "EXCLUDED_FABRIC_PATH", path } };
		case "policy-file":
			return {
				ok: false,
				error: { code: "EXCLUDED_PATH_POLICY_FILE", path },
			};
		default: {
			const unreachable: never = problem;
			return unreachable;
		}
	}
	if (selection.paths.length === 0) {
		return { ok: false, error: { code: "NOTHING_SELECTED" } };
	}
	if (selection.paths.includes(path)) {
		return { ok: false, error: { code: "SELECTED", path } };
	}
	if (!selection.paths.some((selected) => isStrictlyInside(selected, path))) {
		return { ok: false, error: { code: "OUTSIDE_SELECTION", path } };
	}
	if (selection.excludedPaths.includes(path)) {
		return { ok: false, error: { code: "DUPLICATE", path } };
	}
	const covering = selection.excludedPaths.find((excluded) =>
		isStrictlyInside(excluded, path),
	);
	return covering === undefined
		? { ok: true, path }
		: {
				ok: false,
				error: { code: "OVERLAP", path, withPath: covering },
			};
}

/** A typed left-out path's inline error, by translation key. */
export function contextSyncExclusionMessage(
	error: ContextSyncExclusionError,
): ContextSyncMessage {
	const key = `excludeErrors.${error.code}`;
	switch (error.code) {
		case "WHOLE_REPOSITORY":
		case "NOTHING_SELECTED":
			return { key };
		case "PATH_TOO_LONG":
			return { key, values: { max: MAX_CONTEXT_SYNC_PATH_LENGTH } };
		case "INVALID_PATH":
		case "EXCLUDED_FABRIC_PATH":
		case "EXCLUDED_PATH_POLICY_FILE":
		case "SELECTED":
		case "OUTSIDE_SELECTION":
		case "DUPLICATE":
			return { key, values: { path: error.path } };
		case "OVERLAP":
			return {
				key,
				values: { path: error.path, withPath: error.withPath },
			};
		default: {
			const unreachable: never = error;
			return unreachable;
		}
	}
}
