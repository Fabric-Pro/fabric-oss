import {
	ActivityCancellationType,
	ActivityFailure,
	ApplicationFailure,
	CancellationScope,
	defineQuery,
	isCancellation,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type { ModelMessage, ToolResultPart } from "ai";
import type * as activities from "../activities/agent-preview";
import type {
	AgentPreviewState,
	AgentPreviewWorkflowInput,
} from "../lib/agent-preview-contracts";
import { measureSerializedBytes } from "../lib/payload-size-guard";

const reads = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "20 seconds",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 2, initialInterval: "1s" },
});
const models = proxyActivities<typeof activities>({
	startToCloseTimeout: "3 minutes",
	heartbeatTimeout: "20 seconds",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 2, initialInterval: "1s" },
});
export const agentPreviewStateQuery =
	defineQuery<AgentPreviewState>("previewState");
/** Preview has its own workflow type; existing saved-agent histories stay unchanged. */
export async function agentDraftPreviewWorkflow(
	input: AgentPreviewWorkflowInput,
): Promise<AgentPreviewState> {
	const state: AgentPreviewState = {
		status: "RUNNING",
		phase: "Preparing selected knowledge and skills",
		toolCalls: [],
		sources: [],
		draftHash: input.draftHash,
	};
	setHandler(agentPreviewStateQuery, () => state);
	try {
		const prepared = await reads.prepareAgentPreview(input);
		state.sources = prepared.sources;
		const continuationMessages: ModelMessage[] = [];
		for (let step = 0; step < input.request.draft.maxIterations; step++) {
			state.phase = "Generating a response";
			const decision = await models.executeAgentPreviewModelStep({
				base: input,
				prepared,
				continuationMessages,
			});
			if (!decision.modelStep) {
				throw new Error("No model decision");
			}
			if (decision.modelStep.toolCalls.length === 0) {
				state.response = decision.response;
				state.status = "COMPLETED";
				state.phase = "Preview complete";
				return state;
			}
			continuationMessages.push(...decision.modelStep.messages);
			for (
				let index = 0;
				index < decision.modelStep.toolCalls.length;
				index++
			) {
				const call = decision.modelStep.toolCalls[index]!;
				state.phase =
					call.name === "preview_read_workspace_document"
						? "Reading a workspace document"
						: call.source.originalName.includes("feature")
							? "Reading project features"
							: call.source.originalName.includes("source")
								? "Reading project context"
								: "Reading project documents";
				const selected = proxyActivities<typeof activities>({
					activityId: `preview-read-${step}-${index}`,
					startToCloseTimeout: "2 minutes",
					heartbeatTimeout: "20 seconds",
					cancellationType:
						ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
					retry: { maximumAttempts: 1 },
				});
				const result = await selected.executeAgentPreviewReadStep({
					base: input,
					prepared,
					decision: call,
				});
				state.toolCalls.push(result.call);
				if (
					result.source &&
					!state.sources.some(
						(x) =>
							x.id === result.source!.id &&
							x.revision === result.source!.revision,
					)
				) {
					state.sources.push(result.source);
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
								value: result.result as Extract<
									ToolResultPart["output"],
									{ type: "json" }
								>["value"],
							},
						},
					],
				});
				if (measureSerializedBytes(continuationMessages) > 128 * 1024) {
					throw ApplicationFailure.nonRetryable(
						"Preview context limit reached",
						"AGENT_PREVIEW_TOO_LARGE",
					);
				}
			}
		}
		state.status = "FAILED";
		state.phase = "Preview stopped at its step limit";
		state.error =
			"The preview reached its step limit before producing a final answer. Narrow the task or use a saved-agent run.";
	} catch (error) {
		state.status =
			isCancellation(error) ||
			CancellationScope.current().consideredCancelled
				? "CANCELLED"
				: "FAILED";
		state.phase =
			state.status === "CANCELLED"
				? "Preview stopped"
				: "Preview could not complete";
		// Never expose raw activity/provider messages. Closed failure types map to actionable safe guidance.
		const cause = error instanceof ActivityFailure ? error.cause : error;
		const guidance: Record<string, string> = {
			AGENT_PREVIEW_TOO_LARGE:
				"The preview context is too large. Select at most 30 specific documents, use fewer skills, or start a new preview.",
			AGENT_PREVIEW_NOT_READY:
				"Some selected documents are processing or unavailable. Choose specific ready documents before previewing a workspace that also has failed or processing files.",
			AGENT_PREVIEW_MODEL_INVALID_DECISION:
				"The AI provider returned an invalid read request. Try a narrower task or check the configured model.",
			AGENT_PREVIEW_MODEL_FAILED:
				"The AI provider could not complete this preview. Check the AI connection and try again.",
			AGENT_PREVIEW_TOOL_REFUSED:
				"A source read could not complete or was refused. Check the selected source, its availability, and your current access before retrying.",
			AGENT_PREVIEW_FORBIDDEN:
				"Access to this preview or its selected sources changed. Review your current access before starting another preview.",
			AgentPreviewAccessError:
				"Access to this preview or its selected sources changed. Review your current access before starting another preview.",
		};
		state.error =
			state.status === "CANCELLED"
				? "The preview was stopped. Your agent draft is preserved."
				: ((cause instanceof ApplicationFailure
						? guidance[cause.type ?? ""]
						: undefined) ??
					"Check the selected knowledge, connections, and AI provider, then retry. Your agent draft is preserved.");
	}
	return state;
}
