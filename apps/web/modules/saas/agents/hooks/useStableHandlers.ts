"use client";

import { useLayoutEffect, useMemo, useRef } from "react";

type Handlers = Record<string, (...args: any[]) => unknown>;

/**
 * One object of handlers whose identities never change, each calling the
 * latest version of its function. Lets a memoized row keep its handlers across
 * skipped renders without calling a stale closure. The key set must not change
 * between renders. Call them from event handlers only, never during render:
 * the latest versions are swapped in after commit.
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
	const latest = useRef(handlers);
	useLayoutEffect(() => {
		latest.current = handlers;
	});
	// Built once: each wrapper reads `latest`.
	return useMemo(() => {
		const stable: Handlers = {};
		for (const key of Object.keys(handlers)) {
			stable[key] = (...args) => latest.current[key](...args);
		}
		return stable as T;
	}, []);
}
