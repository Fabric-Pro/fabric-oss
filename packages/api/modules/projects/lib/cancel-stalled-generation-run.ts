import { logger } from "@repo/logs";
import { isWorkflowNotFoundError } from "../procedures/discovery/lib";

/**
 * The workflow to cancel for a document whose row names `workflowId`, or null
 * when that id is not one this document's generation child can be told from.
 *
 * - A child id (`…-child-<documentId>` from a single dispatch or a batch,
 *   `…-doc-<documentId>` from a project setup) is the child itself.
 * - A single dispatch's own id (`project-document-generation-<documentId>-<hash>`)
 *   names its child by appending `-child-<documentId>`, as the dispatch
 *   workflow does when it starts it.
 * - Every other shape is left alone: a batch or setup parent, a resume
 *   (`…-resume-N`, whose row carries the resume parent's id), and an id that
 *   names another document. The hash is one segment, so a longer id under the
 *   dispatch prefix is not a dispatch.
 */
function generationChildWorkflowId(args: {
	documentId: string;
	workflowId: string;
}): string | null {
	const { documentId, workflowId } = args;
	if (
		workflowId.endsWith(`-child-${documentId}`) ||
		workflowId.endsWith(`-doc-${documentId}`)
	) {
		return workflowId;
	}
	const dispatchPrefix = `project-document-generation-${documentId}-`;
	if (workflowId.startsWith(dispatchPrefix)) {
		const hash = workflowId.slice(dispatchPrefix.length);
		if (hash !== "" && !hash.includes("-")) {
			return `${workflowId}-child-${documentId}`;
		}
	}
	return null;
}

/**
 * Stop the generation run a person's editor save has just ended (Fizzy #2946).
 * The save already completed the document and cleared the run's token, so
 * this is tidy-up: a run that wakes again writes nothing it guards, and
 * cancelling it only keeps a stalled child from waking at all. Best effort;
 * it never throws.
 *
 * Only the GENERATION CHILD is cancelled, never its parent. A parent is a
 * whole batch, setup or dispatch: cancelling it would stop every other
 * document of the run, and its closing steps with them. The child names
 * exactly one document, and the parent's catch handles a failed child with
 * writes guarded to that child's run, so the person's COMPLETE stands.
 *
 * `cancel()`, never `terminate()`: a cancelled child still runs its catch,
 * and an artifact child's final failure carries its run token. The parent
 * guards its FAILED write by that token, which the save has cleared, so the
 * write matches nothing. A terminated child ends with no details, and the
 * parent would write FAILED without a guard.
 *
 * A workflow Temporal no longer knows (it finished, or never started) has
 * nothing left to stop, so it is not logged. Any other failure is logged with
 * ids only.
 */
export async function cancelStalledGenerationRun(args: {
	documentId: string;
	workflowId: string;
}): Promise<void> {
	const target = generationChildWorkflowId(args);
	if (!target) {
		return;
	}
	try {
		// Loaded on use: imported at the top, the Temporal client, and the
		// payments module it pulls in, would load with every importer of the
		// document save procedure, which has no other need for them.
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		await client.workflow.getHandle(target).cancel();
	} catch (error) {
		if (isWorkflowNotFoundError(error)) {
			return;
		}
		logger.warn(
			"[cancel-stalled-generation-run] Failed to cancel the generation child",
			{
				documentId: args.documentId,
				workflowId: args.workflowId,
				childWorkflowId: target,
				error: error instanceof Error ? error.name : "unknown",
			},
		);
	}
}
