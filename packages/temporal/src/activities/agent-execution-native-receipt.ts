import { isDeepStrictEqual } from "node:util";
import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import {
	attachAgentExecutionReceipt,
	db,
	getAgentTemplateInstanceForExecution,
	getProjectAccessContext,
	isProjectSoftDeleted,
	readAgentExecutionAdmission,
} from "@repo/database";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { NativeAgentAdmission } from "../lib/agent-execution-native-protocol";
import { withHeartbeatTicker } from "./lib/activity-liveness";

export interface RegisterNativeAgentReceiptInput {
	nativeAdmission: NativeAgentAdmission;
	executionId: string;
	deploymentId: string;
	instanceId: string;
	userId: string;
	organizationId?: string;
	workflowId: string;
	runId: string;
	workflowType: string;
	/** Copied from workflowInfo(), never from the workflow request payload. */
	admissionMemo: unknown;
}
const id = z.string().min(1).max(200);
const markerSchema = z.strictObject({
	version: z.literal(1),
	executionRowId: id,
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const memoSchema = z.strictObject({
	version: z.literal(1),
	executionId: id,
	userId: id,
	organizationId: id,
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
function refuse(): never {
	throw ApplicationFailure.nonRetryable(
		"Native agent execution identity or current permission could not be verified",
		"NATIVE_AGENT_RECEIPT_REFUSED",
	);
}

async function validateNativeIdentity(input: RegisterNativeAgentReceiptInput) {
	const marker = markerSchema.safeParse(input.nativeAdmission);
	const memo = memoSchema.safeParse(input.admissionMemo);
	const actual = Context.current().info;
	const actualExecution = actual.workflowExecution;
	if (
		!marker.success ||
		!memo.success ||
		!input.organizationId ||
		!actualExecution ||
		actualExecution.workflowId !== input.workflowId ||
		actualExecution.runId !== input.runId ||
		actual.workflowType !== input.workflowType ||
		![
			"nativeDeploymentExecutionWorkflow",
			"nativeGoalOrientedAgentWorkflow",
		].includes(input.workflowType) ||
		memo.data.executionId !== marker.data.executionRowId ||
		memo.data.requestHash !== marker.data.requestHash ||
		memo.data.userId !== input.userId ||
		memo.data.organizationId !== input.organizationId
	) {
		refuse();
	}
	const row = await db.agentDeploymentExecution.findFirst({
		where: {
			id: marker.data.executionRowId,
			executionId: input.executionId,
			deploymentId: input.deploymentId,
			userId: input.userId,
			organizationId: input.organizationId,
			workflowId: input.workflowId,
		},
		include: {
			deployment: {
				select: {
					id: true,
					status: true,
					instanceId: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
	const admission = row ? readAgentExecutionAdmission(row) : null;
	if (
		!row ||
		!row.organizationId ||
		!admission ||
		!("receiptOwner" in admission) ||
		admission.receiptOwner !== "workflow" ||
		admission.requestHash !== marker.data.requestHash ||
		admission.dispatch.workflowType !== input.workflowType ||
		admission.dispatch.instanceId !== input.instanceId ||
		row.deployment.instanceId !== input.instanceId ||
		row.deployment.userId !== input.userId ||
		row.deployment.organizationId !== input.organizationId ||
		(row.runId !== null && row.runId !== input.runId)
	) {
		refuse();
	}
	return {
		row,
		actualExecution,
		admission,
		organizationId: row.organizationId,
	};
}

async function validateNativeStart(input: RegisterNativeAgentReceiptInput) {
	const validated = await validateNativeIdentity(input);
	const { row, admission, organizationId } = validated;
	if (
		!["PENDING", "RUNNING"].includes(row.status) ||
		row.deployment.status === "TERMINATED"
	) {
		refuse();
	}
	const scoped = await getAgentTemplateInstanceForExecution({
		instanceId: input.instanceId,
		userId: input.userId,
		organizationId,
	});
	if (
		!scoped ||
		scoped.projectId !== admission.dispatch.projectId ||
		!getAgentImplementationAvailability(scoped.instance.customInstructions)
			.available
	) {
		refuse();
	}
	if (admission.dispatch.projectId) {
		const project = await getProjectAccessContext(
			admission.dispatch.projectId,
			input.userId,
		);
		if (
			project?.organizationId !== organizationId ||
			(await isProjectSoftDeleted(admission.dispatch.projectId))
		) {
			refuse();
		}
	}
	return validated;
}

/** Durable first step. Storage outages retry before any model or tool work. */
export async function registerNativeAgentExecutionReceipt(
	input: RegisterNativeAgentReceiptInput,
): Promise<void> {
	return withHeartbeatTicker(
		async () => {
			const { row, actualExecution, organizationId } =
				await validateNativeStart(input);
			await attachAgentExecutionReceipt({
				id: row.id,
				userId: input.userId,
				organizationId,
				workflowId: actualExecution.workflowId,
				runId: actualExecution.runId,
			});
			const scope = {
				id: row.id,
				executionId: input.executionId,
				deploymentId: input.deploymentId,
				userId: input.userId,
				organizationId,
				workflowId: actualExecution.workflowId,
				runId: actualExecution.runId,
			};
			await db.agentDeploymentExecution.updateMany({
				where: { ...scope, status: "PENDING" },
				data: { status: "RUNNING", startedAt: new Date() },
			});
			if (
				!(await db.agentDeploymentExecution.findFirst({
					where: { ...scope, status: "RUNNING" },
					select: { id: true },
				}))
			) {
				refuse();
			}
		},
		{ intervalMs: 5_000, details: "native-agent-receipt" },
	);
}

export interface CompleteNativeAgentExecutionInput {
	receipt: RegisterNativeAgentReceiptInput;
	status: "COMPLETED" | "FAILED" | "CANCELLED";
	output: Record<string, unknown>;
	error?: string;
	completedAt: string;
	durationMs: number;
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};
}

/** Projection only: no effects, allowance increments or model/tool retries. */
export async function completeNativeAgentExecution(
	input: CompleteNativeAgentExecutionInput,
): Promise<void> {
	return withHeartbeatTicker(
		async () => {
			const { row, actualExecution, organizationId } =
				await validateNativeIdentity(input.receipt);
			if (row.runId !== actualExecution.runId) {
				refuse();
			}
			const output = z.record(z.string(), z.json()).parse(input.output);
			const currentTerminal = !["PENDING", "RUNNING"].includes(
				row.status,
			);
			if (currentTerminal) {
				if (
					row.status !== input.status ||
					!isDeepStrictEqual(row.output, output) ||
					(row.error ?? undefined) !== input.error
				) {
					refuse();
				}
				return;
			}
			const changed = await db.agentDeploymentExecution.updateMany({
				where: {
					id: row.id,
					executionId: input.receipt.executionId,
					deploymentId: input.receipt.deploymentId,
					userId: input.receipt.userId,
					organizationId,
					workflowId: actualExecution.workflowId,
					runId: actualExecution.runId,
					status: { in: ["PENDING", "RUNNING"] },
				},
				data: {
					status: input.status,
					output,
					error: input.error,
					completedAt: new Date(input.completedAt),
					duration: input.durationMs,
					inputTokens: input.tokenUsage?.inputTokens,
					outputTokens: input.tokenUsage?.outputTokens,
					totalCost: input.tokenUsage?.totalCost,
				},
			});
			if (changed.count !== 1) {
				// A racing cancel/terminal write wins; re-read under the same fences on retry.
				throw new Error(
					"Native execution projection changed concurrently",
				);
			}
		},
		{ intervalMs: 5_000, details: "native-agent-terminal-projection" },
	);
}
