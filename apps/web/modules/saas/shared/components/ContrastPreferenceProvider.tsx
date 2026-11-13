"use client";

import type { ContrastPreference } from "@repo/utils/contrast-preference";
import { sessionQueryKey } from "@saas/auth/lib/api";
import {
	applyContrastPreference,
	clearUnsavedContrastPreference,
	readUnsavedContrastPreference,
	writeUnsavedContrastPreference,
} from "@saas/shared/lib/contrast-preference-dom";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

/**
 * Holds the person's high-contrast theme choice for the authenticated app
 * (Fizzy #1444) and keeps the `<html>` class in step with it.
 *
 * The order of events on a change is the point of this component:
 *
 *   1. the class changes synchronously, inside the click handler, so the whole
 *      app — portals included, since they hang off `<body>` — repaints in the
 *      next frame (AC-2/AC-3);
 *   2. the account is updated afterwards, and a failure does NOT undo step 1:
 *      the choice is kept for this tab and a toast says it was not saved
 *      (AC-7). Undoing it would punish the person for our outage with the very
 *      palette they just said they cannot read.
 *
 * Saves are serialised and the last choice wins, so flicking the toggle
 * quickly cannot leave the account holding an earlier value than the screen.
 */

type ContrastPreferenceContextValue = {
	preference: ContrastPreference;
	highContrast: boolean;
	setPreference: (next: ContrastPreference) => void;
	setHighContrast: (enabled: boolean) => void;
	isSaving: boolean;
};

const ContrastPreferenceContext =
	createContext<ContrastPreferenceContextValue | null>(null);

/**
 * `null` outside the authenticated app — public pages are out of scope for
 * high contrast (v1), and the shared navigation renders there too — so the
 * controls render nothing rather than a toggle that cannot save.
 */
export function useContrastPreference(): ContrastPreferenceContextValue | null {
	return useContext(ContrastPreferenceContext);
}

// `useLayoutEffect` warns during server rendering, where it never runs anyway.
const useClientLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

type SessionCache = {
	user?: Record<string, unknown> | null;
} | null;

export function ContrastPreferenceProvider({
	initialPreference,
	userId,
	children,
}: PropsWithChildren<{
	initialPreference: ContrastPreference;
	/** Whose choice an unsaved record is; another account's is ignored. */
	userId: string;
}>) {
	const t = useTranslations("settings.account.appearance.notifications");
	const queryClient = useQueryClient();
	// Starts from the server's value so hydration matches the HTML; a choice
	// this tab could not save is adopted in the first layout effect below,
	// still before anything paints.
	const [preference, setPreferenceState] =
		useState<ContrastPreference>(initialPreference);
	const preferenceRef = useRef(preference);
	preferenceRef.current = preference;

	const { mutateAsync, isPending } = useMutation(
		orpc.users.appearance.update.mutationOptions(),
	);

	// What the person last asked for, and what is on the wire right now.
	const wantedRef = useRef<ContrastPreference | null>(null);
	const inFlightRef = useRef<ContrastPreference | null>(null);

	const send = useCallback(
		(next: ContrastPreference, announce: boolean) => {
			inFlightRef.current = next;
			mutateAsync({ contrastPreference: next })
				.then(
					(result) => {
						if (wantedRef.current !== next) {
							return; // superseded by a later choice
						}
						if (result.persisted) {
							clearUnsavedContrastPreference();
							queryClient.setQueryData<SessionCache>(
								sessionQueryKey,
								(session) =>
									session?.user
										? {
												...session,
												user: {
													...session.user,
													contrastPreference: next,
												},
											}
										: session,
							);
							return;
						}
						// Impersonating: applied to this page, deliberately not to
						// the account (see users.appearance.update) — and not kept
						// for a reload either. A record would be retried, and once
						// the impersonation ended the retry would write the choice
						// to the admin's own account.
						clearUnsavedContrastPreference();
						if (announce) {
							toast.info(t("notSavedWhileImpersonating"));
						}
					},
					() => {
						if (wantedRef.current !== next) {
							return;
						}
						writeUnsavedContrastPreference(userId, next);
						if (announce) {
							toast.error(t("saveFailed"));
						}
					},
				)
				.finally(() => {
					inFlightRef.current = null;
					const wanted = wantedRef.current;
					if (wanted !== null && wanted !== next) {
						send(wanted, announce);
						return;
					}
					wantedRef.current = null;
				});
		},
		[mutateAsync, queryClient, t, userId],
	);

	const persist = useCallback(
		(next: ContrastPreference, announce: boolean) => {
			wantedRef.current = next;
			if (inFlightRef.current !== null) {
				return; // picked up when the current save settles
			}
			send(next, announce);
		},
		[send],
	);

	const setPreference = useCallback(
		(next: ContrastPreference) => {
			if (next === preferenceRef.current) {
				return;
			}
			applyContrastPreference(next);
			preferenceRef.current = next;
			setPreferenceState(next);
			persist(next, true);
		},
		[persist],
	);

	// A choice this tab made but could not save outranks the account's older
	// one (AC-7), as it already did in the inline script. Layout effect plus
	// state update: React re-renders synchronously, so the palette below is
	// settled before the first paint.
	useClientLayoutEffect(() => {
		const unsaved = readUnsavedContrastPreference(userId);
		if (unsaved !== null && unsaved !== preferenceRef.current) {
			preferenceRef.current = unsaved;
			setPreferenceState(unsaved);
		}
	}, []);

	// Paint the palette on mount (a client-side navigation into the app never
	// ran the server's inline script) and take it off on unmount, so leaving
	// for a public page — out of scope for v1 — leaves no trace on `<html>`.
	useClientLayoutEffect(() => {
		applyContrastPreference(preference);
		return () => applyContrastPreference("standard");
	}, [preference]);

	// A choice this tab could not save is retried once, quietly: the person was
	// already told, and it is still in force on their screen either way.
	// Once, on mount; later server values are handled by the effect below.
	useEffect(() => {
		const unsaved = readUnsavedContrastPreference(userId);
		if (unsaved === null) {
			return;
		}
		if (unsaved === initialPreference) {
			clearUnsavedContrastPreference();
			return;
		}
		persist(unsaved, false);
	}, []);

	// The server is the record. When the layout re-renders with a different
	// value (a router refresh after the account changed elsewhere) adopt it —
	// unless this tab is holding or sending a choice of its own, which is newer
	// by definition.
	useEffect(() => {
		if (
			inFlightRef.current !== null ||
			wantedRef.current !== null ||
			readUnsavedContrastPreference(userId) !== null
		) {
			return;
		}
		preferenceRef.current = initialPreference;
		setPreferenceState(initialPreference);
	}, [initialPreference]);

	const value = useMemo<ContrastPreferenceContextValue>(
		() => ({
			preference,
			highContrast: preference === "high",
			setPreference,
			setHighContrast: (enabled) =>
				setPreference(enabled ? "high" : "standard"),
			isSaving: isPending,
		}),
		[preference, setPreference, isPending],
	);

	return (
		<ContrastPreferenceContext.Provider value={value}>
			{children}
		</ContrastPreferenceContext.Provider>
	);
}
