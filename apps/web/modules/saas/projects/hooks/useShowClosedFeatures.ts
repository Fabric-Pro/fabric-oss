"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY_PREFIX = "fabric:show-closed-features:";

/**
 * Project-level "Show closed features" toggle for the Roadmap.
 *
 * - Persists to localStorage per project. Structure supports future backend migration.
 * - Default `false`: closed features are hidden from the Roadmap until the user opts in.
 * - Key: projectId.
 */
function getStorageKey(projectId: string): string {
	return `${STORAGE_KEY_PREFIX}${projectId}`;
}

function loadShowClosed(projectId: string): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	try {
		const raw = window.localStorage.getItem(getStorageKey(projectId));
		if (raw === null) {
			return false;
		}
		return raw === "true";
	} catch {
		return false;
	}
}

function saveShowClosed(projectId: string, value: boolean): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(getStorageKey(projectId), String(value));
	} catch {
		// ignore
	}
}

export function useShowClosedFeatures(projectId: string) {
	const [showClosed, setShowClosedState] = useState<boolean>(() =>
		loadShowClosed(projectId),
	);

	useEffect(() => {
		setShowClosedState(loadShowClosed(projectId));
	}, [projectId]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		saveShowClosed(projectId, showClosed);
	}, [projectId, showClosed]);

	const setShowClosed = useCallback((value: boolean) => {
		setShowClosedState(value);
	}, []);

	const toggleShowClosed = useCallback(() => {
		setShowClosedState((prev) => !prev);
	}, []);

	return {
		showClosed,
		setShowClosed,
		toggleShowClosed,
	};
}
