"use client";

import { useCallback, useEffect, useState } from "react";

export type MaturationViewMode = "v1" | "v2";

const DEFAULT_VIEW_MODE: MaturationViewMode = "v2";
const STORAGE_KEY = "fabric.maturation.viewMode";

function loadMode(): MaturationViewMode {
	if (typeof window === "undefined") {
		return DEFAULT_VIEW_MODE;
	}
	try {
		const stored = window.sessionStorage.getItem(STORAGE_KEY);
		return stored === "v1" ? "v1" : DEFAULT_VIEW_MODE;
	} catch {
		return DEFAULT_VIEW_MODE;
	}
}

function saveMode(mode: MaturationViewMode): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.sessionStorage.setItem(STORAGE_KEY, mode);
	} catch {
		// Storage unavailable (privacy mode / quota). The choice still works
		// in-memory for this render tree; it just won't survive a reload.
	}
}

/**
 * Session-scoped v1/v2 toggle for the Feature Maturation V2 editor (spec §9,
 * AC-6.3). Defaults to **v2** for a flagged org. Persisted in `sessionStorage`
 * (NOT the DB) — reverting to v1 for a demo never loses v2 content and the next
 * session defaults back to v2.
 *
 * SSR-safe in the `useDiffViewMode` style: server and first client render both
 * produce the default (no hydration mismatch), then the stored value is
 * reconciled in after mount. Fail-safe: any storage error falls back to v2.
 */
export function useMaturationViewMode(): {
	viewMode: MaturationViewMode;
	setViewMode: (mode: MaturationViewMode) => void;
} {
	const [viewMode, setViewModeState] =
		useState<MaturationViewMode>(DEFAULT_VIEW_MODE);

	useEffect(() => {
		const stored = loadMode();
		if (stored !== DEFAULT_VIEW_MODE) {
			setViewModeState(stored);
		}
	}, []);

	const setViewMode = useCallback((next: MaturationViewMode) => {
		setViewModeState(next);
		saveMode(next);
	}, []);

	return { viewMode, setViewMode };
}
