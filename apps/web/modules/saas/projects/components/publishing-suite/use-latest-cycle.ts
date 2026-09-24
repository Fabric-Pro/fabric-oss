"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The Publishing list's view of its latest scan cycle (Fizzy #2646): the
 * query, when to re-read it, and when a run has FINISHED — the moment the
 * list's topics are worth re-reading.
 *
 * Extracted from the list so the follow-up after "Scan for topics" can be
 * tested against a real `QueryClient`: its correctness is a claim about
 * TanStack's cancellation and de-duplication, which a mocked `useQuery`
 * cannot make.
 */

/** How often a live run is re-read. */
export const CYCLE_POLL_INTERVAL_MS = 5000;

/**
 * How long a GENERATING cycle can be alive. Mirrors
 * `PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS` in the Temporal dispatcher,
 * which this app cannot import: a GENERATING row older than that is not
 * being worked on, and following it would never end.
 */
export const CYCLE_POLL_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * How long an accepted scan is followed whatever the cached status says.
 * Queries run with `retry: false`, so a single failed read after the scan
 * would otherwise leave nothing to ever look again.
 */
export const SCAN_WATCH_MS = 2 * 60 * 1000;

/**
 * A run the first answer after mount shows already finished counts as
 * finished on this page's watch if it completed within this long of now: it
 * may have finished after the topics were read, and a terminal cycle starts
 * no polling that would ever notice.
 */
export const RECENT_FINISH_MS = 2 * 60 * 1000;

function finishedRecently(
	completedAt: Date | string | null | undefined,
	now: number,
): boolean {
	if (completedAt === null || completedAt === undefined) {
		return false;
	}
	const completed =
		completedAt instanceof Date
			? completedAt.getTime()
			: new Date(completedAt).getTime();
	if (Number.isNaN(completed)) {
		return false;
	}
	// Either side of now: the server's clock and this browser's can disagree
	// in both directions.
	return Math.abs(now - completed) < RECENT_FINISH_MS;
}

export function isLiveGenerating(
	cycle: { status: string; startedAt: Date | string } | null | undefined,
	now: number,
): boolean {
	if (!cycle || cycle.status !== "GENERATING") {
		return false;
	}
	const started =
		cycle.startedAt instanceof Date
			? cycle.startedAt.getTime()
			: new Date(cycle.startedAt).getTime();
	if (Number.isNaN(started)) {
		return false;
	}
	return now - started < CYCLE_POLL_WINDOW_MS;
}

export function useLatestCycle({
	projectId,
	organizationId,
	onFinished,
}: {
	projectId: string;
	organizationId: string | null;
	/** A run was seen to finish: re-read what it produced. */
	onFinished: () => void;
}) {
	const queryClient = useQueryClient();

	// When a scan accepted from this page is still waiting for an answer
	// fetched after it. STATE, because it is an input to `refetchInterval`
	// and TanStack re-reads the interval when the options change; the ref is
	// the same value for the effect below, which must not wait a render.
	const [scanRequestedAt, setScanRequestedAt] = useState<number | null>(null);
	const pendingScanRef = useRef<number | null>(null);

	const onFinishedRef = useRef(onFinished);
	useEffect(() => {
		onFinishedRef.current = onFinished;
	});

	const cycleQuery = useQuery({
		...orpc.projects.publishingSuite.latestCycle.queryOptions({
			input: { projectId, organizationId },
		}),
		// Re-read on EVERY mount, even inside the app's 60 s staleTime: a
		// remount would otherwise show the cached cycle without asking, and a
		// run that finished while the list was away would never be observed.
		// A one-row read. The (id, status) dedupe below fires when the fresh
		// answer differs from the cached one; the cached first observation
		// fires only under the recent-finish rule.
		refetchOnMount: "always",
		// Re-read while a run is live, or while a scan from this page is
		// unanswered. A run that starts while the list is idle is not
		// discovered here (next focus refetch or load, as before).
		refetchInterval: (query) => {
			const now = Date.now();
			if (
				scanRequestedAt !== null &&
				now - scanRequestedAt < SCAN_WATCH_MS
			) {
				return CYCLE_POLL_INTERVAL_MS;
			}
			return isLiveGenerating(query.state.data?.cycle, now)
				? CYCLE_POLL_INTERVAL_MS
				: false;
		},
	});

	/**
	 * The scan was accepted. `started` is only answered once the run's
	 * GENERATING row exists (or the dispatch declined to create one), so the
	 * first answer FETCHED AFTER THIS shows the run — or that there is none.
	 */
	const scanAccepted = useCallback(() => {
		const at = Date.now();
		pendingScanRef.current = at;
		setScanRequestedAt(at);
		const queryKey = orpc.projects.publishingSuite.latestCycle.queryKey({
			input: { projectId, organizationId },
		});
		// Cancel FIRST. A refetch would join a first read still in flight
		// (TanStack only cancels one when the query already has data), and
		// that read's answer predates the scan. Cancelling AFTER the
		// invalidation would kill the post-scan read itself.
		void queryClient
			.cancelQueries({ queryKey })
			.then(() => queryClient.invalidateQueries({ queryKey }));
	}, [queryClient, projectId, organizationId]);

	// The last (id, status) seen; `undefined` = nothing seen yet, `null` =
	// seen "no cycle".
	const lastObservedRef = useRef<string | null | undefined>(undefined);
	const { data, dataUpdatedAt } = cycleQuery;
	useEffect(() => {
		// Only successful answers are observations; an error keeps any
		// pending scan (and its polling) alive.
		if (data === undefined) {
			return;
		}
		const cycle = data.cycle ?? null;
		const observed = cycle ? `${cycle.id}:${cycle.status}` : null;
		const previous = lastObservedRef.current;
		lastObservedRef.current = observed;

		// Post-scan iff FETCHED after the scan was accepted (this browser's
		// clock on both sides), whatever it shows.
		const scanAt = pendingScanRef.current;
		const answersScan = scanAt !== null && dataUpdatedAt > scanAt;
		if (answersScan) {
			pendingScanRef.current = null;
			setScanRequestedAt(null);
		}

		if (cycle === null || cycle.status === "GENERATING") {
			return;
		}
		// Terminal. It finished on this page's watch if the (id, status)
		// changed since the last answer — which also covers a NEW cycle first
		// seen already finished — or if it is the scan's own answer. The
		// first answer after mount with no scan never counts unless that run
		// finished within RECENT_FINISH_MS — it may have finished after the
		// topics were read.
		const changed = previous !== undefined && previous !== observed;
		const firstSeenJustFinished =
			previous === undefined &&
			finishedRecently(cycle.completedAt, Date.now());
		if (changed || answersScan || firstSeenJustFinished) {
			onFinishedRef.current();
		}
	}, [data, dataUpdatedAt]);

	return { cycleQuery, scanAccepted };
}
