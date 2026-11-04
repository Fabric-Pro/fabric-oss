import { db } from "../../client";
import type { Prisma } from "../../generated/client";

const candidateSelect = {
	id: true,
	executionId: true,
	deploymentId: true,
	userId: true,
	organizationId: true,
	metadata: true,
	workflowId: true,
	runId: true,
	status: true,
	deployment: {
		select: { instanceId: true, userId: true, organizationId: true },
	},
} satisfies Prisma.AgentDeploymentExecutionSelect;

/** Trusted maintenance discovery only. Each candidate must repeat current actor/project authorization. */
export function listAgentExecutionReceiptCandidates(input: {
	limit: number;
	before: Date;
}) {
	if (
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 25 ||
		!Number.isFinite(input.before.getTime())
	) {
		throw new Error("Invalid receipt recovery bounds");
	}
	return db.agentDeploymentExecution.findMany({
		where: {
			organizationId: { not: null },
			workflowId: { not: null },
			runId: null,
			updatedAt: { lte: input.before },
			metadata: { path: ["fabricAdmission", "version"], equals: 1 },
		},
		select: candidateSelect,
		orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
		take: input.limit,
	});
}

/** CAS preserves concurrent worker metadata/results and rotates inspected rows behind newer candidates. */
export async function claimAgentExecutionReceiptObservation(
	row: Pick<
		Awaited<ReturnType<typeof listAgentExecutionReceiptCandidates>>[number],
		"id" | "userId" | "organizationId" | "metadata" | "status"
	>,
	at: Date,
) {
	if (
		!row.organizationId ||
		!Number.isFinite(at.getTime()) ||
		!row.metadata ||
		Array.isArray(row.metadata) ||
		typeof row.metadata !== "object"
	) {
		return false;
	}
	const result = await db.agentDeploymentExecution.updateMany({
		where: {
			id: row.id,
			userId: row.userId,
			organizationId: row.organizationId,
			runId: null,
			status: row.status,
			metadata: { equals: row.metadata },
		},
		data: {
			metadata: {
				...row.metadata,
				fabricReceiptRecovery: { observedAt: at.toISOString() },
			},
		},
	});
	return result.count === 1;
}
