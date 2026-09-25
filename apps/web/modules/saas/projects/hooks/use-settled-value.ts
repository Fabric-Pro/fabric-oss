"use client";

import { useEffect, useState } from "react";

/**
 * `value` once it has stopped changing for `delayMs`; the first value is
 * settled at once. Not `usehooks-ts`'s `useDebounceValue`: that one leaves
 * its timer running after unmount, and the test setup replaces it with a
 * synchronous stub, so the debounce a caller depends on would go
 * unverified. This timer is cleared on every change and on unmount.
 *
 * Shared by the repository-sync tree browsers of Living Memory (Fizzy #2674)
 * and Coding Instructions (Fizzy #2725), which list a branch only once its
 * name has settled.
 */
export function useSettledValue<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		if (Object.is(value, settled)) {
			return;
		}
		const timer = setTimeout(() => setSettled(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, settled, delayMs]);
	return settled;
}
