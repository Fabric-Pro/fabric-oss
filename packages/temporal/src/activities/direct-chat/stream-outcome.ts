import type {
	DirectChatToolCall,
	DirectChatWorkflowConfirmation,
} from "../../types";

/**
 * Decides whether a finished model stream actually produced a turn, and
 * settles any tool call the stream left mid-flight.
 *
 * Background (Fizzy #2040 QA): a Direct-engine turn that asked for an MCP
 * tool came back from Temporal as `success: true` with an empty
 * `responseText` and one tool call frozen at `status: "pending"` with
 * `args: {}`. `pending` is written when the `tool-input-start` stream part
 * arrives; the stream ended there, so the arguments never finished
 * arriving, the AI SDK never emitted `tool-call`, `execute` never ran, and
 * the model never got a result to answer from. Nothing failed loudly —
 * the activity reported success, the workflow persisted an empty assistant
 * turn, and the chat kept rendering the stored `pending` status as a
 * "Running" spinner that could never resolve. Confirmed on three staging
 * workflow histories.
 *
 * Two independent problems came out of that, and this handles both:
 *
 *  1. A stream error part sets `streamErrorMessage`, but the value was only
 *     ever read from the `catch` block — so when the provider signalled a
 *     failure mid-stream *without* throwing, the message was captured and
 *     then dropped. That is what made the failure invisible.
 *  2. A tool call left at `pending`/`running` when the stream ends can never
 *     progress; persisting it as-is is what produces the permanent spinner.
 *
 * The workflow already knows how to handle `success: false` — it branches on
 * it to persist a `failure` outcome, and (behind `direct-chat-no-tools-retry`)
 * retries once without tools so the user still gets an answer. This function
 * is what lets that existing machinery see the failure.
 */

export interface StreamOutcomeInput {
	responseText: string;
	toolCalls: DirectChatToolCall[];
	/** Message from an `error` stream part, if one was seen. */
	streamErrorMessage?: string;
	/** Set when a tool asked the user to confirm — a legitimate empty-text turn. */
	pendingConfirmation?: DirectChatWorkflowConfirmation;
	/** Provider's reason for ending the stream, when it reported one. */
	finishReason?: string;
}

export interface StreamOutcome {
	/** Undefined when the turn produced something the user can use. */
	error?: string;
	/** `toolCalls` with anything left mid-flight settled as an error. */
	toolCalls: DirectChatToolCall[];
}

const UNFINISHED_TOOL_CALL_ERROR =
	"The model's request for this tool ended before it was complete, so the tool never ran.";

function isUnfinished(toolCall: DirectChatToolCall): boolean {
	return toolCall.status === "pending" || toolCall.status === "running";
}

export function resolveStreamOutcome(input: StreamOutcomeInput): StreamOutcome {
	const {
		responseText,
		toolCalls,
		streamErrorMessage,
		pendingConfirmation,
		finishReason,
	} = input;

	const unfinished = toolCalls.filter(isUnfinished);

	// Settle these regardless of how the turn is classified: a call the
	// stream abandoned cannot resolve later, and the client renders
	// `pending`/`running` as an indefinite spinner.
	const settledToolCalls = toolCalls.map((toolCall) =>
		isUnfinished(toolCall)
			? {
					...toolCall,
					status: "error" as const,
					error: toolCall.error ?? UNFINISHED_TOOL_CALL_ERROR,
				}
			: toolCall,
	);

	// A turn that produced text, or that is waiting on the user to confirm a
	// tool, gave the user something — even if a tool call was also abandoned.
	// That abandoned call is now visibly an error rather than a live spinner,
	// which is enough; failing the turn here would throw away a real answer.
	const producedSomething =
		responseText.trim().length > 0 || pendingConfirmation !== undefined;

	if (producedSomething) {
		return { toolCalls: settledToolCalls };
	}

	const suffix = finishReason
		? ` (provider finish reason: ${finishReason})`
		: "";

	if (streamErrorMessage) {
		return {
			error: `The model's response ended without an answer: ${streamErrorMessage}${suffix}`,
			toolCalls: settledToolCalls,
		};
	}

	if (unfinished.length > 0) {
		const names = unfinished.map((toolCall) => toolCall.name).join(", ");
		return {
			error: `The model started calling ${names} but the response ended before the call was complete, so the tool never ran and no answer was produced${suffix}.`,
			toolCalls: settledToolCalls,
		};
	}

	return { toolCalls: settledToolCalls };
}
