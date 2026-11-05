import { ORPCError } from "@orpc/server";
import {
	db,
	getAgentTemplateInstanceForExecution,
	Prisma,
} from "@repo/database";
import {
	hasPermission,
	type Permission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { getTemporalClient } from "@repo/temporal";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";
import { readNativeExecutionState } from "../../external-api/lib/native-execution-state";
import { getOrCreateDeployment } from "../../external-api/procedures/execute-agent";
import {
	canReadAgentExecution,
	getExecution,
} from "../../external-api/procedures/get-execution";
import {
	buildManagedRunCalendar,
	readManagedRunSchedule,
	saveManagedRunSchedule,
} from "./managed-run-schedule";
import {
	agentRunIdentitySchema,
	agentRunInstanceSchema,
	agentRunListSchema,
	agentRunScheduleSchema,
} from "./run-contracts";
import {
	getOwnedRunDeployment,
	type RunControlActor,
	resolveRunControlInstance,
} from "./run-control-access";

export type RunCommandAudit = (
	event: RecordAuditFromRequestInput,
) => Promise<unknown>;
/** A resolved principal, never a fabricated request/session or caller-supplied scope. */
export interface RunCommandActor extends RunControlActor {
	external?: boolean;
}

async function authorize(actor: RunCommandActor, ...permissions: Permission[]) {
	if (!actor.userId || !actor.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "An organization and current member are required.",
		});
	}
	const member = await db.member.findFirst({
		where: { userId: actor.userId, organizationId: actor.organizationId },
		select: { role: true },
	});
	if (
		!member ||
		permissions.some(
			(permission) =>
				!hasPermission(resolveOrgPermissions(member.role), permission),
		)
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Your current organization role does not permit this run operation.",
		});
	}
}

export async function listAgentRunCommand(
	principal: RunCommandActor,
	raw: unknown,
) {
	const actor = {
		userId: principal.userId,
		organizationId: principal.organizationId,
	};
	await authorize(actor, Permissions.AGENT_READ);
	const input = agentRunListSchema.parse(raw);
	const instance = await resolveRunControlInstance(input.instanceId, actor);
	const deployment = await getOwnedRunDeployment(instance.id, actor);
	if (!deployment) {
		return {
			deployment: null,
			executions: [],
			schedule: null,
			schedulingState: "UNKNOWN" as const,
		};
	}
	type Row = {
		id: string;
		executionId: string;
		deploymentId: string;
		userId: string;
		organizationId: string;
		workflowId: string | null;
		runId: string | null;
		metadata: Prisma.JsonValue;
		status: string;
		queuedAt: Date;
		createdAt: Date;
		completedAt: Date | null;
		duration: number | null;
		error: string | null;
		triggerType: string;
	};
	const rows = await db.$queryRaw<Row[]>(
		Prisma.sql`SELECT id,"executionId","deploymentId","userId","organizationId","workflowId","runId",CASE WHEN metadata ? 'fabricAdmission' THEN jsonb_build_object('fabricAdmission',metadata->'fabricAdmission') ELSE NULL END AS metadata,status::text,"queuedAt","createdAt","completedAt",duration,left(error,1000) AS error,left("triggerType",64) AS "triggerType" FROM agent_deployment_execution WHERE "deploymentId"=${deployment.id} AND "userId"=${actor.userId} AND "organizationId"=${actor.organizationId} ORDER BY "createdAt" DESC,id DESC LIMIT ${input.limit}::integer`,
	);
	const visible = await Promise.all(
		rows.map(async (row) =>
			(await canReadAgentExecution(row.id, {
				...actor,
				scopes: ["agents:read"],
			}))
				? row
				: null,
		),
	);
	let liveChecks = 0;
	const executions = await Promise.all(
		visible
			.flatMap((row) => (row ? [row] : []))
			.map(async (row) => {
				const terminal = [
					"COMPLETED",
					"FAILED",
					"CANCELLED",
					"TIMED_OUT",
				].includes(row.status);
				const native =
					!terminal && liveChecks++ < 5
						? await readNativeExecutionState(row)
						: undefined;
				return {
					id: row.id,
					status:
						native?.status ?? (terminal ? row.status : "UNKNOWN"),
					lastRecordedStatus: row.status,
					queuedAt: row.queuedAt,
					createdAt: row.createdAt,
					completedAt: native?.completedAt ?? row.completedAt,
					duration: native?.durationMs ?? row.duration,
					error: native?.error ?? row.error,
					triggerType: row.triggerType,
				};
			}),
	);
	const scheduling = await readManagedRunSchedule(deployment.id, actor);
	await resolveRunControlInstance(instance.id, actor);
	const allowed = await Promise.all(
		executions.map((execution) =>
			canReadAgentExecution(execution.id, {
				...actor,
				scopes: ["agents:read"],
			}),
		),
	);
	return {
		deployment: { id: deployment.id, status: deployment.status },
		executions: executions.filter((_, index) => allowed[index]),
		...scheduling,
	};
}

