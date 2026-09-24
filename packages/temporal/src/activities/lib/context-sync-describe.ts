/**
 * The describe phase of the Living Memory sync's `begin` (design 2026-09-23
 * §5.3.0 step 2, Fizzy #2657): ask Temporal about each unfinished
 * predecessor's EXACT execution, bounded, with no transaction open.
 *
 * The API makes the same describes before "Sync now" starts a run
 * (`describeContextSyncExecutions` in
 * `packages/api/modules/projects/lib/context-repository-sync-workflow.ts`).
 * `@repo/temporal` cannot import `@repo/api`, so this is its twin: same
 * budgets, same classification. Change the two together.
 */
import { contextRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../../client";

/**
 * What a describe of ONE execution said. `unknown` — a failed or timed-out
 * describe, a status nobody can act on, or a key the budget did not reach —
 * is never read as closed.
 */
export type ContextSyncExecutionState =
	| "running"
	| "closed"
	| "not-found"
	| "unknown";

/** Per-describe and total budgets (§5.3.0 step 2, §8). */
export const CONTEXT_SYNC_DESCRIBE_TIMEOUT_MS = 5_000;
export const CONTEXT_SYNC_DESCRIBE_BUDGET_MS = 20_000;

const CLOSED_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TERMINATED",
	"TIMED_OUT",
	"CONTINUED_AS_NEW",
]);

class DescribeTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DescribeTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The workflow run id a run key names: `<syncId>:<workflow run id>`. `null`
 * for a key of another shape, which the caller treats as `unknown`.
 */
export function workflowRunIdFromRunKey(
	syncId: string,
	runKey: string,
): string | null {
	const prefix = `${syncId}:`;
	if (!runKey.startsWith(prefix) || runKey.length === prefix.length) {
		return null;
	}
	return runKey.slice(prefix.length);
}

/**
 * Describe each run key's exact execution (the project's workflow id + the
 * run id in the key), one after another, each bounded by 5 seconds and all
 * of them by 20 seconds; a key the budget does not reach is `unknown`. Never
 * call it with a transaction open (§4.5).
 */
export async function describeContextSyncExecutions(input: {
	projectId: string;
	syncId: string;
	runKeys: readonly string[];
	now?: () => number;
	getClient?: () => Promise<Pick<Client, "workflow">>;
}): Promise<Map<string, ContextSyncExecutionState>> {
	const now = input.now ?? Date.now;
	const states = new Map<string, ContextSyncExecutionState>();
	if (input.runKeys.length === 0) {
		return states;
	}
	const deadline = now() + CONTEXT_SYNC_DESCRIBE_BUDGET_MS;
	let client: Pick<Client, "workflow"> | null = null;
	try {
		client = await withTimeout(
			(input.getClient ?? getTemporalClient)(),
			CONTEXT_SYNC_DESCRIBE_TIMEOUT_MS,
		);
	} catch {
		client = null;
	}
	const workflowId = contextRepositorySyncWorkflowId(input.projectId);
	for (const runKey of input.runKeys) {
		const runId = workflowRunIdFromRunKey(input.syncId, runKey);
		const remaining = deadline - now();
		if (!client || runId === null || remaining <= 0) {
			states.set(runKey, "unknown");
			continue;
		}
		try {
			const description = await withTimeout(
				client.workflow.getHandle(workflowId, runId).describe(),
				Math.min(CONTEXT_SYNC_DESCRIBE_TIMEOUT_MS, remaining),
			);
			const status = description.status.name;
			states.set(
				runKey,
				status === "RUNNING"
					? "running"
					: CLOSED_STATUSES.has(status)
						? "closed"
						: "unknown",
			);
		} catch (error) {
			states.set(
				runKey,
				error instanceof Error && error.name === "WorkflowNotFoundError"
					? "not-found"
					: "unknown",
			);
		}
	}
	return states;
}
