import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../../client";
import type { AgentDeploymentExecution, Prisma } from "../../generated/client";
import { type AuditActor, recordAuditTx } from "../audit-log";

const imageSchema = z
	.object({
		storagePath: z.string().min(1).max(2000),
		mimeType: z.string().min(1).max(200),
		name: z.string().max(500),
	})
	.strict();
const requestSchema = z
	.object({
		input: z.record(z.string().max(200), z.json()),
		priority: z.union([
			z.literal(1),
			z.literal(5),
			z.literal(8),
			z.literal(10),
		]),
		imageRefs: z.array(imageSchema).max(20),
	})
	.strict();
const dispatchSchema = z.discriminatedUnion("workflowType", [
	z
		.object({
			instanceId: z.string().min(1).max(200),
			projectId: z.string().min(1).max(200).optional(),
			workflowType: z.enum([
				"deploymentExecutionWorkflow",
				"nativeDeploymentExecutionWorkflow",
			]),
		})
		.strict(),
	z
		.object({
			instanceId: z.string().min(1).max(200),
			projectId: z.string().min(1).max(200).optional(),
			workflowType: z.enum([
				"goalOrientedAgentWorkflow",
				"nativeGoalOrientedAgentWorkflow",
			]),
			goal: z.string().min(1).max(20000),
			maxIterations: z.number().int().positive().max(1000),
		})
		.strict(),
]);
const storedAdmissionSchema = z
	.object({
		version: z.literal(1),
		receiptOwner: z.literal("workflow").optional(),
		executionCountReserved: z.literal(true).optional(),
		requestHash: z.string().regex(/^[a-f0-9]{64}$/),
		dispatch: dispatchSchema,
		imageRefs: z.array(imageSchema).max(20),
	})
	.strict();
const keySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);
export function validateAgentExecutionRequestKey(key: unknown) {
	if (key !== undefined && !keySchema.safeParse(key).success) {
		throw new AgentExecutionAdmissionError(
			"INVALID_EXECUTION_REQUEST",
			"A valid request key is required",
		);
	}
}

