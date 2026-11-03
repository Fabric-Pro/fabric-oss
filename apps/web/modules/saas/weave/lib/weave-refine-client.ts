import { EventType } from "@ag-ui/client";
import type { AnswerModelInfo } from "@repo/ai/lib/answer-model-info";
import {
	errorMessageOf,
	isAbortError,
	isRuntimeHttpError,
} from "@saas/agents/lib/direct-runtime-transport";
import { streamRequestReplyRun } from "@saas/agents/lib/request-reply-runtime";
import { orpcClient } from "@shared/lib/orpc-client";
import {
	WEAVE_REFINE_AGENT_ID,
	WEAVE_REFINE_EVENT,
	weaveRefineResultEventSchema,
} from "./weave-refine-runtime-protocol";

/**
 * One refinement of Create Plan's request, over either transport
 * (`useRuntimeChatTransport("COPILOTKIT_WEAVE_REFINE_CHAT")` picks):
 * `weave.plans.refine` answers in one reply, the agent runtime streams the
 * feedback. Both resolve with the whole reply and reject with the message
 * the form shows (an `AbortError` once the form let go of the request). The
 * runtime run is only ever ended by aborting its request, never by the
 * runtime's `stop`.
 */

export interface RefinementMessage {
	model?: AnswerModelInfo;
	role: "user" | "assistant";
	content: string;
}

export interface RefineRequest {
	projectId: string;
	currentMessage: string;
	refinementInput: string;
	history: ReadonlyArray<RefinementMessage>;
}

export interface RefineReply {
	model?: AnswerModelInfo;
	feedback: string;
	updatedMessage: string;
	isReady: boolean;
}

const EARLY_END_MESSAGE = "The reply ended early. Please try again.";

/** `weave.plans.refine`: the whole reply at once. */
export async function refineOverRoute(
	request: RefineRequest & { organizationId: string | null },
): Promise<RefineReply> {
	const result = await orpcClient.weave.plans.refine({
		projectId: request.projectId,
		organizationId: request.organizationId,
		currentMessage: request.currentMessage,
		refinementInput: request.refinementInput,
		history: [...request.history],
	});
	return {
		feedback: result.feedback,
		updatedMessage: result.updatedMessage,
		isReady: result.isReady,
		model: result.model,
	};
}

/**
 * The agent runtime's `weave-refine` agent: `onText` with the feedback so
 * far as it streams. Resolves once the run finished with its result; a run
 * that ends without both is an early end, never a reply.
 */
export async function refineOverRuntime(
	request: RefineRequest & {
		/** The organization on screen, which the runtime request runs in. */
		organizationId: string | undefined;
		signal: AbortSignal;
		onText: (feedback: string) => void;
	},
): Promise<RefineReply> {
	const reply: {
		text: string;
		result?: {
			updatedMessage: string;
			isReady: boolean;
			model?: AnswerModelInfo;
		};
		failure?: string;
		finished: boolean;
	} = { text: "", finished: false };
	try {
		await streamRequestReplyRun({
			agentId: WEAVE_REFINE_AGENT_ID,
			// Nothing is saved, so every send is its own thread: a run the
			// network dropped never holds the next send behind it.
			threadId: crypto.randomUUID(),
			messages: [
				...request.history,
				{ role: "user", content: request.refinementInput },
			],
			forwardedProps: {
				projectId: request.projectId,
				currentMessage: request.currentMessage,
			},
			organizationId: request.organizationId,
			signal: request.signal,
			onEvent: (event) => {
				if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
					reply.text += event.delta;
					request.onText(reply.text);
				} else if (
					event.type === EventType.CUSTOM &&
					event.name === WEAVE_REFINE_EVENT.result
				) {
					const parsed = weaveRefineResultEventSchema.safeParse(
						event.value,
					);
					if (parsed.success) {
						reply.result = parsed.data;
					}
				} else if (event.type === EventType.RUN_ERROR) {
					reply.failure = event.message;
				} else if (event.type === EventType.RUN_FINISHED) {
					reply.finished = true;
				}
			},
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		// The endpoint refused the request itself (a signed-out session, an
		// organization left): its message, as the other runtime chats word it.
		if (isRuntimeHttpError(error)) {
			throw new Error(errorMessageOf(error));
		}
		console.warn("[Weave refinement] A response dropped", error);
		throw new Error(reply.failure ?? EARLY_END_MESSAGE);
	}
	if (reply.failure !== undefined) {
		throw new Error(reply.failure);
	}
	if (!reply.finished || !reply.result) {
		throw new Error(EARLY_END_MESSAGE);
	}
	return { feedback: reply.text, ...reply.result };
}
