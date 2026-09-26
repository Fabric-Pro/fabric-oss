/**
 * The Temporal side of the Living Memory repository sync as the API sees it
 * (design 2026-09-23 §5.2, §5.3.0, §5.6, Fizzy #2657): the workflow id, the
 * start, and the bounded describes reconciliation makes.
 *
 * The workflow itself lives in `@repo/temporal` and is started by its
 * registered NAME, as `upsert-synced-context.ts` starts
 * `"contextEmbeddingWorkflow"`. Its id MUST be the literal
 * `contextRepositorySyncWorkflowId` builds — the workflow's own code and
 * `begin`'s run-key derivation rely on the same string — and its input MUST
 * be `ContextRepositorySyncWorkflowInput`.
 */
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	CLOSED_WORKFLOW_STATUSES,
	withTimeout,
} from "../../../lib/temporal-describe";

/** The registered workflow type name (T3 registers the function under it). */
const CONTEXT_REPOSITORY_SYNC_WORKFLOW = "projectContextRepositorySyncWorkflow";

/** The queue the workflow runs on; its activities route to `fabric-worker`. */
const CONTEXT_REPOSITORY_SYNC_TASK_QUEUE = "project-documents";

/**
 * ONE workflow id per project: with `workflowIdConflictPolicy: "FAIL"` a
 * second start while a run is open is refused by Temporal itself.
 */
export function contextRepositorySyncWorkflowId(projectId: string): string {
	return `context-repository-sync-${projectId}`;
}

/** What the workflow is started with (§5.2). */
export interface ContextRepositorySyncWorkflowInput {
	projectId: string;
	organizationId: string;
	trigger: "MANUAL";
	requesterUserId: string;
}

/**
 * Start the project's sync. `false` means Temporal refused the id because an
 * execution with it is open: already running. Any other failure throws. The
 * reuse policy stays the default, so a finished run never blocks the next.
 */
export async function startContextRepositorySync(
	input: ContextRepositorySyncWorkflowInput,
): Promise<boolean> {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			CONTEXT_REPOSITORY_SYNC_WORKFLOW,
			withCorrelationMemo({
				taskQueue: CONTEXT_REPOSITORY_SYNC_TASK_QUEUE,
				workflowId: contextRepositorySyncWorkflowId(input.projectId),
				workflowIdConflictPolicy: "FAIL",
				args: [input],
			}),
		);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkflowExecutionAlreadyStartedError"
		) {
			return false;
		}
		throw error;
	}
}

/**
 * Whether the project's latest sync execution is open, for the tab's
 * spinner. Any failure to ask reads as "not running": the tab degrades to
 * offering "Sync now", and `syncNow` itself never relies on this.
 */
export async function isContextRepositorySyncRunning(
	projectId: string,
): Promise<boolean> {
	try {
		const client = await getTemporalClient();
		const description = await client.workflow
			.getHandle(contextRepositorySyncWorkflowId(projectId))
			.describe();
		return description.status.name === "RUNNING";
	} catch {
		return false;
	}
}

/**
 * What a describe of ONE execution said. `unknown` — a failed or timed-out
 * describe, or a status nobody can act on — is never read as closed (§5.3.0
 * step 2).
 */
export type ContextSyncExecutionState =
	| "running"
	| "closed"
	| "not-found"
	| "unknown";

/** Per-describe and total budgets (§5.3.0 step 2, §8). */
const CONTEXT_SYNC_DESCRIBE_TIMEOUT_MS = 5_000;
const CONTEXT_SYNC_DESCRIBE_BUDGET_MS = 20_000;

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
 * Describe each run key's EXACT execution (workflow id + run id), one after
 * another, each bounded by 5 seconds and all of them by 20 seconds; a key
 * the budget does not reach is `unknown`. Called with no transaction open —
 * never under a row lock (§4.5).
 */
export async function describeContextSyncExecutions(input: {
	projectId: string;
	syncId: string;
	runKeys: readonly string[];
	now?: () => number;
}): Promise<Map<string, ContextSyncExecutionState>> {
	const now = input.now ?? Date.now;
	const states = new Map<string, ContextSyncExecutionState>();
	if (input.runKeys.length === 0) {
		return states;
	}
	const deadline = now() + CONTEXT_SYNC_DESCRIBE_BUDGET_MS;
	let client: Awaited<ReturnType<typeof getTemporalClient>> | null = null;
	try {
		client = await withTimeout(
			getTemporalClient(),
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
					: CLOSED_WORKFLOW_STATUSES.has(status)
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
