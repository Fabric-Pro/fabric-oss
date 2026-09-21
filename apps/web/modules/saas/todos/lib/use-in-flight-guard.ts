"use client";

import { useCallback, useRef, useState } from "react";

/**
 * One write at a time per id, guarded synchronously (Fizzy #2340).
 *
 * `disabled` derived from state is not enough on its own: two clicks inside one
 * React batch both read the pre-render value and both fire. The ref is the
 * synchronous half — it is updated before the handler returns, so the second
 * click sees the claim the first one made. The state half exists only so the
 * row can render as busy.
 *
 * Extracted because it was written twice, identically, for two different id
 * kinds. A race guard is exactly the code that must not be maintained in two
 * places: a later fix to the ref/state interaction would otherwise land in one
 * and not the other, and the surviving copy would look fine.
 */
export function useInFlightGuard(): {
	busyIds: readonly string[];
	isBusy: (id: string) => boolean;
	claim: (id: string) => boolean;
	release: (id: string) => void;
} {
	const [busyIds, setBusyIds] = useState<readonly string[]>([]);
	const inFlight = useRef<Set<string>>(new Set());

	const claim = useCallback((id: string): boolean => {
		if (inFlight.current.has(id)) {
			return false;
		}
		inFlight.current.add(id);
		setBusyIds((current) => [...current, id]);
		return true;
	}, []);

	const release = useCallback((id: string) => {
		inFlight.current.delete(id);
		setBusyIds((current) => current.filter((busy) => busy !== id));
	}, []);

	const isBusy = useCallback((id: string) => busyIds.includes(id), [busyIds]);

	return { busyIds, isBusy, claim, release };
}