export async function getAgentRunCommand(
	principal: RunCommandActor,
	raw: unknown,
) {
	const actor = {
		userId: principal.userId,
		organizationId: principal.organizationId,
	};
	await authorize(actor, Permissions.AGENT_READ);
	const input = agentRunIdentitySchema.parse(raw);
	const execution = await getExecution(input.executionId, {
		...actor,
		scopes: ["agents:read"],
	});
	if (!execution) {
		throw new ORPCError("NOT_FOUND", {
			message: "Execution not found or access denied",
		});
	}
	return execution;
}

export async function cancelAgentRunCommand(
	principal: RunCommandActor,
	raw: unknown,
	audit: RunCommandAudit,
) {
	const actor = {
		userId: principal.userId,
		organizationId: principal.organizationId,
	};
	await authorize(actor, Permissions.AGENT_EXECUTE);
	const input = agentRunIdentitySchema.parse(raw);
	const reader = { ...actor, scopes: ["agents:read"] };
	const execution = await getExecution(input.executionId, reader);
	if (!execution) {
		throw new ORPCError("NOT_FOUND", {
			message: "Execution not found or access denied",
		});
	}
	if (
		["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(
			execution.status,
		)
	) {
		return {
			requested: false,
			executionId: input.executionId,
			status: execution.status,
		};
	}
	if (
		!execution.nativeStateAvailable ||
		!execution.workflowId ||
		!execution.runId
	) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message:
				"The current run identity cannot be confirmed. Refresh its status before requesting cancellation.",
		});
	}
	const row = await db.agentDeploymentExecution.findFirst({
		where: { id: input.executionId, ...actor },
		select: {
			id: true,
			executionId: true,
			userId: true,
			organizationId: true,
			metadata: true,
			deployment: {
				select: {
					instanceId: true,
					userId: true,
					organizationId: true,
				},
			},
			workflowId: true,
			runId: true,
		},
	});
	if (
		!row ||
		row.deployment.userId !== actor.userId ||
		row.deployment.organizationId !== actor.organizationId ||
		row.workflowId !== execution.workflowId
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Execution not found or access denied",
		});
	}
	const scoped = await getAgentTemplateInstanceForExecution({
		instanceId: row.deployment.instanceId,
		...actor,
	});
	if (!scoped) {
		throw new ORPCError("FORBIDDEN", {
			message: "Current agent execution permission is required.",
		});
	}
	// Re-read native identity from the freshly loaded owned row. The shared verifier
	// may recover a stale projection only through the exact persisted admission memo;
	// a matching workflow ID alone never authorizes a different run.
	const currentNative = await readNativeExecutionState(row);
	if (
		currentNative.nativeReadStatus !== "AVAILABLE" ||
		currentNative.runId !== execution.runId
	) {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Execution identity or admission changed. Refresh its status before requesting cancellation.",
		});
	}

	const client = await getTemporalClient();
	const handle = client.workflow.getHandle(
		execution.workflowId,
		execution.runId,
		{ followRuns: false },
	);
	const description = await handle.describe();
	if (
		description.runId !== execution.runId ||
		![
			"deploymentExecutionWorkflow",
			"nativeDeploymentExecutionWorkflow",
			"goalOrientedAgentWorkflow",
			"nativeGoalOrientedAgentWorkflow",
		].includes(description.type) ||
		!(await canReadAgentExecution(input.executionId, reader))
	) {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Execution identity or current access changed. Refresh its status.",
		});
	}
	if (
		!(await getAgentTemplateInstanceForExecution({
			instanceId: row.deployment.instanceId,
			...actor,
		}))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "Current agent execution permission is required.",
		});
	}
	await handle.signal(
		description.type.includes("Goal") ||
			description.type === "goalOrientedAgentWorkflow"
			? "cancel"
			: "cancelExecution",
	);
	await audit({
		action: "org.agent_execution.cancel_requested",
		organizationId: actor.organizationId,
		resource: { type: "agent_execution", id: input.executionId },
		metadata: {
			workflowId: execution.workflowId,
			runId: execution.runId,
		},
	});
	return {
		requested: true,
		executionId: input.executionId,
		status: execution.status,
	};
}

