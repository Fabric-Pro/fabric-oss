/**
 * The workflow reads — a listing, one workflow, one execution.
 *
 * The one implementation behind the oRPC procedures and the MCP gateway's
 * `fabric_list_workflows`, `fabric_get_workflow` and
 * `fabric_get_workflow_execution`. Like every command it takes an explicit actor
 * and asks the actor's current membership and read permission itself.
 */

import {
	getWorkflowExecutionById,
	listWorkflowExecutions,
	listWorkflows,
} from "@repo/database";
import {
	loadReadableWorkflow,
	requireReadAccess,
	WorkflowCommandError,
	type WorkflowActor,
} from "./workflow-command-context";
import { toRunSummary } from "./workflow-run-output";

type WorkflowFilters = Omit<
	Parameters<typeof listWorkflows>[0],
	"userId" | "organizationId"
>;

/** The actor's workflows in their organization, filtered and paged. */
export async function listWorkflowsCommand(
	actor: WorkflowActor,
	filters: WorkflowFilters,
) {
	await requireReadAccess(actor);
	return listWorkflows({
		...filters,
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
}

/** One workflow the actor owns in their organization. */
export function getWorkflowCommand(actor: WorkflowActor, workflowId: string) {
	return loadReadableWorkflow(actor, workflowId);
}

/** One workflow with its most recent run, for a chat that wants both. */
export async function getWorkflowWithLatestRunCommand(
	actor: WorkflowActor,
	workflowId: string,
) {
	const workflow = await loadReadableWorkflow(actor, workflowId);
	const { executions } = await listWorkflowExecutions({
		workflowId: workflow.id,
		userId: actor.userId,
		organizationId: actor.organizationId,
		limit: 1,
	});
	const [latest] = executions;
	return { workflow, latestRun: latest ? toRunSummary(latest) : null };
}

/** One execution of a workflow the actor owns, by its id. */
export async function getWorkflowExecutionCommand(
	actor: WorkflowActor,
	executionId: string,
) {
	await requireReadAccess(actor);
	const execution = await getWorkflowExecutionById(
		executionId,
		actor.userId,
		actor.organizationId,
	);
	if (!execution) {
		throw new WorkflowCommandError("NOT_FOUND", "Execution not found");
	}
	return execution;
}
