import { isDeepStrictEqual } from "node:util";
import { asSchema } from "@repo/ai";
import { runWithDefaultAiJobType } from "@repo/ai/lib/job-context";
import {
	canExecuteOrganizationAgents,
	db,
	getAgentTemplateInstanceForExecution,
	hasPermission,
	hasProjectAccess,
	isProjectSoftDeleted,
	Permissions,
	readAgentExecutionAdmission,
} from "@repo/database";
import { resolveEffectiveProjectPermissions } from "@repo/rag/lib/context-quality/project-access";
import {
	getDispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { Context, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { measureSerializedBytes } from "../../lib/payload-size-guard";
import { publishExecutionEvent } from "../../lib/redis-publisher";
import {
	SAVED_AGENT_STEP_BYTES,
	SAVED_AGENT_TOOL_BYTES,
	savedAgentEffectId,
} from "../../lib/saved-agent-step-contract";
import {
	type AgentToolRuntime,
	isExecutableAgentTool,
	withAgentToolRuntime,
} from "../shared/agent-tool-runtime";
import { executeAgentTurn, isErrorResult } from "./agent-executor";
import type {
	ExecuteAgentTurnInput,
	ExecuteAgentTurnResult,
	ToolCallRecord,
} from "./types";

export interface SavedAgentToolDecision {
	id: string;
	name: string;
	args: Record<string, unknown>;
	source: { configId: string; originalName: string };
}
export type SavedAgentModelStepInput = ExecuteAgentTurnInput & {
	stepIndex: number;
	continuationMessages: ModelMessage[];
};
export type SavedAgentToolStepInput = ExecuteAgentTurnInput & {
	stepIndex: number;
	decision: SavedAgentToolDecision;
	effectId: string;
	effectScope?: string;
};
export type SavedAgentToolStepResult = ToolCallRecord & {
	effectId: string;
	inspectionRequired?: boolean;
};

/** Authorization is current for each step, independent of recorded prompt/configuration. */
async function assertCurrentAuthority(input: ExecuteAgentTurnInput) {
	const { userId, organizationId, agentInstanceId, projectId } = input;
	const info = Context.current().info;
	if (
		!organizationId ||
		!userId ||
		!input.executionId ||
		!agentInstanceId ||
		!info.workflowExecution
	) {
		throw ApplicationFailure.nonRetryable(
			"An authorized organization agent is required.",
			"SAVED_AGENT_STEP_FORBIDDEN",
		);
	}
	const execution = await db.agentDeploymentExecution.findFirst({
		where: { executionId: input.executionId, userId, organizationId },
		select: {
			metadata: true,
			status: true,
			workflowId: true,
			runId: true,
			deployment: {
				select: {
					status: true,
					instanceId: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
	if (
		!execution ||
		execution.deployment.status === "TERMINATED" ||
		!["PENDING", "RUNNING"].includes(execution.status) ||
		execution.workflowId !== info.workflowExecution.workflowId ||
		(execution.runId !== null &&
			execution.runId !== info.workflowExecution.runId) ||
		execution.deployment.instanceId !== agentInstanceId ||
		execution.deployment.userId !== userId ||
		execution.deployment.organizationId !== organizationId
	) {
		throw ApplicationFailure.nonRetryable(
			"The current execution owner or workflow identity is unavailable.",
			"SAVED_AGENT_STEP_FORBIDDEN",
		);
	}
	const admission = readAgentExecutionAdmission(execution);
	if (
		execution.metadata &&
		typeof execution.metadata === "object" &&
		!Array.isArray(execution.metadata) &&
		"fabricAdmission" in execution.metadata &&
		!admission
	) {
		throw ApplicationFailure.nonRetryable(
			"The current execution admission is invalid.",
			"SAVED_AGENT_STEP_FORBIDDEN",
		);
	}
	if (
		admission &&
		(admission.dispatch.instanceId !== agentInstanceId ||
			admission.dispatch.projectId !== projectId ||
			admission.dispatch.workflowType !== info.workflowType ||
			("receiptOwner" in admission &&
				admission.receiptOwner === "workflow" &&
				execution.runId !== info.workflowExecution.runId))
	) {
		throw ApplicationFailure.nonRetryable(
			"The current execution admission does not match this agent step.",
			"SAVED_AGENT_STEP_FORBIDDEN",
		);
	}
	if (
		!(await db.organization.findFirst({
			where: { id: organizationId, deletedAt: null },
			select: { id: true },
		}))
	) {
		throw ApplicationFailure.nonRetryable(
			"The agent's organization is unavailable.",
			"SAVED_AGENT_STEP_FORBIDDEN",
		);
	}
	if (agentInstanceId) {
		const scoped = await getAgentTemplateInstanceForExecution({
			instanceId: agentInstanceId,
			userId,
			organizationId,
		});
		if (
			!scoped ||
			scoped.projectId !== projectId ||
			scoped.instance.status !== "ACTIVE"
		) {
			throw ApplicationFailure.nonRetryable(
				"The saved agent's current execution scope is unavailable.",
				"SAVED_AGENT_STEP_FORBIDDEN",
			);
		}
	} else if (!(await canExecuteOrganizationAgents(userId, organizationId))) {
		throw ApplicationFailure.nonRetryable(
			"The agent's current execution permission is unavailable.",
			"SAVED_AGENT_STEP_FORBIDDEN",
		);
	}
	if (projectId) {
		const access = await resolveEffectiveProjectPermissions(
			projectId,
			userId,
		);
		if (
			!access ||
			access.organizationId !== organizationId ||
			access.organizationDeleted ||
			!hasPermission(access.permissions, Permissions.CONTEXT_READ) ||
			!(await hasProjectAccess(projectId, userId, organizationId)) ||
			(await isProjectSoftDeleted(projectId))
		) {
			throw ApplicationFailure.nonRetryable(
				"The agent's current project context permission is unavailable.",
				"SAVED_AGENT_STEP_FORBIDDEN",
			);
		}
	}
	Context.current().cancellationSignal.throwIfAborted();
}
function bounded(value: unknown, limit: number, label: string) {
	if (measureSerializedBytes(value) > limit)
		throw ApplicationFailure.nonRetryable(
			`${label} exceeds the durable agent step budget.`,
			"SAVED_AGENT_STEP_TOO_LARGE",
		);
}
function validDecision(value: SavedAgentToolDecision) {
	return (
		value &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		value.id.length <= 200 &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		value.name.length <= 200 &&
		value.args !== null &&
		typeof value.args === "object" &&
		!Array.isArray(value.args) &&
		value.source &&
		typeof value.source.configId === "string" &&
		value.source.configId.length > 0 &&
		value.source.configId.length <= 300 &&
		typeof value.source.originalName === "string" &&
		value.source.originalName.length > 0 &&
		value.source.originalName.length <= 200
	);
}

/** One provider decision only. No executable tool callback reaches the model. */
export async function executeSavedAgentModelStep(
	input: SavedAgentModelStepInput,
): Promise<ExecuteAgentTurnResult> {
	await assertCurrentAuthority(input);
	bounded(input, SAVED_AGENT_STEP_BYTES, "Model input");
	// Factory models repeat this gate before every physical provider request,
	// including retries after asynchronous tool/image/model preparation.
	const parentGuard = getDispatchGuard();
	const result = await runWithDispatchGuard(
		{
			key: `saved-agent:${input.executionId}:${input.stepIndex}`,
			assertDispatchable: async () => {
				await parentGuard?.assertDispatchable();
				await assertCurrentAuthority(input);
			},
			abortSignal: () => {
				const parent = parentGuard?.abortSignal();
				return parent
					? AbortSignal.any([
							parent,
							Context.current().cancellationSignal,
						])
					: Context.current().cancellationSignal;
			},
			rethrowIfStopped: (error) => {
				parentGuard?.rethrowIfStopped(error);
				if (
					error instanceof ApplicationFailure &&
					error.type === "SAVED_AGENT_STEP_FORBIDDEN"
				)
					throw error;
			},
			throwIfStopped: () => {
				parentGuard?.throwIfStopped?.();
				Context.current().cancellationSignal.throwIfAborted();
			},
			...(parentGuard?.budget ? { budget: parentGuard.budget } : {}),
		},
		() =>
			runWithDefaultAiJobType("external-agent", () =>
				executeAgentTurn({
					...input,
					durableStep: {
						continuationMessages: input.continuationMessages,
					},
				}),
			),
	);
	await assertCurrentAuthority(input);
	if (!result.success || !result.modelStep)
		throw ApplicationFailure.nonRetryable(
			result.error || "The model step returned no decision.",
			"SAVED_AGENT_MODEL_FAILED",
		);
	if (
		result.modelStep.toolCalls.length > 8 ||
		result.modelStep.toolCalls.some((call) => !validDecision(call)) ||
		new Set(result.modelStep.toolCalls.map((call) => call.id)).size !==
			result.modelStep.toolCalls.length
	) {
		throw ApplicationFailure.nonRetryable(
			"The model returned an invalid or oversized tool decision set.",
			"SAVED_AGENT_MODEL_INVALID_DECISION",
		);
	}
	bounded(result, SAVED_AGENT_STEP_BYTES, "Model decision");
	return result;
}

/**
 * A single isolated effect. Workflow callers MUST use maximumAttempts:1: a
 * missing acknowledgement cannot prove an arbitrary external write did not occur.
 * effectId is passed as toolCallId to adapters that accept execution options;
 * this is correlation, not a claim of provider idempotency.
 */
export async function executeSavedAgentToolStep(
	input: SavedAgentToolStepInput,
): Promise<SavedAgentToolStepResult> {
	const info = Context.current().info;
	if (info.attempt !== 1) {
		throw ApplicationFailure.nonRetryable(
			"This tool Activity has already been attempted. Inspect the external effect before any new attempt.",
			"SAVED_AGENT_TOOL_INSPECTION_REQUIRED",
		);
	}
	if (
		!validDecision(input.decision) ||
		!Number.isInteger(input.stepIndex) ||
		input.stepIndex < 0 ||
		input.stepIndex >= 10 ||
		!info.workflowExecution ||
		(input.effectScope !== undefined &&
			(typeof input.effectScope !== "string" ||
				input.effectScope.length < 1 ||
				input.effectScope.length > 300)) ||
		input.effectId !==
			savedAgentEffectId(
				info.workflowExecution.workflowId,
				input.stepIndex,
				input.decision.id,
				input.effectScope,
			) ||
		info.activityId !== input.effectId
	) {
		throw ApplicationFailure.nonRetryable(
			"The persisted tool effect identity does not match this workflow step.",
			"SAVED_AGENT_MODEL_INVALID_DECISION",
		);
	}
	try {
		await assertCurrentAuthority(input);
	} catch (error) {
		if (error instanceof ApplicationFailure) throw error;
		throw ApplicationFailure.nonRetryable(
			"The tool was not dispatched because its current authorization could not be verified.",
			"SAVED_AGENT_TOOL_REFUSED",
		);
	}
	if (
		!validDecision(input.decision) ||
		!input.effectId ||
		input.effectId.length > 1000
	)
		throw ApplicationFailure.nonRetryable(
			"Invalid persisted tool decision.",
			"SAVED_AGENT_MODEL_INVALID_DECISION",
		);
	bounded(input, SAVED_AGENT_STEP_BYTES, "Tool input");
	const started = Date.now();
	let dispatchStarted = false;
	let record: SavedAgentToolStepResult | undefined;
	const ticker = setInterval(
		() => heartbeat({ phase: "tool", effectId: input.effectId }),
		5000,
	);
	// Delegated agents prepare their own authorized tool maps. Keep the normal
	// runtime/grant/cancellation context, but never inherit the parent selector.
	const invocationRuntime: AgentToolRuntime = {
		invoke: async (invocation) => {
			await assertCurrentAuthority(input);
			const result = await invocation.execute();
			await assertCurrentAuthority(input);
			return result;
		},
		...(input.projectId && input.organizationId
			? {
					projectScope: {
						projectId: input.projectId,
						userId: input.userId,
						organizationId: input.organizationId,
					},
				}
			: {}),
		abortSignal: Context.current().cancellationSignal,
	};
	try {
		const turn = await withAgentToolRuntime(
			{
				...invocationRuntime,
				prepared: async (tools, sources) => {
					await assertCurrentAuthority(input);
					const definition = tools[input.decision.name];
					const selectedSource = sources[input.decision.name];
					if (
						!selectedSource ||
						selectedSource.configId !==
							input.decision.source.configId ||
						selectedSource.originalName !==
							input.decision.source.originalName
					)
						throw ApplicationFailure.nonRetryable(
							"The selected tool source no longer matches the saved model decision.",
							"SAVED_AGENT_TOOL_UNAVAILABLE",
						);
					if (!isExecutableAgentTool(definition))
						throw ApplicationFailure.nonRetryable(
							"The selected tool is no longer available. Inspect the saved decision before continuing.",
							"SAVED_AGENT_TOOL_UNAVAILABLE",
						);
					const schema = asSchema(
						definition.inputSchema as Parameters<
							typeof asSchema
						>[0],
					);
					const checked = schema.validate
						? await schema.validate(input.decision.args)
						: await z
								.fromJSONSchema(
									(await schema.jsonSchema) as Parameters<
										typeof z.fromJSONSchema
									>[0],
								)
								.safeParseAsync(input.decision.args)
								.then((value) =>
									value.success
										? {
												success: true as const,
												value: value.data,
											}
										: { success: false as const },
								);
					if (
						!checked.success ||
						!isDeepStrictEqual(checked.value, input.decision.args)
					)
						throw ApplicationFailure.nonRetryable(
							"The saved tool arguments do not match its current schema.",
							"SAVED_AGENT_MODEL_INVALID_DECISION",
						);
					heartbeat({ phase: "tool", effectId: input.effectId });
					dispatchStarted = true;
					const output = await withAgentToolRuntime(
						invocationRuntime,
						async () =>
							definition.execute(checked.value, {
								toolCallId: input.effectId,
								messages: [],
								abortSignal:
									Context.current().cancellationSignal,
							}),
					);
					await assertCurrentAuthority(input);
					let result = output ?? null;
					let inspectionRequired = false;
					try {
						if (
							measureSerializedBytes(result) >
							SAVED_AGENT_TOOL_BYTES
						)
							inspectionRequired = true;
					} catch {
						inspectionRequired = true;
					}
					if (inspectionRequired)
						result = {
							error: "Tool output omitted because it exceeds the durable step budget or is not serializable. The effect may have completed; inspect it before any new attempt.",
							outputOmitted: true,
						};
					const object =
						typeof result === "object" && result !== null
							? (result as Record<string, unknown>)
							: null;
					const failed =
						inspectionRequired ||
						isErrorResult(result) ||
						object?.isError === true ||
						object?.success === false ||
						Boolean(object?.error) ||
						Boolean(object?.requiresConfirmation) ||
						Boolean(object?.authorityRequired);
					const source = sources[input.decision.name];
					record = {
						id: input.decision.id,
						name: input.decision.name,
						args: input.decision.args,
						serverName:
							source &&
							"serverName" in source &&
							typeof source.serverName === "string"
								? source.serverName
								: undefined,
						result,
						status: failed ? "error" : "success",
						durationMs: Date.now() - started,
						effectId: input.effectId,
						...(failed ? { inspectionRequired: true } : {}),
					};
					if (input.executionId)
						await publishExecutionEvent(input.executionId, {
							event: "execution.tool_call_completed",
							data: {
								toolName: input.decision.name,
								toolCallId: input.decision.id,
								status: record.status,
								effectId: input.effectId,
							},
						});
					return "Tool step recorded.";
				},
			},
			() =>
				runWithDefaultAiJobType("external-agent", () =>
					executeAgentTurn({ ...input, durableStep: undefined }),
				),
		);
		if ((!turn.success || !record) && !dispatchStarted) {
			throw ApplicationFailure.nonRetryable(
				"The tool was refused before dispatch because its current definition, arguments or authority could not be verified.",
				"SAVED_AGENT_TOOL_REFUSED",
			);
		}
		if (!turn.success || !record)
			throw ApplicationFailure.nonRetryable(
				"Tool execution was not acknowledged. Its effect may have completed; inspect it before any new attempt.",
				"SAVED_AGENT_TOOL_INSPECTION_REQUIRED",
				{ effectId: input.effectId },
			);
		bounded(record, SAVED_AGENT_STEP_BYTES, "Tool result");
		return record;
	} finally {
		clearInterval(ticker);
	}
}
