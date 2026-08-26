"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	DEFAULT_DIFF_VIEW_MODE,
	DIFF_VIEW_MODE_STORAGE_KEY,
	type DerivedDiffViews,
	deriveDiffViews,
	type DiffViewMode,
	normalizeDiffViewMode,
} from "../lib/diff-view-modes";

function loadMode(): DiffViewMode {
	if (typeof window === "undefined") {
		return DEFAULT_DIFF_VIEW_MODE;
	}
	try {
		return normalizeDiffViewMode(
			window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY),
		);
	} catch {
		return DEFAULT_DIFF_VIEW_MODE;
	}
}

function saveMode(mode: DiffViewMode): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
	} catch {
		// Storage unavailable (privacy mode / quota). The choice simply won't
		// persist; the in-memory mode still works for this session.
	}
}

/**
 * Cross-session, per-browser persistence of the document diff review mode.
 *
 * One shared `localStorage` key, so the chosen mode is consistent across both
 * editors and every review flow. SSR-safe: the initial render uses the default
 * on both server and client (no hydration mismatch), then the stored value is
 * reconciled in after mount. Fail-safe: any storage error falls back to the
 * inline default and never throws.
 */
export function useDiffViewMode(): {
	mode: DiffViewMode;
	setMode: (mode: DiffViewMode) => void;
} {
	const [mode, setModeState] = useState<DiffViewMode>(DEFAULT_DIFF_VIEW_MODE);

	// Reconcile from storage after mount. Server render and first client render
	// both produce the default, so this avoids a hydration mismatch while still
	// honoring a previously-stored preference immediately afterward.
	useEffect(() => {
		const stored = loadMode();
		if (stored !== DEFAULT_DIFF_VIEW_MODE) {
			setModeState(stored);
		}
	}, []);

	// Persist only on explicit user changes (not via a value effect) so the
	// reconcile effect above can never be clobbered by a default write on mount.
	const setMode = useCallback((next: DiffViewMode) => {
		const normalized = normalizeDiffViewMode(next);
		setModeState(normalized);
		saveMode(normalized);
	}, []);

	return { mode, setMode };
}

/**
 * Compose the persisted mode with the live diff-marked editor HTML to produce
 * everything an editor surface needs to render the review-mode toggle and the
 * side-by-side / full-preview panes.
 *
 * Centralizing this keeps the Feature editor and the Document editor in
 * lock-step — same derivation, same fallback — instead of duplicating the logic
 * at each call site. Switching mode is a pure view change: it never mutates the
 * editor doc or the pending diff. On any derivation failure the effective mode
 * falls back to "inline" so the live editor renders rather than a blank pane.
 */
export function useDiffPreview(
	editor: Editor | null,
	isDiffReviewActive: boolean,
): {
	diffViewMode: DiffViewMode;
	setDiffViewMode: (mode: DiffViewMode) => void;
	diffViews: DerivedDiffViews | null;
	effectiveDiffViewMode: DiffViewMode;
	showDiffPreviewPanes: boolean;
} {
	const { mode, setMode } = useDiffViewMode();
	const diffViews = useMemo(() => {
		if (!editor || mode === "inline" || !isDiffReviewActive) {
			return null;
		}
		try {
			return deriveDiffViews(editor.getHTML());
		} catch {
			return null; // fall back to inline rendering on any failure
		}
		// `editor.state.doc` is a dependency so the panes re-derive if the
		// diffed document changes in place while a review stays active — mirrors
		// the DiffReviewBar `ranges` memo, which guards the same way.
	}, [editor, mode, isDiffReviewActive, editor?.state.doc]);
	return {
		diffViewMode: mode,
		setDiffViewMode: setMode,
		diffViews,
		effectiveDiffViewMode: diffViews ? mode : "inline",
		showDiffPreviewPanes: isDiffReviewActive && diffViews !== null,
	};
}
