"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Read a one-shot query param, report it once, and strip it from the URL.
 *
 * Several things in the roadmap live inside drawers, modals and client-state
 * tabs that have no route of their own — a backlog proposal, a feature's
 * Decision Log tab. A query param is how a link elsewhere in the app addresses
 * one, which keeps the destination shareable in a way an event bridge would not.
 *
 * It is NOT back-button-safe when the link targets the page you are already on:
 * the click pushes a history entry and the strip immediately `replace`s it away,
 * so Back is a visible no-op rather than a way to dismiss what opened. Driving
 * the target from the param instead of consuming it would fix that, at the cost
 * of the reassertion problem described above.
 *
 * Stripping is the part that is easy to get wrong. Left in place, the param is
 * re-read on every render and the target keeps reasserting itself: the user
 * closes the drawer and it reopens, switches tab and is yanked back. Reporting
 * once and removing it makes the link a one-time instruction rather than a
 * standing one.
 *
 * The effect keys on the SERIALIZED query rather than the `useSearchParams()`
 * object. That object is a fresh instance on every render, so an object
 * dependency re-runs the effect every render — and because the effect sets
 * state, that is an infinite render loop.
 *
 * Returns `null` until a value arrives. Callers validate the value (an unknown
 * tab name, a proposal that no longer exists) so this stays ignorant of what any
 * particular param means.
 *
 * `seq` is what makes a REPEAT of the same link work. Consumers key their
 * effects on what this returns, and returning a bare string would let React's
 * `Object.is` bail out when the same value arrives twice in one mount — the
 * param would be stripped and nothing would happen. That is reachable: one
 * proposal can produce several work items, so several roadmap rows link to the
 * identical `?proposal=<id>`. `useSyncLogDeepLink` in this directory returns an
 * incrementing counter for exactly this reason; keep the two contracts aligned.
 */
export interface ConsumedSearchParam {
	value: string;
	/** Increments once per link followed — never resets. */
	seq: number;
}

export function useConsumeSearchParam(
	paramName: string,
): ConsumedSearchParam | null {
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams().toString();
	const [consumed, setConsumed] = useState<ConsumedSearchParam | null>(null);

	useEffect(() => {
		const next = new URLSearchParams(search);
		const value = next.get(paramName);
		if (!value) {
			return;
		}
		// New object every time, so a consumer's effect re-fires even when the
		// value is unchanged.
		setConsumed((prev) => ({ value, seq: (prev?.seq ?? 0) + 1 }));

		next.delete(paramName);
		const query = next.toString();
		router.replace(query ? `${pathname}?${query}` : pathname, {
			scroll: false,
		});
	}, [search, pathname, paramName, router]);

	return consumed;
}
