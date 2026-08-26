/**
 * Limits that must hold for a workflow-builder run however it was triggered.
 *
 * These lived inline in the manual-run procedure, so the webhook route — the
 * one path an external caller can drive — was the only trigger with no run
 * ceiling and no queue agreement. A guard that only covers the path a human
 * watches is not a guard.
 */

/**
 * Wall-clock ceiling for a single workflow-builder run.
 *
 * Generous by design: a node activity may take ten minutes, an approval gate
 * waits up to five, and a long graph legitimately chains many of them. This is
 * a runaway guard, not a product limit — it exists so a wedged or pathological
 * run cannot hold resources forever. Temporal marks a run that exceeds it
 * TIMED_OUT, a status the schema already models.
 */
export const WORKFLOW_RUN_TIMEOUT = "6 hours";

/**
 * The queue workflow-builder runs belong on.
 *
 * The dedicated worker sizes its slots for these runs, the schedule client
 * dispatches here, and the per-tenant concurrency cap is reasoned against this
 * queue's capacity. The webhook route used to dispatch to the general-purpose
 * `fabric-worker` queue instead: both workers share one workflow bundle so the
 * run still executed, but it competed with unrelated background work for a
 * smaller pool, and the concurrency cap was protecting the wrong queue.
 */
export const WORKFLOW_BUILDER_TASK_QUEUE = "workflow-builder";
