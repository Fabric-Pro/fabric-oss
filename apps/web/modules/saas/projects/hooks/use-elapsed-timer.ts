"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tick an elapsed-seconds counter while `isActive` is true. Resets to 0 on
 * every transition from inactive → active, and stops the interval on
 * active → inactive (and on unmount).
 *
 * Used by long-running AI flows (Update-using-context) to drive a "this has
 * been running X seconds" indicator without each caller re-implementing the
 * setInterval + ref bookkeeping.
 */
export function useElapsedTimer(isActive: boolean): number {
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const startRef = useRef<number | null>(null);

	useEffect(() => {
		if (!isActive) {
			startRef.current = null;
			setElapsedSeconds(0);
			return;
		}
		startRef.current = Date.now();
		setElapsedSeconds(0);
		const id = setInterval(() => {
			if (startRef.current != null) {
				setElapsedSeconds(
					Math.floor((Date.now() - startRef.current) / 1000),
				);
			}
		}, 1000);
		return () => clearInterval(id);
	}, [isActive]);

	return elapsedSeconds;
}
