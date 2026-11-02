import { type AGUIEvent, EventType } from "@ag-ui/client";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { z } from "zod";
import {
	errorMessageOf,
	isAbortError,
	isRuntimeHttpError,
} from "./direct-runtime-transport";
import { streamRequestReplyRun } from "./request-reply-runtime";

/**
 * A request/reply chat's run that ended in RUN_ERROR. A usage-limit refusal
 * carries the limits the shared limit toast shows, as the chat route's 429
 * did.
 */
export class RequestReplyRunError extends Error {
	constructor(
		message: string,
		readonly code: string | undefined,
		readonly usageLimit: AiUsageLimitExceededPayload | null,
	) {
		super(message);
		this.name = "RequestReplyRunError";
	}
}

/** Where `InProcessEngine` puts a refusal's payload on RUN_ERROR. */
const runErrorMetadataSchema = z.object({
	fabric: z.object({ data: z.unknown() }),
});

function requestReplyRunError(
	event: Extract<AGUIEvent, { type: EventType.RUN_ERROR }>,
): RequestReplyRunError {
	const metadata = runErrorMetadataSchema.safeParse(event.metadata ?? {});
	const data = metadata.success ? metadata.data.fabric.data : undefined;
	return new RequestReplyRunError(
		event.message,
		event.code,
		event.code === "AI_USAGE_LIMIT_EXCEEDED" &&
			isAiUsageLimitExceededPayload(data)
			? data
			: null,
	);
}

const LOST_REPLY_MESSAGE =
	"The connection to this reply was lost. Please try again.";

/**
 * One request/reply run to its end, for every request/reply chat client:
 * each event goes to `onEvent`, and the promise resolves once the run
 * finished. It rejects with what the chat shows: the run's RUN_ERROR as a
 * `RequestReplyRunError`, the endpoint's own refusal, an `AbortError` once
 * the chat let go of the run, or the lost-reply error.
 */
export async function collectRequestReplyRun(
	run: Parameters<typeof streamRequestReplyRun>[0],
): Promise<void> {
	const end: { failure?: RequestReplyRunError; finished: boolean } = {
		finished: false,
	};
	try {
		await streamRequestReplyRun({
			...run,
			onEvent: (event) => {
				if (event.type === EventType.RUN_ERROR) {
					end.failure = requestReplyRunError(event);
				} else if (event.type === EventType.RUN_FINISHED) {
					end.finished = true;
				}
				run.onEvent(event);
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
		console.warn(`[${run.agentId}] A response dropped`, error);
		throw end.failure ?? new Error(LOST_REPLY_MESSAGE);
	}
	if (end.failure) {
		throw end.failure;
	}
	// A response that ended without saying how is a dropped reply, never a
	// whole (or an empty) answer.
	if (!end.finished) {
		throw new Error(LOST_REPLY_MESSAGE);
	}
}
