"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * "Sync now" only STARTS a workflow. Everything the Testing views show from
 * that sync — findings, each case's result, feature and plan pass rates — is
 * written later, by the ingest the workflow runs, so nothing refreshed at the
 * moment of the click can show it (Fizzy #2226).
 *
 * The watch lives here rather than in the Runs panel because the panel is one
 * sub-tab: switching to Cases unmounted it, and with it the only poll that
 * could see the ingest land. A module-level watch survives that, and a
 * navigation away and back, the same way `useStoryKindRegeneration` does.
 */

/** The sync activity's own bound: three attempts of at most three minutes. */
const SYNC_WATCH_LIMIT_MS = 10 * 60_000;
const FAST_POLL_WINDOW_MS = 60_000;

interface SyncStateRow {
	id: string;
	updatedAt: Date | string;
}

interface PipelineSyncWatch {
	startedAt: number;
	/** Each source row's `updatedAt` as it stood when the sync was requested. */
	baseline: ReadonlyMap<string, number>;
}

let watches = new Map<string, PipelineSyncWatch>();
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
	for (const subscriber of subscribers) {
		subscriber();
	}
}

const toMs = (value: Date | string) => new Date(value).getTime();

/**
 * Record that a sync was just requested. `rows` is the sync state the user
 * was looking at: server timestamps, so completion is judged against the
 * server's clock and never the browser's.
 */
export function watchPipelineSync(
	projectId: string,
	rows: readonly SyncStateRow[],
): void {
	watches = new Map(watches).set(projectId, {
		startedAt: Date.now(),
		baseline: new Map(rows.map((row) => [row.id, toMs(row.updatedAt)])),
	});
	notifySubscribers();
}

function unwatchPipelineSync(projectId: string): void {
	if (!watches.has(projectId)) {
		return;
	}
	watches = new Map(watches);
	watches.delete(projectId);
	notifySubscribers();
}

/** Test seam — the watches are module state shared by every surface. */
export function resetPipelineSyncWatches(): void {
	watches = new Map();
	notifySubscribers();
}

function subscribe(onStoreChange: () => void): () => void {
	subscribers.add(onStoreChange);
	return () => {
		subscribers.delete(onStoreChange);
	};
}

export function usePipelineSyncWatch(
	projectId: string,
): PipelineSyncWatch | null {
	return useSyncExternalStore(
		subscribe,
		() => watches.get(projectId) ?? null,
		() => null,
	);
}

/**
 * A sync is over once every source row the previous sync wrote has been
 * written again. Both terminal writers — `advancePipelineSyncState` and
 * `recordPipelineSyncFailure` — touch the row, so a failing source counts as
 * finished rather than holding the poll open.
 *
 * A row the previous sync did not write (a repository disconnected since, a
 * key the plan no longer derives) will not be written by this one either.
 * Rows one sync writes land within its own time bound of each other, so a row
 * older than that relative to the newest is not waited for: on staging one
 * such row, ten hours stale, held every poll open to the ten-minute cap.
 */
function isPipelineSyncSettled(
	watch: PipelineSyncWatch,
	rows: readonly SyncStateRow[] | undefined,
): boolean {
	if (!rows || rows.length === 0) {
		return false;
	}
	const newestBefore = Math.max(0, ...watch.baseline.values());
	return rows.every((row) => {
		const before = watch.baseline.get(row.id);
		return (
			before === undefined ||
			newestBefore - before > SYNC_WATCH_LIMIT_MS ||
			toMs(row.updatedAt) > before
		);
	});
}

export function pipelineSyncPollInterval(
	watch: PipelineSyncWatch | null,
): number | false {
	if (!watch) {
		return false;
	}
	return Date.now() - watch.startedAt < FAST_POLL_WINDOW_MS ? 3000 : 10_000;
}

/** Everything on the Testing tab that is a product of pipeline ingestion. */
function ingestionProductKeys() {
	return [
		orpc.projects.pipelineResults.listRuns.key(),
		orpc.projects.pipelineResults.listRunsPage.key(),
		orpc.projects.pipelineResults.findings.key(),
		orpc.projects.pipelineResults.unmatchedTests.key(),
		orpc.projects.testCases.list.key(),
		orpc.projects.testCases.get.key(),
		orpc.projects.testCases.resultHistory.key(),
		orpc.projects.testCases.featureCoverage.key(),
		orpc.projects.testCases.plans.list.key(),
		orpc.projects.testCases.plans.get.key(),
	];
}

/**
 * Mount once per surface that shows ingestion products, ABOVE its sub-tabs.
 * Polls the sync state while a requested sync is in flight, and re-reads every
 * ingestion product each time a source finishes an attempt — including one
 * that wrote results and then failed, which never advances `lastFetchedAt`.
 */
export function usePipelineIngestionRefresh(projectId: string): void {
	const queryClient = useQueryClient();
	const watch = usePipelineSyncWatch(projectId);
	const syncStatesQuery = useQuery(
		orpc.projects.pipelineResults.syncStates.queryOptions({
			input: { projectId },
			refetchInterval: () => pipelineSyncPollInterval(watch),
		}),
	);
	const rows = syncStatesQuery.data;

	const settled = watch !== null && isPipelineSyncSettled(watch, rows);
	useEffect(() => {
		if (settled) {
			unwatchPipelineSync(projectId);
		}
	}, [settled, projectId]);

	// A source that never writes its row again (a repository disconnected
	// since its last sync) must not hold the poll open forever.
	useEffect(() => {
		if (!watch) {
			return;
		}
		const timer = setTimeout(
			() => unwatchPipelineSync(projectId),
			watch.startedAt + SYNC_WATCH_LIMIT_MS - Date.now(),
		);
		return () => clearTimeout(timer);
	}, [watch, projectId]);

	const latestAttemptMs = rows?.reduce(
		(max, row) => Math.max(max, toMs(row.updatedAt)),
		0,
	);
	const seenAttemptMsRef = useRef<number | null>(null);
	useEffect(() => {
		if (latestAttemptMs === undefined) {
			return;
		}
		const previous = seenAttemptMsRef.current;
		seenAttemptMsRef.current = latestAttemptMs;
		if (previous === null || latestAttemptMs <= previous) {
			return;
		}
		for (const key of ingestionProductKeys()) {
			queryClient.invalidateQueries({ queryKey: key });
		}
	}, [latestAttemptMs, queryClient]);
}
