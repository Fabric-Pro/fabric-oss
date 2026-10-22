"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { workflowExecutionStatsKey, workflowExecutionsKey } from "./query-keys";
import type { RunFilter } from "./run-steps";

const ACTIVE_RUN_POLL_MS = 5000;
const VIEWED_RUN_POLL_MS = 2000;

function isActive(status: string) {
	return status === "PENDING" || status === "RUNNING";
}

/**
 * A workflow's recent runs under one filter. The runs panel and the editor's
 * "last run" read the same key, so the unfiltered list is fetched once.
 */
export function useWorkflowRuns(
	workflowId: string,
	organizationId: string | null | undefined,
	filter: RunFilter,
) {
	return useQuery({
		queryKey: workflowExecutionsKey(workflowId, organizationId, filter),
		queryFn: () =>
			orpcClient.workflows.executions.list({
				id: workflowId,
				organizationId,
				status: filter === "all" ? undefined : filter,
				limit: 20,
				offset: 0,
			}),
		// Only poll while a run is actually in flight; otherwise the editor
		// hammered this endpoint every 5s forever even when all runs finished.
		refetchInterval: (query) =>
			(query.state.data?.executions ?? []).some((e) => isActive(e.status))
				? ACTIVE_RUN_POLL_MS
				: false,
		enabled: Boolean(workflowId),
	});
}

/** Per-status run counts, for the filter segments and the collapsed button. */
export function useWorkflowRunStats(
	workflowId: string,
	organizationId: string | null | undefined,
) {
	return useQuery({
		queryKey: workflowExecutionStatsKey(workflowId, organizationId),
		queryFn: () =>
			orpcClient.workflows.executions.stats({
				id: workflowId,
				organizationId,
			}),
		refetchInterval: (query) =>
			(query.state.data?.running ?? 0) > 0 ? ACTIVE_RUN_POLL_MS : false,
		enabled: Boolean(workflowId),
	});
}

/**
 * The run being viewed, with its step logs. Same query as the execution
 * panel, so opening both does not fetch twice.
 */
export function useViewedExecution(
	executionId: string | null,
	organizationId: string | null | undefined,
) {
	return useQuery(
		orpc.workflows.executions.get.queryOptions({
			input: { executionId: executionId ?? "", organizationId },
			enabled: Boolean(executionId),
			refetchInterval: (query) => {
				const status = query.state.data?.execution?.status;
				return status && isActive(status) ? VIEWED_RUN_POLL_MS : false;
			},
		}),
	);
}
