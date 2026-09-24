/**
 * The Temporal-side twin of `@repo/api`'s `startContextRepositorySync`
 * (packages/api/modules/projects/lib/context-repository-sync-workflow.ts),
 * for the automatic triggers (design 2026-09-23 §11.1, Fizzy #2673). It is
 * the `context` subject's `startRun` (repository-sync-subjects.ts), so the
 * shared poll and the push webhook start Living Memory runs through it.
 *
 * Mirrors `startAutomaticInstructionSync` (./instruction-sync-start.ts): the
 * workflow type, queue, id and conflict policy are the API's, so an
 * automatic start and a "Sync now" for one project collapse onto one run
 * and `already_running` is the normal answer while one is open. The id comes
 * from `contextRepositorySyncWorkflowId` in `@repo/instructions/workflow-ids`,
 * the string `begin`'s describes use too; the API keeps its own copy, and
 * both tests pin the literals. `withCorrelationMemo` lives in `@repo/api`,
 * which this package cannot import, so a caller with a request context (the
 * webhook) passes it as `decorate`; a schedule-originated start has none.
 *
 * The workflow input is `{ projectId, organizationId, trigger, expected? }`:
 * no requester, because an automatic run acts as the configuration's member,
 * which `begin` reads under the configuration lock, and no credential,
 * because the run resolves its own. `expected` is the row the caller decided
 * on, and `begin` refuses the run when the row has moved since.
 *
 * One attempt. An open run is `already_running`, and any other failure is
 * rethrown, because its outcome is unknown: the server may have started the
 * run before the answer was lost, and a retry could start a second one. The
 * poll's check leaves its lease to expire instead.
 *
 * The result names the run the start reached: the new run's id from the
 * start handle, or the open run's from `describe()`. `runId` is the identity
 * to adopt; a caller that needs the receipt key builds `<syncId>:<runId>`
 * (`contextSyncRunKey`) from its own row, as `settlePendingHead` does. The
 * result carries no key of its own (Fizzy #2701, mirrored): a started run's
 * `begin` can still refuse it under `expected`, so a key named here would
 * describe a run that never happened.
 *
 * Lives in ./lib so the activities barrel never exposes it as an activity.
 */
import { contextRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../../client";
import type { AutomaticContextSyncWorkflowInput } from "../../lib/context-sync-types";
import type {
	RepositorySyncStartDecorator,
	RepositorySyncStartResult,
} from "./instruction-sync-start";

/** The registered workflow type, as the API starts it by name. */
const CONTEXT_REPOSITORY_SYNC_WORKFLOW_TYPE =
	"projectContextRepositorySyncWorkflow";

/** The queue the workflow runs on; its activities route to `fabric-worker`. */
const CONTEXT_REPOSITORY_SYNC_WORKFLOW_TASK_QUEUE = "project-documents";

export async function startAutomaticContextSync(
	input: AutomaticContextSyncWorkflowInput,
	decorate?: RepositorySyncStartDecorator,
): Promise<RepositorySyncStartResult> {
	const args: [AutomaticContextSyncWorkflowInput] = [
		{
			projectId: input.projectId,
			organizationId: input.organizationId,
			trigger: input.trigger,
			...(input.expected ? { expected: input.expected } : {}),
		},
	];
	const workflowId = contextRepositorySyncWorkflowId(input.projectId);
	const plain = {
		taskQueue: CONTEXT_REPOSITORY_SYNC_WORKFLOW_TASK_QUEUE,
		workflowId,
		workflowIdConflictPolicy: "FAIL" as const,
		args,
	};
	const options = decorate ? decorate(plain) : plain;
	const client = await getTemporalClient();
	const reached = (
		outcome: RepositorySyncStartResult["outcome"],
		runId: string,
	): RepositorySyncStartResult => ({ outcome, workflowId, runId });
	try {
		const handle = await client.workflow.start(
			CONTEXT_REPOSITORY_SYNC_WORKFLOW_TYPE,
			options,
		);
		return reached("started", handle.firstExecutionRunId);
	} catch (error) {
		if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
			throw error;
		}
	}
	// The open run's id. `describe` failing is rethrown: the caller treats it
	// like any failed start.
	const open = await client.workflow.getHandle(workflowId).describe();
	return reached("already_running", open.runId);
}
