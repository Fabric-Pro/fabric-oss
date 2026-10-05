"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A value that is set on request and clears by itself, for the moment a copy
 * control reads "Copied". Setting it again restarts the clock, so a second copy
 * is never cut short by the first one's timer.
 */
export function useTransientValue<T>(durationMs: number) {
	const [value, setValue] = useState<T | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const raise = useCallback(
		(next: T) => {
			clearTimeout(timer.current);
			setValue(next);
			timer.current = setTimeout(() => setValue(null), durationMs);
		},
		[durationMs],
	);

	const lower = useCallback(() => {
		clearTimeout(timer.current);
		setValue(null);
	}, []);

	return [value, raise, lower] as const;
}