export async function scheduleAgentRunCommand(
	principal: RunCommandActor,
	raw: unknown,
	audit: RunCommandAudit,
) {
	const actor = {
		userId: principal.userId,
		organizationId: principal.organizationId,
	};
	await authorize(actor, Permissions.AGENT_EXECUTE, Permissions.AGENT_UPDATE);
	const input = agentRunScheduleSchema.parse(raw);
	const instance = await resolveRunControlInstance(
		input.instanceId,
		actor,
		true,
		{ requireRunnable: input.enabled },
	);
	if (
		principal.external &&
		input.enabled &&
		!(await db.agentTemplateInstance.findFirst({
			where: {
				id: instance.id,
				userId: actor.userId,
				organizationId: actor.organizationId,
				isApiExposed: true,
			},
			select: { id: true },
		}))
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Enable API access for this agent before scheduling it externally.",
		});
	}

	buildManagedRunCalendar(input.cronExpression, input.timezone);
	const deployment =
		principal.external && !input.enabled
			? await getOwnedRunDeployment(instance.id, actor)
			: await getOrCreateDeployment(instance.id, instance.name, actor);
	if (!deployment) {
		throw new ORPCError("NOT_FOUND", {
			message: "There is no existing schedule to pause.",
		});
	}
	if (
		deployment.userId !== actor.userId ||
		deployment.organizationId !== actor.organizationId
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Deployment not found or access denied",
		});
	}
	if (input.enabled && deployment.status !== "ACTIVE") {
		throw new ORPCError("CONFLICT", {
			message:
				"This deployment is not active. Resume or inspect it before changing its schedule.",
		});
	}
	const result = await saveManagedRunSchedule({
		...actor,
		deploymentId: deployment.id,
		cronExpression: input.cronExpression,
		timezone: input.timezone,
		input: input.input,
		enabled: input.enabled,
		requireExisting: principal.external && !input.enabled,
		onSaved: async () => {
			await audit({
				action: "org.agent_schedule.updated",
				organizationId: actor.organizationId,
				resource: { type: "agent_schedule", id: deployment.id },
				metadata: {
					instanceId: instance.id,
					deploymentId: deployment.id,
					enabled: input.enabled,
					cronExpression: input.cronExpression,
					timezone: input.timezone,
				},
			});
		},
	});
	return result;
}

export async function readAgentRunScheduleCommand(
	principal: RunCommandActor,
	raw: unknown,
) {
	const actor = {
		userId: principal.userId,
		organizationId: principal.organizationId,
	};
	await authorize(actor, Permissions.AGENT_READ);
	const input = agentRunInstanceSchema.parse(raw);
	const instance = await resolveRunControlInstance(input.instanceId, actor);
	const deployment = await getOwnedRunDeployment(instance.id, actor);
	const result = deployment
		? await readManagedRunSchedule(deployment.id, actor)
		: { schedule: null, schedulingState: "UNKNOWN" as const };
	await resolveRunControlInstance(instance.id, actor);
	return result;
}

/** Shared live organization permission check for additive owner control queries. */
export { authorize as authorizeRunCommand };
