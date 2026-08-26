/**
 * Temporal workflow correlation propagation.
 *
 * When an oRPC procedure starts a workflow, the request's correlation ID
 * should ride along so:
 * - Audit-log rows emitted from the workflow's activities share the same
 *   correlationId as the originating request.
 * - Operators searching audit / log / Temporal UI by correlation ID can
 *   stitch "user click" → "workflow started" → "activity executed".
 *
 * Temporal's `memo` field on workflow-start options is the natural carrier:
 * it is metadata-only (no Workflow Query API impact), accessible in
 * Temporal UI for filtering / inspection, and read at activity time via
 * `workflowInfo().memo` from within the workflow.
 *
 * For activities started today, `workflowInfo().workflowExecution.runId`
 * is also a stable correlation identity (every retry / replay of the same
 * attempt carries the same runId), so the audit-log retention activity
 * already uses it via `activityInfo().workflowExecution.runId`.
 *
 * Future workflows that need per-request grouping (rather than per-run
 * grouping) should:
 *   1. Call `withCorrelationMemo(options)` on the start options here.
 *   2. Inside the workflow, read `workflowInfo().memo.correlationId` and
 *      pass it explicitly to activities that need it.
 *
 * Spec: docs/audit-log/README.md §15
 * (correlation ID flow).
 */

import { getCorrelationIdFromContext } from "./correlation-id";

/**
 * Augment Temporal `WorkflowStartOptions` (or any options bag that
 * supports a `memo` record) with `correlationId` from the active
 * AsyncLocalStorage context.
 *
 * No-op when no correlation context is active (e.g. workflows started
 * from a Temporal schedule, not from an oRPC request). Existing `memo`
 * keys are preserved; we do NOT overwrite a caller-supplied
 * `memo.correlationId`.
 *
 * @example
 * ```ts
 * await client.workflow.start("myWorkflow", withCorrelationMemo({
 *   taskQueue: "default",
 *   workflowId: "wf-123",
 *   args: [input],
 * }));
 * ```
 */
export function withCorrelationMemo<T extends object>(options: T): T {
	const correlationId = getCorrelationIdFromContext();
	if (!correlationId) {
		return options;
	}
	const optsWithMemo = options as T & {
		memo?: Record<string, unknown>;
	};
	const existingMemo = optsWithMemo.memo ?? {};
	// Respect a caller-supplied memo.correlationId — don't clobber it.
	if (
		typeof existingMemo.correlationId === "string" &&
		existingMemo.correlationId.length > 0
	) {
		return options;
	}
	return {
		...options,
		memo: { ...existingMemo, correlationId },
	} as T;
}
