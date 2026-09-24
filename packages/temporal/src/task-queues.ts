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

/**
 * Where the Living Memory repository sync workflow's OWN activities run
 * (begin, sync, record; design 2026-09-23 §5.2). The workflow itself stays on
 * `project-documents`, whose five activity slots serve a member waiting on
 * "Update using context": a twenty-minute clone-and-apply holding one of them
 * would make that member wait.
 *
 * Deliberately the same string as `INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE`
 * below: both repository syncs share the general worker's activity slots.
 */
export const CONTEXT_SYNC_ACTIVITY_TASK_QUEUE = "fabric-worker" as const;

/**
 * Where the repository sync workflow's OWN activities run (begin, acquire,
 * settle, record). The workflow itself, and the snapshot workflow it starts
 * as a child, stay on `project-instructions`; that queue's two activity slots
 * are sized for upload validation, and a ten-minute clone or a ten-minute
 * settle poll holding one of them would make an upload wait (the reaper
 * schedule is kept off it for the same reason, `schedules.ts:710-722`).
 */
export const INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE = "fabric-worker" as const;
