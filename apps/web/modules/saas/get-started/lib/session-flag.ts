/**
 * Per-user, per-tab-session "already shown" flags for one-shot onboarding
 * surfaces.
 *
 * Keyed by user id so a shared browser doesn't leak one user's state to the
 * next. Degrades to once-per-page-load when sessionStorage is unavailable
 * (SSR / privacy mode / blocked storage) — reads and writes never throw.
 */
import { useCallback, useEffect, useState } from "react";

export type SessionFlag = {
	read: (userId: string) => boolean;
	write: (userId: string) => void;
};

export function createSessionFlag(prefix: string): SessionFlag {
	const keyFor = (userId: string) => `${prefix}:${userId}`;
	return {
		read: (userId) => {
			try {
				return sessionStorage.getItem(keyFor(userId)) === "1";
			} catch {
				return false;
			}
		},
		write: (userId) => {
			try {
				sessionStorage.setItem(keyFor(userId), "1");
			} catch {
				// Storage unavailable — degrade to once-per-page-load.
			}
		},
	};
}

/**
 * Reactive view of a session flag for one user: whether the surface has been
 * shown this tab session, plus a marker that records it.
 *
 * Re-seeds when `userId` settles — the session hook returns no user on the
 * first render, so the initial read runs against an empty key. Callers mark
 * AT open rather than at close, so an incidental dismissal can't reopen the
 * surface later in the same session.
 */
export function useSessionFlag(
	flag: SessionFlag,
	userId: string,
): [shown: boolean, markShown: () => void] {
	const [shown, setShown] = useState(() => flag.read(userId));

	useEffect(() => {
		setShown(flag.read(userId));
	}, [flag, userId]);

	const markShown = useCallback(() => {
		flag.write(userId);
		setShown(true);
	}, [flag, userId]);

	return [shown, markShown];
}
