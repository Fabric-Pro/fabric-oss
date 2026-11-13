/**
 * Start decision extraction for a synced Living Memory file once its embedding
 * has confirmed a content version (`embedSingleContextActivity` calls this
 * after a successful embed).
 *
 * Only a synced file qualifies: a row with a `sourcePath` and a `contentHash`,
 * not store-only (`indexingExcluded`), whose `embeddedAt` is set. A version
 * that already has an extraction is skipped here, and the extraction activity
 * checks again, so a repeated embed never reads the same version twice.
 *
 * A version a repository's first sync wrote is skipped too, because reading a
 * whole repository costs one AI request per file. `scanRequested` is a member
 * asking for it from the Decisions tab: it reads the version anyway. Its
 * candidates are announced to the project's other reviewers;
 * `requestedByUserId`, the member who asked, is left out, since they are
 * already looking.
 *
 * The workflow id is `living-memory-decisions-<contextId>-<contentHash>`:
 * a second start for the same version while one is open joins nothing and
 * fails with "already started", which is the expected answer. The reuse
 * policy lets a version whose earlier run FAILED be tried again on its next
 * embed.
 *
 * Never throws: extraction is an enrichment, and a failure to start it must
 * not fail or retry the embedding that called it.
 *
 * Lives in ./lib so the activities barrel never exposes it as an activity.
 */
import { db } from "@repo/database";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../../client";
import { activityLogger } from "./activity-logger";

/** The registered workflow type. */
const LIVING_MEMORY_DECISION_WORKFLOW_TYPE =
	"livingMemoryDecisionExtractionWorkflow";

/** The general worker's queue; the workflow's activity runs there too. */
const LIVING_MEMORY_DECISION_TASK_QUEUE = "fabric-worker";

export function livingMemoryDecisionWorkflowId(
	contextId: string,
	contentHash: string,
): string {
	return `living-memory-decisions-${contextId}-${contentHash}`;
}

type LivingMemoryDecisionStartOutcome =
	| "started"
	| "already_running"
	| "not_eligible"
	| "already_extracted"
	| "first_sync_skipped"
	| "failed";

export async function startLivingMemoryDecisionExtraction(input: {
	contextId: string;
	scanRequested?: boolean;
	requestedByUserId?: string;
}): Promise<LivingMemoryDecisionStartOutcome> {
	try {
		const context = await db.projectContext.findUnique({
			where: { id: input.contextId },
			select: {
				id: true,
				sourcePath: true,
				contentHash: true,
				decisionScanSkippedHash: true,
				indexingExcluded: true,
				embeddedAt: true,
			},
		});
		if (
			!context?.sourcePath ||
			!context.contentHash ||
			context.indexingExcluded ||
			!context.embeddedAt
		) {
			return "not_eligible";
		}
		const contentHash = context.contentHash;
		if (
			!input.scanRequested &&
			context.decisionScanSkippedHash === contentHash
		) {
			return "first_sync_skipped";
		}
		const existing = await db.projectContextDecisionExtraction.findUnique({
			where: {
				contextId_contentHash: { contextId: context.id, contentHash },
			},
			select: { id: true },
		});
		if (existing) {
			return "already_extracted";
		}
		const client = await getTemporalClient();
		await client.workflow.start(LIVING_MEMORY_DECISION_WORKFLOW_TYPE, {
			taskQueue: LIVING_MEMORY_DECISION_TASK_QUEUE,
			workflowId: livingMemoryDecisionWorkflowId(context.id, contentHash),
			workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
			workflowIdConflictPolicy: "FAIL",
			args: [
				{
					contextId: context.id,
					contentHash,
					...(input.requestedByUserId
						? { requestedByUserId: input.requestedByUserId }
						: {}),
				},
			],
		});
		return "started";
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			return "already_running";
		}
		activityLogger.warn(
			"Could not start Living Memory decision extraction; embedding is unaffected",
			{
				contextId: input.contextId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return "failed";
	}
}
