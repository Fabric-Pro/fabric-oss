/**
 * The Temporal-side twin of `@repo/api`'s `startInstructionRepositorySync`
 * (packages/api/modules/projects/procedures/instructions/repository-sync/
 * start-sync-workflow.ts), for the automatic triggers (spec §6.1, §6.2). The
 * workflow id, queue and conflict policy are the same, so an automatic start
 * and a manual start for one project collapse onto one run:
 * `already_running` is the normal answer while one is open.
 *
 * It is the instructions subject's `startRun` (repository-sync-subjects.ts,
 * Decision 46), so the push webhook starts through it too. Unlike
 * dispatch-scheduled-report.ts there is no `REJECT_DUPLICATE`: the id is per
 * project and every run reuses it. `withCorrelationMemo` lives in
 * `@repo/api`, which this package cannot import, so a caller with a request
 * context passes it as `decorate`; a schedule-originated start has none.
 *
 * The workflow input is `{ projectId, organizationId, trigger, expected? }`.
 * No run id: the sync workflow puts its own `workflowInfo().runId` into
 * `begin` and into the state `record` rebuilds the run key from, for every
 * trigger (Decision 44). `expected` is the row the caller decided on, and
 * `begin` refuses the run when the row has moved since (Decision 56). The
 * trigger's type is any value of the run row's enum but MANUAL, so a trigger
 * a later migration adds needs no edit to this starter; only
 * `AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS` in instruction-sync-types.ts decides
 * which of those values `begin` and `deriveSyncRunOutcome` actually treat as
 * automatic (Decision 47).
 *
 * One attempt (Decision 51). An open run is `already_running`, and any other
 * failure is rethrown, because its outcome is unknown: the server may have
 * started the run before the answer was lost. A retry could then start a
 * second run, and a second run is not free: `begin` inserts its receipt
 * before it checks anything, and `acquire` clones before it compares, so it
 * would do real work and add a History row. The poll's check leaves its
 * lease to expire instead, and the next claim finds the run open or its
 * completion's cursor.
 *
 * The result names the run the start reached (Decision 56): the new run's
 * id from the start handle, or the open run's from `describe()`, and the key
 * `begin` gives that run's receipt, `<syncId>:<runId>`.
 *
 * Lives in ./lib so the activities barrel never exposes it as an activity.
 */
import { instructionRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../../client";
import type { AutomaticInstructionSyncWorkflowInput } from "../../lib/instruction-sync-types";

/** Adjusts the start options without changing their type, like `withCorrelationMemo`. */
export type RepositorySyncStartDecorator = <T extends object>(options: T) => T;

/** The run an automatic start reached (Decision 56). */
export type RepositorySyncStartResult = {
	outcome: "started" | "already_running";
	workflowId: string;
	/** The run this start began, or the one already open. */
	runId: string;
	/** `<syncId>:<runId>`, exactly as `begin` keys that run's receipt. */
	runKey: string;
};

export async function startAutomaticInstructionSync(
	input: AutomaticInstructionSyncWorkflowInput & {
		/** The row's id, for the run key; not part of the workflow input. */
		syncId: string;
	},
	decorate?: RepositorySyncStartDecorator,
): Promise<RepositorySyncStartResult> {
	const args: [AutomaticInstructionSyncWorkflowInput] = [
		{
			projectId: input.projectId,
			organizationId: input.organizationId,
			trigger: input.trigger,
			...(input.expected ? { expected: input.expected } : {}),
		},
	];
	const workflowId = instructionRepositorySyncWorkflowId(input.projectId);
	const plain = {
		taskQueue: "project-instructions",
		workflowId,
		workflowIdConflictPolicy: "FAIL" as const,
		args,
	};
	const options = decorate ? decorate(plain) : plain;
	const client = await getTemporalClient();
	const reached = (
		outcome: RepositorySyncStartResult["outcome"],
		runId: string,
	): RepositorySyncStartResult => ({
		outcome,
		workflowId,
		runId,
		runKey: `${input.syncId}:${runId}`,
	});
	try {
		const handle = await client.workflow.start(
			"projectInstructionRepositorySyncWorkflow",
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
