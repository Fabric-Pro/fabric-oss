/**
 * Starting a workflow run and reading a workflow's run history.
 *
 * The one implementation behind the builder's Run button, the Fabric Agent's
 * `fabric_execute_workflow` and `fabric_list_workflow_runs`. Like the commands
 * in `workflow-commands.ts` it takes an explicit actor and asks the actor's
 * current permission itself.
 */

import {
	canEditProject,
	canRunOrganizationWorkflows,
	createWorkflowExecutionIdempotent,
	isWorkflowLive,
	listWorkflowExecutions,
	type Prisma,
	type WorkflowExecution,
} from "@repo/database";
import {
	concurrencyRefusalMessage,
	createExecutionWithinConcurrencyCap,
	resolveExecutionConcurrencyLimit,
} from "./execution-concurrency";
import type { StartWorkflowBuilderExecutionInput } from "./start-builder-execution";
import { startReservedExecution } from "./start-reserved-execution";
import {
	loadPermittedWorkflow,
	loadReadableWorkflow,
	WorkflowCommandError,
	type WorkflowActor,
} from "./workflow-command-context";
import { toRunSummary, type WorkflowRunSummary } from "./workflow-run-output";
import { validateWorkflowBeforeExecution } from "./workflow-validation";

/**
 * How long a client idempotency key identifies its run. Long enough to cover
 * a double-click, a browser retry after a dropped connection, and a user
 * mashing the button while the first response is in flight; short enough
 * that a key the client accidentally reuses tomorrow starts a fresh run.
 */
const EXECUTION_IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

interface StartWorkflowExecutionInput {
	workflowId: string;
	triggerData?: Record<string, unknown>;
	variables?: Record<string, unknown>;
	/**
	 * When present, a second start with the same key from the same user for
	 * the same workflow inside the idempotency window returns the run the first
	 * one created instead of starting another.
	 */
	idempotencyKey?: string;
	/** The current graph from the editor, when it has unsaved changes. */
	nodes?: StartWorkflowBuilderExecutionInput["nodes"];
	edges?: StartWorkflowBuilderExecutionInput["edges"];
	/**
	 * Only a published (or active) workflow may be started. The builder leaves
	 * this off so an author can run a draft; every agent surface turns it on.
	 */
	requirePublished?: boolean;
	/**
	 * A project the run was confirmed in (the Fabric Agent's chat confirms a
	 * workflow in the project it is working in). The workflow must belong to it
	 * and the actor must still be able to edit it, or the start is refused.
	 */
	confirmedProjectId?: string;
	/** Recorded on the execution row so the run history says who started it. */
	source?: string;
}

type StartWorkflowExecutionOutcome =
	| {
			status: "started" | "unconfirmed";
			execution: WorkflowExecution;
			temporalWorkflowId: string | null;
			workflowName: string;
			message?: string;
			deduplicated?: true;
	  }
	| {
			status: "failed";
			/** No request reached the engine, or the engine refused it. */
			failure?: "engine-unavailable" | "start-rejected";
			execution: WorkflowExecution;
			temporalWorkflowId: string | null;
			workflowName: string;
			message: string;
			deduplicated?: true;
	  };

