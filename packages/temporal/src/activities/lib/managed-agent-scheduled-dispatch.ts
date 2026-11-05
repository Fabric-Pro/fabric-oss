import { createHash } from "node:crypto";
import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import {
	type AgentExecutionDispatch,
	admitAgentDeploymentExecution,
	agentExecutionAdmissionId,
	checkExecutionQuota,
	db,
	getAgentTemplateInstanceForExecution,
	normalizeAgentExecutionRequest,
	type Prisma,
	readAgentExecutionAdmission,
} from "@repo/database";
import { managedAgentRunScheduleSchema } from "@repo/database/prisma/queries/lib/managed-agent-run-schedule";
import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { Context } from "@temporalio/activity";
import { getTemporalClient } from "../../client";
import { dispatchAdmittedAgentExecution } from "../../lib/agent-execution-dispatch";

export interface ManagedScheduleOccurrence {
	managedRunSchedule: 1;
	deploymentId: string;
	triggerId: string;
	userId?: string;
	organizationId?: string;
	occurrenceWorkflowId?: string;
	occurrenceFirstRunId?: string;
}
type Deployment = {
	id: string;
	instanceId: string;
	userId: string;
	organizationId: string | null;
	status: string;
};
type Trigger = {
	id: string;
	deploymentId: string;
	userId: string | null;
	organizationId: string | null;
	type: string;
	isActive: boolean;
	config: Prisma.JsonValue;
};
/** Existing native admission store owns occurrence deduplication; this module owns no second executor. */
export async function dispatchManagedAgentSchedule(
	input: ManagedScheduleOccurrence,
	deployment: Deployment,
	trigger: Trigger,
) {
	const actual = Context.current().info;
	const config = managedAgentRunScheduleSchema.safeParse(trigger.config);
	if (
		!config.success ||
		!input.organizationId ||
		actual.workflowType !== "managedAgentRunScheduleWorkflow" ||
		!actual.workflowExecution ||
		actual.workflowExecution.workflowId !== input.occurrenceWorkflowId ||
		!input.occurrenceFirstRunId ||
		input.occurrenceFirstRunId.length > 200 ||
		deployment.id !== input.deploymentId ||
		deployment.userId !== input.userId ||
		deployment.organizationId !== input.organizationId ||
		trigger.id !== input.triggerId ||
		trigger.deploymentId !== deployment.id ||
		trigger.userId !== deployment.userId ||
		trigger.organizationId !== deployment.organizationId ||
		trigger.type !== "SCHEDULE" ||
		!trigger.isActive ||
		deployment.status !== "ACTIVE"
	) {
		return {
			success: false,
			error: "Scheduled agent ownership, occurrence or active configuration could not be verified.",
		};
	}
	const scoped = await getAgentTemplateInstanceForExecution({
		instanceId: deployment.instanceId,
		userId: deployment.userId,
		organizationId: input.organizationId,
	});
	if (
		!scoped ||
		scoped.instance.status !== "ACTIVE" ||
		!getAgentImplementationAvailability(scoped.instance.customInstructions)
			.available
	) {
		return {
			success: false,
			error: "The scheduled agent's current execution permission is unavailable.",
		};
	}
	const key = `schedule-occurrence-${createHash("sha256")
		.update(
			JSON.stringify([
				trigger.id,
				input.occurrenceWorkflowId,
				input.occurrenceFirstRunId,
			]),
		)
		.digest("hex")}`;
	const actor = {
		userId: deployment.userId,
		organizationId: input.organizationId,
		deploymentId: deployment.id,
	};
	const occurrenceIdentity = {
		id: agentExecutionAdmissionId(actor, key),
		...actor,
		triggerType: "SCHEDULE",
		triggerId: trigger.id,
	};
	let execution = await db.agentDeploymentExecution.findFirst({
		where: occurrenceIdentity,
	});
	if (!execution) {
		// Initialize native organization quota storage for a schedule-first organization.
		// Existing reserved occurrences bypass this preflight and reconcile their original admission.
		const quota = await checkExecutionQuota(
			deployment.id,
			deployment.userId,
			input.organizationId,
		);
		if (!quota.allowed) {
			// An overlapping attempt may have reserved this occurrence after the initial read.
			execution = await db.agentDeploymentExecution.findFirst({
				where: occurrenceIdentity,
			});
			if (!execution) {
				return {
					success: false,
					error:
						quota.reason ||
						"Scheduled agent execution quota exceeded.",
				};
			}
		}
	}
	if (!execution) {
		const target = {
			instanceId: deployment.instanceId,
			...(scoped.projectId ? { projectId: scoped.projectId } : {}),
		};
		const dispatch: AgentExecutionDispatch =
			scoped.instance.executionMode === "goal_oriented"
				? {
						...target,
						workflowType: "nativeGoalOrientedAgentWorkflow",
						goal:
							scoped.instance.goal ||
							"Complete the requested task",
						maxIterations: scoped.instance.maxIterations || 10,
					}
				: {
						...target,
						workflowType: "nativeDeploymentExecutionWorkflow",
					};
		execution = (
			await admitAgentDeploymentExecution({
				...actor,
				idempotencyKey: key,
				request: normalizeAgentExecutionRequest({
					input: {
						...config.data.inputTemplate,
						_scheduled: {
							triggerId: trigger.id,
							occurrenceId: key,
						},
					},
					priority: 5,
				}),
				dispatch,
				triggerType: "SCHEDULE",
				triggerId: trigger.id,
				actor: { type: "system", userId: deployment.userId },
				correlationId: getCorrelationIdFromContext(),
			})
		).execution;
	}
	const admission = readAgentExecutionAdmission(execution);
	if (!admission || admission.dispatch.instanceId !== deployment.instanceId) {
		return {
			success: false,
			error: "The existing scheduled execution identity is unavailable; inspect this occurrence before retrying.",
		};
	}
	const receipt = await dispatchAdmittedAgentExecution(
		execution,
		{ allowStart: true },
		{
			getClient: getTemporalClient,
			decorate: <T extends object>(options: T): T => {
				const correlationId = getCorrelationIdFromContext();
				if (!correlationId) {
					return options;
				}
				const source = options as T & {
					memo?: Record<string, unknown>;
				};
				return { ...source, memo: { ...source.memo, correlationId } };
			},
		},
	);
	if (!receipt.confirmed || receipt.revoked) {
		throw new Error(
			"The scheduled occurrence admission is unresolved. Retry this same occurrence to reconcile its existing execution.",
		);
	}
	return { success: true, executionId: receipt.execution.id };
}
