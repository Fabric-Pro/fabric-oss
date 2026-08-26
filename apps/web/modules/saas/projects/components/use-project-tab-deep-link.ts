"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Consume a `?tab=<id>` deep link on the project page: report it once, then
 * strip it from the URL.
 *
 * The project tabs are client state (plus sessionStorage) with no route of
 * their own; `?tab=` is how a cross-page CTA addresses one. A manual tab
 * switch never rewrites the URL, so a param left in place goes stale the
 * moment the user switches away — and it then reasserts itself through any
 * unrelated query write, because in-page writers (the roadmap search box via
 * nuqs, the Testing view's filter commit) correctly preserve params they do
 * not own. One keystroke in the Roadmap search used to re-apply a stale
 * `tab=documents` and unmount the roadmap mid-search. Consuming and
 * stripping makes the link a one-time instruction rather than a standing one
 * — the same doctrine as `stories/use-consume-search-param.ts` and
 * `stories/sync-log-deep-link.ts`.
 *
 * Only values accepted by `isValidTab` are consumed. An unrecognized value is
 * left in the URL untouched — not because a known consumer wants it (there is
 * none on this route today; every other `?tab=` reader lives under /agents,
 * /agent-templates or /report-templates), but because deleting a value this
 * hook does not understand is not its call to make. That conservative default
 * is the reason `useConsumeSearchParam`, which strips unconditionally, is not
 * reused here.
 *
 * `isValidTab` is an effect dependency, so it MUST be a module-level function.
 * An inline closure is a new identity every render, and since the effect sets
 * state while the param is still in the URL, that is a render → effect →
 * setState loop that React aborts with "Maximum update depth exceeded" — not
 * merely a wasted render. Biome cannot catch it: an inline closure listed in
 * the deps array is still exhaustive.
 *
 * The effect keys on the SERIALIZED query, not the `useSearchParams()`
 * object (a fresh instance per render → infinite setState loop), and returns
 * a `{ tab, seq }` object rebuilt on every consumption so a repeat of the
 * SAME link within one mount still reaches the consumer's effect. Keep this
 * contract aligned with `ConsumedSearchParam` in use-consume-search-param.ts.
 */
export interface ConsumedTabParam<T extends string> {
	tab: T;
	/** Increments once per link followed — never resets. */
	seq: number;
}

const TAB_PARAM = "tab";

export function useProjectTabDeepLink<T extends string>(
	isValidTab: (value: string) => value is T,
): ConsumedTabParam<T> | null {
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams().toString();
	const [consumed, setConsumed] = useState<ConsumedTabParam<T> | null>(null);

	useEffect(() => {
		const next = new URLSearchParams(search);
		const value = next.get(TAB_PARAM);
		if (!value || !isValidTab(value)) {
			return;
		}
		// New object every time, so the consumer's effect re-fires even when
		// the same tab is requested twice.
		setConsumed((prev) => ({ tab: value, seq: (prev?.seq ?? 0) + 1 }));

		next.delete(TAB_PARAM);
		const query = next.toString();
		router.replace(query ? `${pathname}?${query}` : pathname, {
			scroll: false,
		});
	}, [search, pathname, router, isValidTab]);

	return consumed;
}