export class AgentExecutionAdmissionError extends Error {
	constructor(
		public readonly code:
			| "INVALID_EXECUTION_REQUEST"
			| "IDEMPOTENCY_CONFLICT"
			| "EXECUTION_QUOTA_EXCEEDED",
		message: string,
	) {
		super(message);
	}
}
function canonical(value: unknown, depth = 0): Prisma.InputJsonValue | null {
	if (depth > 20) {
		throw new AgentExecutionAdmissionError(
			"INVALID_EXECUTION_REQUEST",
			"Execution input is too deeply nested",
		);
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (Array.isArray(value) && value.length <= 1000) {
		return value.map((item) => canonical(item, depth + 1));
	}
	if (
		value &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		const entries = Object.entries(value);
		if (entries.length <= 1000) {
			return Object.fromEntries(
				entries
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, item]) => [key, canonical(item, depth + 1)]),
			);
		}
	}
	throw new AgentExecutionAdmissionError(
		"INVALID_EXECUTION_REQUEST",
		"Execution input must be bounded JSON",
	);
}
export function normalizeAgentExecutionRequest(input: {
	input: Record<string, unknown>;
	priority: number;
	imageRefs?: Array<{ storagePath: string; mimeType: string; name: string }>;
}) {
	const normalized = canonical({
		input: input.input,
		priority: input.priority,
		imageRefs: input.imageRefs ?? [],
	});
	const serialized = JSON.stringify(normalized);
	if (Buffer.byteLength(serialized, "utf8") > 65_536) {
		throw new AgentExecutionAdmissionError(
			"INVALID_EXECUTION_REQUEST",
			"Execution request exceeds 64 KB",
		);
	}
	const parsed = requestSchema.safeParse(normalized);
	if (!parsed.success) {
		throw new AgentExecutionAdmissionError(
			"INVALID_EXECUTION_REQUEST",
			"Invalid execution request",
		);
	}
	return {
		value: parsed.data,
		hash: createHash("sha256").update(serialized).digest("hex"),
	};
}
export function agentExecutionAdmissionId(
	actor: { organizationId: string; userId: string; deploymentId: string },
	key: string,
) {
	if (
		!actor.organizationId ||
		!actor.userId ||
		!actor.deploymentId ||
		!/^[\x21-\x7e]{1,200}$/.test(key)
	) {
		throw new AgentExecutionAdmissionError(
			"INVALID_EXECUTION_REQUEST",
			"A valid organization and request key are required",
		);
	}
	return `agent-request-${createHash("sha256")
		.update(
			JSON.stringify([
				actor.organizationId,
				actor.userId,
				actor.deploymentId,
				key,
			]),
		)
		.digest("hex")}`;
}
export type AgentExecutionDispatch = z.infer<typeof dispatchSchema>;
interface AdmissionInput {
	organizationId: string;
	userId: string;
	deploymentId: string;
	idempotencyKey?: string;
	request: ReturnType<typeof normalizeAgentExecutionRequest>;
	actor?: AuditActor;
	correlationId?: string;
	/** Trusted server entrypoint classification, never accepted from invocation input. */
	triggerType?: "API" | "MANUAL" | "SCHEDULE";
	triggerId?: string;
	dispatch: AgentExecutionDispatch;
}
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
export function readAgentExecutionAdmission(
	row: Pick<AgentDeploymentExecution, "metadata">,
) {
	const parsed = storedAdmissionSchema.safeParse(
		object(row.metadata).fabricAdmission,
	);
	return parsed.success ? parsed.data : null;
}
function validateAdmissionScope(input: AdmissionInput) {
	if (!input.organizationId || !input.userId || !input.deploymentId) {
		throw new AgentExecutionAdmissionError(
			"INVALID_EXECUTION_REQUEST",
			"An organization, actor and deployment are required",
		);
	}
	validateAgentExecutionRequestKey(input.idempotencyKey);
	if (
		normalizeAgentExecutionRequest(input.request.value).hash !==
		input.request.hash
	) {
		throw new AgentExecutionAdmissionError(
			"INVALID_EXECUTION_REQUEST",
			"Invalid normalized request",
		);
	}
}
function assertSameRequest(
	row: AgentDeploymentExecution,
	input: AdmissionInput,
) {
	if (
		row.organizationId !== input.organizationId ||
		row.userId !== input.userId ||
		row.deploymentId !== input.deploymentId
	) {
		throw new AgentExecutionAdmissionError(
			"IDEMPOTENCY_CONFLICT",
			"Request key conflicts with an existing execution",
		);
	}
	const admission = readAgentExecutionAdmission(row);
	const hash =
		admission?.requestHash ??
		normalizeAgentExecutionRequest({
			input: object(row.input),
			priority: row.priority,
		}).hash;
	if (hash !== input.request.hash) {
		throw new AgentExecutionAdmissionError(
			"IDEMPOTENCY_CONFLICT",
			"This request key was already used with different input",
		);
	}
}
/** Read before quota/engine work, including legacy keyed rows; never creates a second occurrence. */
export async function findAgentExecutionAdmission(input: AdmissionInput) {
	validateAdmissionScope(input);
	if (!input.idempotencyKey) {
		return null;
	}
	const id = agentExecutionAdmissionId(input, input.idempotencyKey);
	const row =
		(await db.agentDeploymentExecution.findUnique({ where: { id } })) ??
		(await db.agentDeploymentExecution.findFirst({
			where: {
				deploymentId: input.deploymentId,
				userId: input.userId,
				organizationId: input.organizationId,
				metadata: {
					path: ["idempotencyKey"],
					equals: input.idempotencyKey,
				},
			},
		}));
	if (row) {
		assertSameRequest(row, input);
	}
	return row;
}
/** Existing execution storage is the intent/receipt. Unique PK admission also survives concurrent retries. */
export async function admitAgentDeploymentExecution(input: AdmissionInput) {
	const existing = await findAgentExecutionAdmission(input);
	if (existing) {
		return { execution: existing, reused: true };
	}
	const id = input.idempotencyKey
		? agentExecutionAdmissionId(input, input.idempotencyKey)
		: `agent-request-${randomUUID()}`;
	const workflowId = `deployment-exec-${id}`;
	let row: AgentDeploymentExecution;
	try {
		row = await db.$transaction(async (tx) => {
			const deployment = await tx.agentDeployment.findFirst({
				where: {
					id: input.deploymentId,
					userId: input.userId,
					organizationId: input.organizationId,
					instanceId: input.dispatch.instanceId,
					status: "ACTIVE",
				},
				select: { id: true },
			});
			if (!deployment) {
				throw new AgentExecutionAdmissionError(
					"INVALID_EXECUTION_REQUEST",
					"Deployment not found or access denied",
				);
			}
			const parsedDispatch = dispatchSchema.safeParse(input.dispatch);
			if (
				!parsedDispatch.success ||
				![
					"nativeDeploymentExecutionWorkflow",
					"nativeGoalOrientedAgentWorkflow",
				].includes(parsedDispatch.data.workflowType)
			) {
				throw new AgentExecutionAdmissionError(
					"INVALID_EXECUTION_REQUEST",
					"Unsupported agent execution configuration",
				);
			}
			const created = await tx.agentDeploymentExecution.create({
				data: {
					id,
					deploymentId: input.deploymentId,
					userId: input.userId,
					organizationId: input.organizationId,
					executionId: randomUUID(),
					triggerType: input.triggerType ?? "API",
					triggerId: input.triggerId,
					input: input.request.value.input,
					priority: input.request.value.priority,
					status: "PENDING",
					workflowId,
					metadata: {
						fabricAdmission: {
							version: 1,
							receiptOwner: "workflow",
							executionCountReserved: true,
							requestHash: input.request.hash,
							dispatch: canonical(parsedDispatch.data),
							imageRefs: input.request.value.imageRefs,
						},
					},
				},
			});
			const quota = await tx.organizationDeploymentQuota.findUnique({
				where: { organizationId: input.organizationId },
				select: {
					dailyExecutionLimit: true,
					monthlyExecutionLimit: true,
				},
			});
			if (!quota) {
				throw new AgentExecutionAdmissionError(
					"EXECUTION_QUOTA_EXCEEDED",
					"Execution quota is unavailable",
				);
			}
			const reserved = await tx.organizationDeploymentQuota.updateMany({
				where: {
					organizationId: input.organizationId,
					dailyExecutionLimit: quota.dailyExecutionLimit,
					monthlyExecutionLimit: quota.monthlyExecutionLimit,
					dailyExecutionCount: { lt: quota.dailyExecutionLimit },
					monthlyExecutionCount: { lt: quota.monthlyExecutionLimit },
				},
				data: {
					dailyExecutionCount: { increment: 1 },
					monthlyExecutionCount: { increment: 1 },
				},
			});
			if (reserved.count !== 1) {
				throw new AgentExecutionAdmissionError(
					"EXECUTION_QUOTA_EXCEEDED",
					"Execution quota changed or is exhausted",
				);
			}
			await tx.agentDeployment.update({
				where: { id: input.deploymentId },
				data: {
					dailyExecutionCount: { increment: 1 },
					monthlyExecutionCount: { increment: 1 },
				},
			});

			// Count an occurrence exactly once, in the same transaction as its new admission.
			if (input.triggerType === "SCHEDULE") {
				const updated = await tx.agentDeploymentTrigger.updateMany({
					where: {
						id: input.triggerId ?? "",
						deploymentId: input.deploymentId,
						userId: input.userId,
						organizationId: input.organizationId,
						type: "SCHEDULE",
						isActive: true,
					},
					data: {
						lastRunAt: new Date(),
						lastExecutionId: id,
						totalExecutions: { increment: 1 },
					},
				});
				if (updated.count !== 1) {
					throw new AgentExecutionAdmissionError(
						"INVALID_EXECUTION_REQUEST",
						"The active schedule identity could not be verified",
					);
				}
			}
			await recordAuditTx(tx, {
				action: "org.agent_execution.admitted",
				actor: input.actor ?? { type: "system", userId: input.userId },
				organizationId: input.organizationId,
				projectId: input.dispatch.projectId,
				correlationId: input.correlationId,
				resource: { type: "agent_execution", id },
				metadata: {
					deploymentId: input.deploymentId,
					instanceId: input.dispatch.instanceId,
					workflowId,
					keyed: !!input.idempotencyKey,
				},
			});
			return created;
		});
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "P2002"
			)
		) {
			throw error;
		}
		const raced = await db.agentDeploymentExecution.findUnique({
			where: { id },
		});
		if (!raced) {
			throw error;
		}
		assertSameRequest(raced, input);
		return { execution: raced, reused: true };
	}
	return { execution: row, reused: false };
}
/** Attach identity without regressing a fast worker's running/terminal status. */
export async function attachAgentExecutionReceipt(input: {
	id: string;
	userId: string;
	organizationId: string;
	workflowId: string;
	runId: string;
}) {
	if (
		!input.organizationId ||
		!input.userId ||
		!input.workflowId ||
		!input.runId
	) {
		throw new Error("Invalid execution receipt scope");
	}
	await db.agentDeploymentExecution.updateMany({
		where: {
			id: input.id,
			userId: input.userId,
			organizationId: input.organizationId,
			workflowId: input.workflowId,
			runId: null,
		},
		data: { runId: input.runId },
	});
	const row = await db.agentDeploymentExecution.findFirst({
		where: {
			id: input.id,
			userId: input.userId,
			organizationId: input.organizationId,
			workflowId: input.workflowId,
		},
	});
	if (!row || row.runId !== input.runId) {
		throw new Error("Execution receipt could not be confirmed");
	}
	return row;
}
