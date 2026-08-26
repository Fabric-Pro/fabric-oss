/**
 * Execute Agent
 *
 * Triggers execution of an API-exposed agent instance by creating an
 * execution record and starting a Temporal workflow directly.
 * Auto-creates a lightweight deployment if none exists.
 */

import { randomUUID } from "node:crypto";
import {
	checkExecutionQuota,
	createAgentDeployment,
	db,
	Prisma,
	updateDeploymentStatus,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
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
				select: { id: true, userId: true, organizationId: true },
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
	};
}

export async function executeAgent(
	instanceId: string,
	body: ExecuteAgentInput,
	ctx: ExternalApiContext,
) {
	const tenantFilter = ctx.organizationId
		? { organizationId: ctx.organizationId }
		: { userId: ctx.userId, organizationId: null };

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
					},
				},
			},
		}));

	if (!instance) {
		return { error: "Agent not found", status: 404 as const };
	}

	// Get or auto-create deployment
	const deployment =
		instance.deployment ??
		(await getOrCreateDeployment(instance.id, instance.name, ctx));

	// Check execution quota before creating anything
	const quotaCheck = await checkExecutionQuota(
		deployment.id,
		deployment.userId,
		deployment.organizationId ?? undefined,
	);
	if (!quotaCheck.allowed) {
		return {
			error: quotaCheck.reason || "Execution quota exceeded",
			status: 429 as const,
		};
	}

	// Idempotency check + execution creation in a single serializable transaction
	// so two concurrent requests with the same key cannot both see "no existing row"
	// and create duplicate executions.
	const executionId = randomUUID();
	const priority = PRIORITY_MAP[body.priority || "NORMAL"] ?? 5;

	const txResult = await db.$transaction(
		async (tx) => {
			if (body.idempotencyKey) {
				const existing = await tx.agentDeploymentExecution.findFirst({
					where: {
						deploymentId: deployment.id,
						metadata: {
							path: ["idempotencyKey"],
							equals: body.idempotencyKey,
						},
					},
					select: {
						id: true,
						executionId: true,
						status: true,
						output: true,
					},
				});

				if (existing) {
					return {
						idempotent: true as const,
						existing,
					};
				}
			}

			const created = await tx.agentDeploymentExecution.create({
				data: {
					deploymentId: deployment.id,
					executionId,
					userId: deployment.userId,
					organizationId: deployment.organizationId,
					triggerType: "API",
					input: (body.input || {}) as Prisma.InputJsonValue,
					priority,
					status: "PENDING",
					queuedAt: new Date(),
					metadata: {
						apiKeyId: ctx.keyId,
						apiKeyType: ctx.keyType,
						...(body.idempotencyKey
							? { idempotencyKey: body.idempotencyKey }
							: {}),
					} as Prisma.InputJsonValue,
				},
			});

			return { idempotent: false as const, created };
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
	);

	if (txResult.idempotent) {
		return {
			data: {
				executionId: txResult.existing.id,
				deploymentId: deployment.id,
				status: txResult.existing.status,
				output: txResult.existing.output,
				idempotent: true,
			},
			status: 200 as const,
		};
	}

	const execution = txResult.created;

	// Start the execution workflow directly (no supervisor needed)
	const temporalClient = await getTemporalClient();
	const workflowId = `deployment-exec-${execution.id}`;
	const taskQueue = "agents";
	const timeoutMs = 30 * 60 * 1000; // 30 minutes

	const executionMode = instance.executionMode || "single_turn";
	const isGoalOriented = executionMode === "goal_oriented";

	// Start the workflow — separate try/catch so a DB update failure
	// after a successful workflow start doesn't incorrectly mark FAILED.
	try {
		if (isGoalOriented) {
			const goal = instance.goal || "Complete the requested task";
			const maxIterations = instance.maxIterations || 10;

			await temporalClient.workflow.start(
				"goalOrientedAgentWorkflow",
				withCorrelationMemo({
					taskQueue,
					workflowId,
					args: [
						{
							executionId,
							deploymentId: deployment.id,
							instanceId: instance.id,
							userId: deployment.userId,
							organizationId: deployment.organizationId,
							input: body.input || {},
							goal,
							maxIterations,
							triggerType: "API",
							timeoutMs,
							supervisorWorkflowId: undefined,
							imageRefs: body.imageRefs,
						},
					],
				}),
			);
		} else {
			await temporalClient.workflow.start(
				"deploymentExecutionWorkflow",
				withCorrelationMemo({
					taskQueue,
					workflowId,
					args: [
						{
							executionId,
							deploymentId: deployment.id,
							instanceId: instance.id,
							userId: deployment.userId,
							organizationId: deployment.organizationId,
							input: body.input || {},
							triggerType: "API",
							timeoutMs,
							supervisorWorkflowId: undefined,
							imageRefs: body.imageRefs,
						},
					],
				}),
			);
		}
	} catch (err) {
		// Mark as FAILED only if workflow start itself fails
		await db.agentDeploymentExecution.update({
			where: { id: execution.id },
			data: {
				status: "FAILED",
				error:
					err instanceof Error
						? err.message
						: "Failed to start workflow",
				completedAt: new Date(),
			},
		});
		return {
			error: "Failed to start agent execution",
			status: 500 as const,
		};
	}

	// Transition to RUNNING — best-effort; if this fails the workflow
	// is still running and will update the record itself.
	try {
		await db.agentDeploymentExecution.update({
			where: { id: execution.id },
			data: {
				status: "RUNNING",
				startedAt: new Date(),
				workflowId,
			},
		});
	} catch {
		// Non-critical: workflow will update status on its own
	}

	return {
		data: {
			executionId: execution.id,
			status: "RUNNING",
			deploymentId: deployment.id,
			workflowId,
			/** UUID used by the workflow for Redis pub/sub channels */
			workflowExecutionId: executionId,
		},
		status: 202 as const,
	};
}
