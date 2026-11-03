/**
 * Execute Agent
 *
 * Triggers execution of an API-exposed agent instance by creating an
 * execution record and starting a Temporal workflow directly.
 * Auto-creates a lightweight deployment if none exists.
 */

import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import {
	AgentExecutionAdmissionError,
	type AgentExecutionDispatch,
	admitAgentDeploymentExecution,
	checkExecutionQuota,
	createAgentDeployment,
	db,
	findAgentExecutionAdmission,
	getAgentTemplateInstanceForExecution,
	normalizeAgentExecutionRequest,
	Prisma,
	updateDeploymentStatus,
	validateAgentExecutionRequestKey,
} from "@repo/database";
import { getCorrelationIdFromContext } from "../../../lib/correlation-id";
import { dispatchAdmittedAgentExecution } from "../../agent-deployments/lib/dispatch-execution";
import type { ExternalApiContext } from "../types";

const PRIORITY_MAP: Record<string, number> = {
	LOW: 1,
	NORMAL: 5,
	HIGH: 8,
	CRITICAL: 10,
};

interface ImageRef {
	storagePath: string;
	mimeType: string;
	name: string;
}

interface ExecuteAgentInput {
	input: Record<string, unknown>;
	priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
	idempotencyKey?: string;
	stream?: boolean;
	imageRefs?: ImageRef[];
}

/**
 * Get existing deployment or auto-create a lightweight one for API execution.
 * No supervisor workflow is started — executions run directly.
 */
async function getOrCreateDeployment(
	instanceId: string,
	instanceName: string,
	ctx: ExternalApiContext,
) {
	const existing = await db.agentDeployment.findFirst({
		where: { instanceId },
		select: {
			id: true,
			userId: true,
			organizationId: true,
			status: true,
		},
	});
	if (existing) {
		return existing;
	}

	let deployment: Awaited<ReturnType<typeof createAgentDeployment>>;
	try {
		deployment = await createAgentDeployment({
			instanceId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			name: instanceName,
			slug: `api-${instanceId.slice(-8)}-${Date.now()}`,
		});
	} catch (err) {
		// Another concurrent request already created a deployment for this instance.
		// Catch the unique constraint violation and return the existing row.
		if (
			err instanceof Prisma.PrismaClientKnownRequestError &&
			err.code === "P2002"
		) {
			const raced = await db.agentDeployment.findFirst({
				where: { instanceId },
				select: {
					id: true,
					userId: true,
					organizationId: true,
					status: true,
				},
			});
			if (raced) {
				return raced;
			}
		}
		throw err;
	}

	// Set status to ACTIVE immediately (no supervisor needed)
	await updateDeploymentStatus(deployment.id, "ACTIVE", {
		deployedAt: new Date(),
	});

	return {
		id: deployment.id,
		userId: deployment.userId,
		organizationId: deployment.organizationId,
		status: "ACTIVE" as const,
	};
}