export async function startWorkflowExecutionCommand(
	actor: WorkflowActor,
	input: StartWorkflowExecutionInput,
): Promise<StartWorkflowExecutionOutcome> {
	const workflow = await loadPermittedWorkflow(actor, input.workflowId, {
		permitted: canRunOrganizationWorkflows,
		refusal:
			"You do not have permission to run workflows in this organization",
	});

	if (
		input.confirmedProjectId &&
		!(
			workflow.projectId === input.confirmedProjectId &&
			(await canEditProject(workflow.projectId, actor.userId))
		)
	) {
		throw new WorkflowCommandError(
			"FORBIDDEN",
			"Workflow is not accessible in the confirmed project.",
		);
	}

	// The status rule is one rule for every surface that asks for it: any
	// published or active workflow may be started now, whatever its trigger.
	if (input.requirePublished && !isWorkflowLive(workflow.status)) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			`Workflow is ${workflow.status}; only a published workflow can be run`,
		);
	}

	const nodes = input.nodes || (workflow.nodes as unknown[]) || [];
	const edges = input.edges || (workflow.edges as unknown[]) || [];
	const validation = validateWorkflowBeforeExecution(nodes, edges);
	if (!validation.valid) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			`Workflow validation failed: ${validation.errors.join("; ")}`,
		);
	}
	if (validation.warnings.length > 0) {
		console.log(
			`[Workflow Execution] Warnings for ${workflow.id}:`,
			validation.warnings,
		);
	}

	// Create the execution row inside the capacity reservation, so the
	// tenant's in-flight cap holds under concurrent starts rather than only
	// when nobody races for it. A refusal creates nothing: a row for a run
	// that is only going to queue behind the tenant's own backlog is noise in
	// the run history.
	//
	// With an idempotency key the row is a find-or-create serialised on the
	// key, and the key is resolved BEFORE the cap: a retry carrying the key of
	// a run already started asks for nothing new and must get that run back
	// even when the tenant is at its cap — the case where the first request
	// started the last permitted run and lost its response.
	const triggerInput = {
		triggerData: input.triggerData,
		variables: input.variables,
		...(input.source ? { source: input.source } : {}),
	};
	let execution: WorkflowExecution;
	if (input.idempotencyKey) {
		const result = await createWorkflowExecutionIdempotent({
			workflowId: input.workflowId,
			version: workflow.version,
			triggerType: "MANUAL",
			triggerInput: triggerInput as Record<
				string,
				Prisma.InputJsonValue | undefined
			>,
			userId: actor.userId,
			organizationId: actor.organizationId,
			idempotencyKey: input.idempotencyKey,
			windowMs: EXECUTION_IDEMPOTENCY_WINDOW_MS,
			limit: await resolveExecutionConcurrencyLimit(actor.organizationId),
		});
		if (result.outcome === "limit-reached") {
			throw new WorkflowCommandError(
				"TOO_MANY_REQUESTS",
				concurrencyRefusalMessage(result),
			);
		}
		if (result.outcome === "existing") {
			const existing = result.execution;
			// A PENDING row with no run id has no confirmed start: the first
			// request may still be between its insert and its engine start, or
			// its start was unconfirmed. Reporting that as "started" told the
			// editor a run existed; it is "unconfirmed", and the caller polls
			// the same execution id.
			if (existing.status === "FAILED") {
				return {
					status: "failed",
					execution: existing,
					temporalWorkflowId: existing.temporalRunId,
					workflowName: workflow.name,
					message: existing.error ?? "The run failed to start",
					deduplicated: true,
				};
			}
			return {
				status:
					existing.status === "PENDING" && !existing.temporalRunId
						? "unconfirmed"
						: "started",
				execution: existing,
				temporalWorkflowId: existing.temporalRunId,
				workflowName: workflow.name,
				deduplicated: true,
			};
		}
		execution = result.execution;
	} else {
		const reservation = await createExecutionWithinConcurrencyCap({
			userId: actor.userId,
			organizationId: actor.organizationId,
			data: {
				workflowId: input.workflowId,
				version: workflow.version,
				triggerType: "MANUAL",
				triggerInput: triggerInput as Prisma.InputJsonValue,
			},
		});
		if (!reservation.allowed) {
			throw new WorkflowCommandError(
				"TOO_MANY_REQUESTS",
				concurrencyRefusalMessage(reservation),
			);
		}
		execution = reservation.execution;
	}

	const started = await startReservedExecution({
		execution,
		logTag: "Workflow Execution",
		start: {
			workflowId: input.workflowId,
			userId: actor.userId,
			organizationId: actor.organizationId,
			// Owning project — enables the Read-only mode write gate even when
			// nodes/edges are passed inline (the workflow only loads the row
			// when they are not)
			projectId: workflow.projectId ?? undefined,
			triggerData: input.triggerData,
			variables: input.variables,
			// Current nodes/edges if provided (unsaved changes). The caller's
			// schema bounds their size and count, not their shape; the
			// validator above has already refused a malformed graph.
			nodes: input.nodes,
			edges: input.edges,
		},
	});
	if (started.status === "failed") {
		return {
			status: "failed",
			failure: started.failure,
			execution: { ...execution, status: "FAILED" },
			temporalWorkflowId: null,
			workflowName: workflow.name,
			message: started.message,
		};
	}
	return {
		status: started.status,
		execution,
		temporalWorkflowId: started.temporalWorkflowId,
		workflowName: workflow.name,
		...(started.status === "unconfirmed"
			? { message: started.message }
			: {}),
	};
}

/** A workflow's executions with their step counts, newest first. */
export async function listWorkflowExecutionsCommand(
	actor: WorkflowActor,
	input: {
		workflowId: string;
		status?: WorkflowExecution["status"];
		limit?: number;
		offset?: number;
	},
) {
	await loadReadableWorkflow(actor, input.workflowId);

	return listWorkflowExecutions({
		workflowId: input.workflowId,
		userId: actor.userId,
		organizationId: actor.organizationId,
		status: input.status,
		limit: input.limit,
		offset: input.offset,
	});
}

/** The run history a chat can carry: a few runs, each with a bounded output summary. */
export async function listWorkflowRunsCommand(
	actor: WorkflowActor,
	input: { workflowId: string; limit?: number },
): Promise<WorkflowRunSummary[]> {
	const { executions } = await listWorkflowExecutionsCommand(actor, {
		workflowId: input.workflowId,
		limit: Math.min(Math.max(input.limit ?? 10, 1), 20),
	});
	return executions.map(toRunSummary);
}
