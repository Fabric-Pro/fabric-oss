"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * "Sync now" only STARTS a workflow. Everything the Testing views show from
 * that sync — findings, each case's result, feature and plan pass rates, the
 * Runs badge, the QA traceability matrix — is written later, by the ingest
 * the workflow runs, so nothing refreshed at the moment of the click can show
 * it (Fizzy #2226).
 *
 * Completion is anchored to the exact Temporal RUN the click started or
 * joined, not to a sync-state row's `updatedAt` (Fizzy #2722): a row another
 * writer touched (the 15-minute auto-sync, a teammate, another tab) looks
 * identical to one this sync wrote, and a row the previous sync never wrote —
 * a first sync, a newly connected source — never existed to compare against
 * in the first place. The run itself cannot be confused with another
 * writer's: `sync` and the scheduled sweep both start the SAME workflow id,
 * and a click during an in-flight run joins it (`USE_EXISTING`), so its
 * `runId` names exactly the execution whose close means this sync is done.
 *
 * The watch lives here rather than in the Runs panel because the panel is one
 * sub-tab: switching to Cases unmounted it, and with it the only poll that
 * could see the ingest land. A module-level watch survives that, and a
 * navigation away and back, the same way `useStoryKindRegeneration` does.
 */

/** The sync activity's own bound: three attempts of at most three minutes. */
const SYNC_WATCH_LIMIT_MS = 10 * 60_000;
const FAST_POLL_WINDOW_MS = 60_000;

interface PipelineSyncWatch {
	startedAt: number;
	/** The exact Temporal run `sync` started or joined. */
	runId: string;
}

let watches = new Map<string, PipelineSyncWatch>();
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
	for (const subscriber of subscribers) {
		subscriber();
	}
}

const toMs = (value: Date | string) => new Date(value).getTime();

/** Record that a sync was just requested, naming the run it started or joined. */
export function watchPipelineSync(projectId: string, runId: string): void {
	watches = new Map(watches).set(projectId, {
		startedAt: Date.now(),
		runId,
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

export function pipelineSyncPollInterval(
	watch: PipelineSyncWatch | null,
): number | false {
	if (!watch) {
		return false;
	}
	return Date.now() - watch.startedAt < FAST_POLL_WINDOW_MS ? 3000 : 10_000;
}

/**
 * Everything on the Testing tab and the QA matrix that is a product of
 * pipeline ingestion.
 */
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
		orpc.projects.testCases.sectionCounts.key(),
		orpc.projects.testCases.coverageIndex.get.key(),
	];
}

/**
 * Mount once per surface that shows ingestion products, ABOVE its sub-tabs.
 * Polls the watched run while a requested sync is in flight, and re-reads
 * every ingestion product once that run closes — plus, progressively, each
 * time a source finishes an attempt before then, including one that wrote
 * results and then failed, which never advances `lastFetchedAt`.
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

	const runStateQuery = useQuery(
		orpc.projects.pipelineResults.syncRun.queryOptions({
			input: watch ? { projectId, runId: watch.runId } : skipToken,
			refetchInterval: () => pipelineSyncPollInterval(watch),
		}),
	);

	const closed = watch !== null && runStateQuery.data?.state === "closed";
	useEffect(() => {
		if (!closed) {
			return;
		}
		// Re-read syncStates too, not just the ingestion products: polling
		// stops right after this, so if the last syncStates poll landed just
		// before the run's final row write, "Last synced" and the failure
		// banner (both read from it) would otherwise stay pre-sync forever.
		queryClient.invalidateQueries({
			queryKey: orpc.projects.pipelineResults.syncStates.key(),
		});
		for (const key of ingestionProductKeys()) {
			queryClient.invalidateQueries({ queryKey: key });
		}
		unwatchPipelineSync(projectId);
	}, [closed, projectId, queryClient]);

	// A run that never closes (a stuck worker, a Temporal outage) must not
	// hold the poll open forever.
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

	// Progressive refresh: re-read ingestion products as each source finishes
	// an attempt, even before the run itself closes — earlier signal per
	// source than waiting for the whole run to end.
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