export async function executeAgent(
	instanceId: string,
	body: ExecuteAgentInput,
	ctx: ExternalApiContext,
) {
	if (!ctx.organizationId) {
		return { error: "An organization is required", status: 403 as const };
	}
	let normalizedRequest: ReturnType<typeof normalizeAgentExecutionRequest>;
	try {
		validateAgentExecutionRequestKey(body.idempotencyKey);
		normalizedRequest = normalizeAgentExecutionRequest({
			input: body.input ?? {},
			priority: PRIORITY_MAP[body.priority ?? "NORMAL"] ?? 5,
			imageRefs: body.imageRefs,
		});
	} catch (error) {
		if (error instanceof AgentExecutionAdmissionError) {
			return {
				error: { code: error.code, message: error.message },
				status: 400 as const,
			};
		}
		throw error;
	}
	const tenantFilter = { organizationId: ctx.organizationId };

	// Find the instance with execution mode details.
	// The identifier may be an sId (stable across versions) or a record id.
	// Try sId first since the UI now emits stable identifiers.
	const instance =
		(await db.agentTemplateInstance.findFirst({
			where: {
				sId: instanceId,
				...tenantFilter,
				isApiExposed: true,
				status: "ACTIVE",
			},
			select: {
				id: true,
				name: true,
				executionMode: true,
				goal: true,
				maxIterations: true,
				deployment: {
					select: {
						id: true,
						userId: true,
						organizationId: true,
						status: true,
					},
				},
			},
		})) ??
		(await db.agentTemplateInstance.findFirst({
			where: {
				id: instanceId,
				...tenantFilter,
				isApiExposed: true,
				status: "ACTIVE",
			},
			select: {
				id: true,
				name: true,
				executionMode: true,
				goal: true,
				maxIterations: true,
				deployment: {
					select: {
						id: true,
						userId: true,
						organizationId: true,
						status: true,
					},
				},
			},
		}));

	if (!instance) {
		return { error: "Agent not found", status: 404 as const };
	}

	const scoped = await getAgentTemplateInstanceForExecution({
		instanceId: instance.id,
		userId: ctx.userId,
		organizationId: ctx.organizationId,
	});
	if (
		!scoped ||
		(ctx.boundProjectId && scoped.projectId !== ctx.boundProjectId)
	) {
		return {
			error: "Agent not found or access denied",
			status: 404 as const,
		};
	}
	if (
		!getAgentImplementationAvailability(scoped.instance.customInstructions)
			.available
	) {
		return {
			error: "Agent implementation is unavailable for execution",
			status: 409 as const,
		};
	}

	// The instance author remains the credential owner until a deployment exists.
	// Check before auto-creation so a first caller cannot claim another member's agent.
	if (
		(instance.deployment?.userId ?? scoped.instance.userId) !== ctx.userId
	) {
		return {
			error: "This deployment must be executed by its owner",
			status: 403 as const,
		};
	}

	// Get or auto-create deployment
	const deployment =
		instance.deployment ??
		(await getOrCreateDeployment(instance.id, instance.name, ctx));

	// Deployment tools and credentials belong to its admitting actor. Match the
	// owner-only in-app execution contract rather than borrowing another member's
	// authority through an organization API key.
	if (
		deployment.userId !== ctx.userId ||
		deployment.organizationId !== ctx.organizationId
	) {
		return {
			error: "This deployment must be executed by its owner",
			status: 403 as const,
		};
	}

	try {
		const request = normalizedRequest;
		const target = {
			instanceId: instance.id,
			...(scoped.projectId ? { projectId: scoped.projectId } : {}),
		};
		const dispatch: AgentExecutionDispatch =
			instance.executionMode === "goal_oriented"
				? {
						...target,
						workflowType: "nativeGoalOrientedAgentWorkflow",
						goal: instance.goal || "Complete the requested task",
						maxIterations: instance.maxIterations || 10,
					}
				: {
						...target,
						workflowType: "nativeDeploymentExecutionWorkflow",
					};
		const admission = {
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			deploymentId: deployment.id,
			idempotencyKey: body.idempotencyKey,
			request,
			dispatch,
			actor: {
				type:
					ctx.keyType === "oauth"
						? ("agent" as const)
						: ("api_key" as const),
				userId: ctx.userId,
			},
			correlationId: getCorrelationIdFromContext(),
		};
		let execution = await findAgentExecutionAdmission(admission);
		let reused = !!execution;
		if (!execution) {
			if (deployment.status !== "ACTIVE") {
				return {
					error: "Deployment is not active",
					status: 409 as const,
				};
			}
			const quota = await checkExecutionQuota(
				deployment.id,
				ctx.userId,
				ctx.organizationId,
			);
			if (!quota.allowed) {
				// A concurrent identical request may have reserved the final
				// allowance since our first lookup. Recover its receipt first.
				execution = await findAgentExecutionAdmission(admission);
				if (!execution) {
					return {
						error: quota.reason || "Execution quota exceeded",
						status: 429 as const,
					};
				}
				reused = true;
			}
			if (!execution) {
				const admitted = await admitAgentDeploymentExecution(admission);
				execution = admitted.execution;
				reused = admitted.reused;
			}
		}
		const receipt = await dispatchAdmittedAgentExecution(execution, {
			allowStart: deployment.status === "ACTIVE",
		});
		const row = receipt.execution;
		if (receipt.revoked) {
			return {
				error: "Agent not found or access denied",
				status: 404 as const,
			};
		}
		if (!receipt.confirmed) {
			return {
				error: {
					code: "ADMISSION_UNRESOLVED",
					message:
						receipt.reason === "identity_mismatch"
							? "The existing workflow identity does not match this request. Inspect that execution before submitting separate work."
							: receipt.reason === "legacy_start_unconfirmed"
								? "Fabric cannot confirm this older execution in Temporal. Inspect its existing outcome before submitting separate work."
								: receipt.recoverable === false
									? "This legacy execution has no recoverable admission snapshot. Inspect its existing outcome before submitting a separate run."
									: "Execution admission is unresolved. Retry the same request key to recover this execution; use a new key only for a separate run.",
					data: {
						executionId: row.id,
						deploymentId: row.deploymentId,
						workflowId: row.workflowId,
						retryable:
							!!body.idempotencyKey &&
							receipt.recoverable !== false,
					},
				},
				status: 503 as const,
			};
		}
		return {
			data: {
				executionId: row.id,
				deploymentId: row.deploymentId,
				workflowId: row.workflowId,
				workflowExecutionId: row.executionId,
				runId: row.runId,
				status: row.status,
				admissionStatus: "CONFIRMED" as const,
				idempotent: reused,
				...(row.status === "COMPLETED" ? { output: row.output } : {}),
			},
			status: reused ? (200 as const) : (202 as const),
		};
	} catch (error) {
		if (error instanceof AgentExecutionAdmissionError) {
			return {
				error: { code: error.code, message: error.message },
				status:
					error.code === "IDEMPOTENCY_CONFLICT"
						? (409 as const)
						: error.code === "EXECUTION_QUOTA_EXCEEDED"
							? (429 as const)
							: (400 as const),
			};
		}
		throw error;
	}
}
