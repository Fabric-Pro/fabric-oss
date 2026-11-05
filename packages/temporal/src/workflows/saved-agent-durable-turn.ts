import type { ToolResultPart } from "@repo/ai";
import { ActivityFailure, ApplicationFailure } from "@temporalio/common";
import { patched, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { ModelMessage } from "ai";
import type * as stepActivities from "../activities/agent-execution-core/durable-steps";
import type {
	ExecuteAgentTurnInput,
	ExecuteAgentTurnResult,
	ToolCallRecord,
} from "../activities/agent-execution-core/types";
import { measureSerializedBytes } from "../lib/payload-size-guard";
import {
	SAVED_AGENT_STEP_BYTES,
	savedAgentEffectId,
} from "../lib/saved-agent-step-contract";

export const SAVED_AGENT_DURABLE_STEPS_PATCH = "saved-agent-durable-steps-v1";
export const SAVED_AGENT_CANCELLATION_PATCH =
	"saved-agent-durable-cancellation-v1";
export type DurableSavedAgentTurnResult = ExecuteAgentTurnResult & {
	cancelled?: true;
};
/** Model choices can retry before commitment; they never dispatch tool effects. */
const modelActivities = proxyActivities<typeof stepActivities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "5 minutes",
	retry: { maximumAttempts: 2, initialInterval: "1s" },
});

/**
 * Existing saved-agent semantics, orchestrated one decision/effect at a time.
 * Call only from a patched workflow branch. All decisions/results acknowledged
 * by Temporal stay in history; no whole LLM/tool loop runs in an Activity.
 */
export async function executeDurableSavedAgentTurn(
	input: ExecuteAgentTurnInput,
	options?: {
		modelTimeoutMs?: number;
		toolTimeoutMs?: number;
		effectScope?: string;
		/** Workflow-local signal state; never serialized into an Activity input. */
		isCancelled?: () => boolean;
	},
): Promise<DurableSavedAgentTurnResult> {
	const limit = Math.min(Math.max(input.maxIterations ?? 10, 1), 10);
	const continuationMessages: ModelMessage[] = [];
	const toolCalls: ToolCallRecord[] = [];
	let tokenUsage: ExecuteAgentTurnResult["tokenUsage"];
	let response = "";
	const cancellationEnabled =
		!!options?.isCancelled && patched(SAVED_AGENT_CANCELLATION_PATCH);
	const isCancelled = () =>
		cancellationEnabled && options?.isCancelled?.() === true;
	const cancelledResult = (): DurableSavedAgentTurnResult => ({
		success: false,
		cancelled: true,
		response,
		toolCalls,
		tokenUsage,
		error: "Execution cancelled at a safe step boundary",
	});
	for (let stepIndex = 0; stepIndex < limit; stepIndex++) {
		if (isCancelled()) return cancelledResult();
		if (
			measureSerializedBytes({ ...input, continuationMessages }) >
			SAVED_AGENT_STEP_BYTES
		)
			return {
				success: false,
				response,
				toolCalls,
				tokenUsage,
				error: "The accumulated agent context exceeds the durable step budget. Inspect the completed steps before a new run.",
			};
		const model = options?.modelTimeoutMs
			? proxyActivities<typeof stepActivities>({
					startToCloseTimeout: options.modelTimeoutMs,
					retry: { maximumAttempts: 2, initialInterval: "1s" },
				})
			: modelActivities;
		let decision: ExecuteAgentTurnResult;
		try {
			decision = await model.executeSavedAgentModelStep({
				...input,
				stepIndex,
				continuationMessages: [...continuationMessages],
			});
		} catch {
			if (isCancelled()) return cancelledResult();
			const error =
				"The model step could not be completed. Recorded tool effects were retained; inspect the execution before starting a new attempt.";
			return {
				success: false,
				response: error,
				error,
				toolCalls,
				tokenUsage,
			};
		}
		response = decision.response;
		if (decision.tokenUsage) {
			tokenUsage = {
				inputTokens:
					(tokenUsage?.inputTokens ?? 0) +
					decision.tokenUsage.inputTokens,
				outputTokens:
					(tokenUsage?.outputTokens ?? 0) +
					decision.tokenUsage.outputTokens,
				...(decision.tokenUsage.totalCost !== undefined
					? {
							totalCost:
								(tokenUsage?.totalCost ?? 0) +
								decision.tokenUsage.totalCost,
						}
					: {}),
			};
		}
		if (isCancelled()) return cancelledResult();
		if (!decision.success || !decision.modelStep)
			return { ...decision, toolCalls, tokenUsage };
		continuationMessages.push(...decision.modelStep.messages);
		if (decision.modelStep.toolCalls.length === 0)
			return {
				success: true,
				response: response || "Task completed.",
				toolCalls,
				tokenUsage,
			};
		// Execute a model's parallel decision set in stable model order. Bound to
		// eight by the producer; no effect is launched after a sibling is uncertain.
		for (const call of decision.modelStep.toolCalls) {
			if (isCancelled()) return cancelledResult();
			const effectId = savedAgentEffectId(
				workflowInfo().workflowId,
				stepIndex,
				call.id,
				options?.effectScope,
			);
			const effects = proxyActivities<typeof stepActivities>({
				activityId: effectId,
				startToCloseTimeout: options?.toolTimeoutMs ?? "5 minutes",
				retry: { maximumAttempts: 1 },
			});
			let completed: Awaited<
				ReturnType<typeof stepActivities.executeSavedAgentToolStep>
			>;
			try {
				completed = await effects.executeSavedAgentToolStep({
					...input,
					stepIndex,
					decision: call,
					effectId,
					effectScope: options?.effectScope,
				});
			} catch (failure) {
				const cause =
					failure instanceof ActivityFailure
						? failure.cause
						: failure;
				const refused =
					cause instanceof ApplicationFailure &&
					[
						"SAVED_AGENT_TOOL_REFUSED",
						"SAVED_AGENT_STEP_FORBIDDEN",
						"SAVED_AGENT_TOOL_UNAVAILABLE",
						"SAVED_AGENT_MODEL_INVALID_DECISION",
						"SAVED_AGENT_STEP_TOO_LARGE",
					].includes(cause.type ?? "");
				const error = refused
					? "The tool was refused before dispatch. Review its current definition, arguments or permissions before a new attempt."
					: "Tool execution was not acknowledged. Its effect may have completed; inspect the execution before starting any new attempt.";
				toolCalls.push({
					id: call.id,
					name: call.name,
					args: call.args,
					status: refused ? "error" : "pending",
					durationMs: 0,
					result: {
						error,
						inspectionRequired: !refused,
						effectId,
						...(refused ? { dispatchState: "not_started" } : {}),
					},
				});
				if (isCancelled()) return cancelledResult();
				return {
					success: false,
					response: error,
					error,
					toolCalls,
					tokenUsage,
				};
			}
			toolCalls.push(completed);
			if (isCancelled()) return cancelledResult();
			if (completed.inspectionRequired) {
				const error =
					"A tool step requires inspection before any new attempt. Review its recorded result and current external state.";
				return {
					success: false,
					response: error,
					error,
					toolCalls,
					tokenUsage,
				};
			}
			continuationMessages.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: call.id,
						toolName: call.name,
						output: {
							type: "json",
							value: completed.result as Extract<
								ToolResultPart["output"],
								{ type: "json" }
							>["value"],
						},
					},
				],
			});
		}
	}
	return {
		success: true,
		response: response || "Task completed.",
		toolCalls,
		tokenUsage,
	};
}
