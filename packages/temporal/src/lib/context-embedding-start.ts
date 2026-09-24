/**
 * Start `contextEmbeddingWorkflow` for one synced knowledge file (a
 * `ProjectContext` row keyed by `sourcePath`), the way every synced write
 * starts it. Shared by the API's synced-file upsert
 * (`packages/api/modules/projects/lib/upsert-synced-context.ts`, fire and
 * forget) and the Living Memory repository sync's index step (design
 * 2026-09-23 §5.3.1 step 9, awaiting each start), so the two cannot drift.
 *
 * The id is `context-embedding-<contextId>-<Date.now()>`: every start is a
 * new execution, never deduplicated against an earlier one, because the
 * guarded re-embed pass (`reembed: true`, see `embedSingleContextActivity`)
 * is what makes a repeated or concurrent pass safe, not the id.
 *
 * The body is NOT passed: up to 2 MiB would exceed Temporal's payload limit,
 * and the activity reads it back from the row.
 *
 * The client is the caller's (`getTemporalClient()` in both callers), so
 * this module opens no connection of its own and a caller's test double
 * reaches the start unchanged. Throws what the start throws; the caller
 * decides whether a failed start is logged (the upsert) or a failure of the
 * run (the sync, `STORE_FAILED`).
 */
import type { Client } from "@temporalio/client";

/** The registered workflow type and the queue it runs on. */
const CONTEXT_EMBEDDING_WORKFLOW = "contextEmbeddingWorkflow";
const CONTEXT_EMBEDDING_TASK_QUEUE = "project-documents";

export interface ContextEmbeddingStartTarget {
	contextId: string;
	projectId: string;
	/** Who the embedding runs as. */
	userId: string;
	/** The project's hosting organization, never a default. */
	organizationId: string;
	sourcePath: string;
	title: string;
	/**
	 * The hash-guarded pass: delete the row's old chunks, embed, then re-read
	 * the hash and repeat while a later write moved it.
	 */
	reembed: boolean;
}

export interface ContextEmbeddingStartOptions {
	/**
	 * Applied to the start options last — the API passes
	 * `withCorrelationMemo` so the request's correlation id rides along in
	 * the memo, as it does for every workflow the API starts.
	 */
	decorateStartOptions?: <T extends object>(options: T) => T;
	/** The clock the id is stamped from. Tests only. */
	now?: () => number;
}

export async function startContextEmbeddingWorkflow(
	client: Pick<Client, "workflow">,
	target: ContextEmbeddingStartTarget,
	options: ContextEmbeddingStartOptions = {},
): Promise<{ workflowId: string }> {
	const now = options.now ?? Date.now;
	const decorate =
		options.decorateStartOptions ?? (<T extends object>(o: T): T => o);
	const workflowId = `context-embedding-${target.contextId}-${now()}`;
	await client.workflow.start(
		CONTEXT_EMBEDDING_WORKFLOW,
		decorate({
			taskQueue: CONTEXT_EMBEDDING_TASK_QUEUE,
			workflowId,
			args: [
				{
					contextId: target.contextId,
					projectId: target.projectId,
					userId: target.userId,
					organizationId: target.organizationId,
					type: "TEXT",
					metadata: {
						// The path as the filename, so chunking sees the
						// extension (markdown, an OpenAPI document, code).
						filename: target.sourcePath,
						sourceTitle: target.title,
						sourcePath: target.sourcePath,
					},
					...(target.reembed ? { reembed: true } : {}),
				},
			],
		}),
	);
	return { workflowId };
}
