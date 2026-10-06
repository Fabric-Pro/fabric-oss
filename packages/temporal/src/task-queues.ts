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

/**
 * Glossy edition builds (Fizzy #2589, KTD3). Its own queue and activity
 * slots, so a long build cannot starve the interactive `project-documents`
 * queue; the build procedure starts `glossyEditionBuildWorkflow` here.
 */
export const GLOSSY_EDITION_TASK_QUEUE = "glossy-edition" as const;

/**
 * Company context ingestion (Fizzy #2719): the file-processing, embedding,
 * deletion and crawl workflows, their activities and schedules, when the
 * owner is a company source. Only workers that know company context poll it,
 * so a worker without that change can never pick up a company job and run it
 * down the project path; during a rollback company jobs wait here instead of
 * failing.
 */
export const COMPANY_CONTEXT_TASK_QUEUE = "company-context" as const;

/**
 * Background project context/document embeddings, file ingestion and vector cleanup. Three
 * activity slots bound indexing independently of interactive generation.
 * Workflow starts may stay on their original queue; their embedding activities
 * explicitly use this queue, including workflows already waiting to schedule.
 * Activity queue options are replay-compatible; already-scheduled commands
 * retain their historical queue and must finish on its existing poller.
 */
export const PROJECT_EMBEDDING_TASK_QUEUE = "project-embeddings" as const;

/**
 * Interactive document generation, including tracking and dependency probes.
 * Separate from both indexing and the legacy project-documents activity queue,
 * which must keep draining commands already recorded in workflow histories.
 */
export const PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE =
	"project-document-generation" as const;

/**
 * Project discovery, scope intake, meeting operations and ingestion control.
 * Five independent activity slots keep visible progress off both bulk indexing
 * and legacy scheduled commands. Workflow starts keep their existing queues.
 */
export const PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE =
	"project-operations" as const;
