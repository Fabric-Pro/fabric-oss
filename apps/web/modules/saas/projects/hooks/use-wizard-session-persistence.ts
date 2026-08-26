"use client";

import { useCallback, useEffect, useRef } from "react";

const STORAGE_KEY = "fabric:wizard-form-state";
/** Bump this when the WizardSnapshot schema changes. */
const SNAPSHOT_VERSION = 1;
/** Max age before a snapshot is considered stale and discarded. */
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Persists project-creation wizard state to `sessionStorage` so the user
 * can navigate away (e.g. to Settings to configure an integration) and
 * return without losing progress.
 *
 * **How it works:**
 * - On every form change the wizard calls `save(snapshot)` which writes
 *   the current form state to `sessionStorage`.
 * - When the wizard mounts, it checks for a stored snapshot. If one
 *   exists (and is ≤30 min old, same version, same pathname), it calls
 *   `onRestore(snapshot)` once, then clears the storage.
 * - When the wizard completes (project created), call `clear()` to
 *   remove any leftover state.
 *
 * The snapshot includes a `pathname` field so it's only restored when
 * the user returns to the **same** wizard URL (prevents restoring data
 * from a personal wizard into an org wizard, etc.).
 */

export interface WizardSnapshot {
	version: number;
	formData: Record<string, unknown>;
	currentStep: number;
	createdProjectId: string | null;
	wizardSessionId: string;
	draftKey: string;
	savedAt: number;
	/** URL pathname where the snapshot was created (for matching). */
	pathname?: string;
}

interface UseWizardSessionPersistenceOptions {
	/** Current pathname — used to scope snapshots to the right wizard. */
	pathname: string;
	/** Called once on mount if a saved snapshot exists. */
	onRestore: (snapshot: WizardSnapshot) => void;
	/** Whether the wizard is in edit mode (editing an existing project). */
	isEditMode?: boolean;
	/**
	 * Explicit "start fresh" entry — a direct, non-resume navigation to
	 * `projects/new` (no `?step` / valid `?projectId`). When true, any stale
	 * snapshot is dropped on mount and `onRestore` is NOT called, so a leftover
	 * blob can never race `draftKey` creation into a duplicate DRAFT
	 * (unified-project-setup spec §4.1, §11). This replaces the choice
	 * screen's explicit `sessionStorage.removeItem("fabric:wizard-form-state")`.
	 */
	freshStart?: boolean;
}

export function useWizardSessionPersistence({
	pathname,
	onRestore,
	isEditMode = false,
	freshStart = false,
}: UseWizardSessionPersistenceOptions) {
	const restoredRef = useRef(false);
	// Keep latest onRestore in a ref to avoid stale closure issues
	const onRestoreRef = useRef(onRestore);
	onRestoreRef.current = onRestore;

	// Restore on mount (once) — only for new project creation, not edit mode.
	// On an explicit fresh start, drop any stale snapshot and skip restore so a
	// leftover blob can't pre-populate fields or race draftKey into a duplicate
	// DRAFT.
	useEffect(() => {
		if (restoredRef.current || isEditMode) {
			return;
		}
		restoredRef.current = true;

		if (freshStart) {
			try {
				sessionStorage.removeItem(STORAGE_KEY);
			} catch {
				// sessionStorage unavailable — best-effort
			}
			return;
		}

		try {
			const raw = sessionStorage.getItem(STORAGE_KEY);
			if (!raw) {
				return;
			}

			const snapshot: WizardSnapshot = JSON.parse(raw);

			// Reject snapshots from a different schema version
			if (snapshot.version !== SNAPSHOT_VERSION) {
				sessionStorage.removeItem(STORAGE_KEY);
				return;
			}

			// Reject stale snapshots (>30 min old)
			const age = Date.now() - (snapshot.savedAt ?? 0);
			if (age > MAX_AGE_MS) {
				sessionStorage.removeItem(STORAGE_KEY);
				return;
			}

			// Only restore if the pathname matches (same wizard context).
			// Strip query params for comparison so returning to ?step=1
			// still matches a snapshot saved at ?step=3.
			const savedBase = (snapshot.pathname ?? "").replace(/\?.*$/, "");
			const currentBase = pathname.replace(/\?.*$/, "");
			if (savedBase && savedBase !== currentBase) {
				sessionStorage.removeItem(STORAGE_KEY);
				return;
			}

			// Validate basic shape — formData must be an object, step a number
			if (
				!snapshot.formData ||
				typeof snapshot.formData !== "object" ||
				typeof snapshot.currentStep !== "number"
			) {
				sessionStorage.removeItem(STORAGE_KEY);
				return;
			}

			// Clear immediately so it's only restored once
			sessionStorage.removeItem(STORAGE_KEY);
			onRestoreRef.current(snapshot);
		} catch {
			sessionStorage.removeItem(STORAGE_KEY);
		}
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	/** Persist current wizard state. Call on every meaningful form change. */
	const save = useCallback(
		(
			snapshot: Omit<WizardSnapshot, "savedAt" | "pathname" | "version">,
		) => {
			try {
				const data: WizardSnapshot = {
					...snapshot,
					version: SNAPSHOT_VERSION,
					pathname,
					savedAt: Date.now(),
				};
				sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
			} catch {
				// sessionStorage full or unavailable — silently ignore
			}
		},
		[pathname],
	);

	/** Clear saved state (call when wizard completes successfully). */
	const clear = useCallback(() => {
		try {
			sessionStorage.removeItem(STORAGE_KEY);
		} catch {
			// ignore
		}
	}, []);

	return { save, clear };
}
