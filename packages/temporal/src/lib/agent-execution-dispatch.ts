import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import {
	attachAgentExecutionReceipt,
	getAgentTemplateInstanceForExecution,
	getProjectAccessContext,
	isProjectSoftDeleted,
	type Prisma,
	readAgentExecutionAdmission,
} from "@repo/database";
import { getTemporalClient } from "../client";
import { classifyTemporalClientError } from "./temporal-client-errors";

export type AdmittedAgentExecution = {
	id: string;
	executionId: string;
	deploymentId: string;
	userId: string;
	organizationId: string | null;
	input?: Prisma.JsonValue;
	metadata: Prisma.JsonValue;
	workflowId: string | null;
	runId: string | null;
	status: string;
	output?: Prisma.JsonValue;
};
type DispatchOptions = { allowStart?: boolean; observeOnly?: boolean };
type DispatchDependencies = {
	getClient: typeof getTemporalClient;
	decorate?: <T extends object>(options: T) => T;
};
/** Native start/reconnect by business workflow ID. The workflow owns its database projection. */
export async function dispatchAdmittedAgentExecution(
	execution: AdmittedAgentExecution,
	options: DispatchOptions = {},
	dependencies: DispatchDependencies = { getClient: getTemporalClient },
) {
	const admission = readAgentExecutionAdmission(execution);
	if (!execution.organizationId || !execution.workflowId || !admission) {
		return {
			execution,
			confirmed: false,
			recoverable: false,
			reason: "missing_admission" as const,
		};
	}
	const workflowId = execution.workflowId;
	if (
		admission.receiptOwner === "workflow" &&
		![
			"nativeDeploymentExecutionWorkflow",
			"nativeGoalOrientedAgentWorkflow",
		].includes(admission.dispatch.workflowType)
	) {
		return {
			execution,
			confirmed: false,
			recoverable: false,
			reason: "identity_mismatch" as const,
		};
	}
	const scoped = await getAgentTemplateInstanceForExecution({
		instanceId: admission.dispatch.instanceId,
		userId: execution.userId,
		organizationId: execution.organizationId,
	});
	if (
		!scoped ||
		!getAgentImplementationAvailability(scoped.instance.customInstructions)
			.available
	) {
		return { execution, confirmed: false, revoked: true };
	}
	if (admission.dispatch.projectId) {
		const project = await getProjectAccessContext(
			admission.dispatch.projectId,
			execution.userId,
		);
		if (
			project?.organizationId !== execution.organizationId ||
			(await isProjectSoftDeleted(admission.dispatch.projectId))
		) {
			return { execution, confirmed: false, revoked: true };
		}
	}
	if (
		execution.runId ||
		(!options.observeOnly &&
			admission.receiptOwner !== "workflow" &&
			execution.status !== "PENDING")
	) {
		return { execution, confirmed: true };
	}
	if (
		execution.status === "PENDING" &&
		scoped.projectId !== admission.dispatch.projectId
	) {
		return { execution, confirmed: false, revoked: true };
	}
	const memo = {
		version: 1,
		executionId: execution.id,
		organizationId: execution.organizationId,
		userId: execution.userId,
		requestHash: admission.requestHash,
	};
	let failureReason: "temporal_unavailable" | "receipt_persistence_failed" =
		"temporal_unavailable";
	try {
		const client = await dependencies.getClient();
		const decorate =
			dependencies.decorate ?? (<T extends object>(value: T) => value);
		const mayStart =
			!options.observeOnly &&
			options.allowStart !== false &&
			admission.receiptOwner === "workflow" &&
			execution.status === "PENDING";
		if (mayStart) {
			try {
				await client.workflow.start(
					admission.dispatch.workflowType,
					decorate({
						workflowId: execution.workflowId,
						workflowIdReusePolicy: "REJECT_DUPLICATE",
						workflowIdConflictPolicy: "USE_EXISTING",
						taskQueue: "agents",
						memo: { fabricAgentAdmission: memo },
						args: [
							{
								executionId: execution.executionId,
								deploymentId: execution.deploymentId,
								instanceId: admission.dispatch.instanceId,
								userId: execution.userId,
								organizationId: execution.organizationId,
								nativeAdmission: {
									version: 1,
									executionRowId: execution.id,
									requestHash: admission.requestHash,
								},
								input: execution.input ?? {},
								jobType: "external-agent",
								triggerType: "API",
								timeoutMs: 30 * 60 * 1000,
								...(admission.dispatch.workflowType ===
								"nativeGoalOrientedAgentWorkflow"
									? {
											goal: admission.dispatch.goal,
											maxIterations:
												admission.dispatch
													.maxIterations,
										}
									: {}),
								...(admission.imageRefs.length
									? { imageRefs: admission.imageRefs }
									: {}),
							},
						],
					}),
				);
			} catch (error) {
				const kind = classifyTemporalClientError(error);
				if (kind !== "already_started" && kind !== "transient") {
					throw error;
				}
				// Native lookup also resolves a lost start response; no custom retry loop.
			}
		}
		const describe = () => client.workflow.getHandle(workflowId).describe();
		// Permission/database work must not consume the RPC's absolute deadline.
		const description = await client.connection.withDeadline(
			Date.now() + 3_000,
			describe,
		);
		const observed = description.memo?.fabricAgentAdmission;
		if (
			description.type !== admission.dispatch.workflowType ||
			!observed ||
			typeof observed !== "object" ||
			Object.entries(memo).some(
				([key, value]) =>
					(observed as Record<string, unknown>)[key] !== value,
			)
		) {
			return {
				execution,
				confirmed: false,
				recoverable: false,
				reason: "identity_mismatch" as const,
			};
		}
		const runId = description.runId;
		if (!runId) {
			return {
				execution,
				confirmed: false,
				reason: "workflow_unconfirmed" as const,
			};
		}
		if (!options.observeOnly) {
			return { execution: { ...execution, runId }, confirmed: true };
		}
		// Compatibility only for explicitly invoked legacy repair; no normal-path write.
		failureReason = "receipt_persistence_failed";
		const updated = await attachAgentExecutionReceipt({
			id: execution.id,
			userId: execution.userId,
			organizationId: execution.organizationId,
			workflowId: execution.workflowId,
			runId,
		});
		return { execution: updated, confirmed: true };
	} catch (error) {
		// A start, transport, or post-start receipt error does not prove no work ran.
		const missing = classifyTemporalClientError(error) === "not_found";
		const legacy = admission.receiptOwner !== "workflow";
		return {
			execution,
			confirmed: false,
			...(missing && legacy ? { recoverable: false } : {}),
			reason: missing
				? legacy
					? ("legacy_start_unconfirmed" as const)
					: ("workflow_unconfirmed" as const)
				: failureReason,
		};
	}
}
