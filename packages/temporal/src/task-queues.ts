/**
 * Task queue names shared by the worker and every workflow starter.
 *
 * A starter that names a queue nobody polls does not fail — the workflow
 * is accepted and then sits in Temporal forever. The story-column automation
 * did exactly that for its whole life by starting the orchestrator on
 * `"orchestrator"` while the worker polled `"fabric-orchestrator"`. Keep the
 * string in one place so the worker and the starters cannot drift again.
 *
 * This module is intentionally free of imports so it can be pulled into the
 * API package, the web app and the worker without dragging the Temporal SDK
 * or the workflow bundle along.
 */

/** Queue the CUGA-inspired orchestrator worker polls. */
export const ORCHESTRATOR_TASK_QUEUE = "fabric-orchestrator" as const;
