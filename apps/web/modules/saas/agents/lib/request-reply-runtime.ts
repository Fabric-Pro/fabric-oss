import type { AGUIEvent } from "@ag-ui/client";
import { runtimePaths, streamRuntime } from "./direct-runtime-transport";

/**
 * One run of a request/reply chat on the agent runtime (an `InProcessEngine`
 * agent): the conversation so far, the last message the question, and the
 * agent's request context in `forwardedProps`. Each AG-UI event is handed
 * over until the response ends; rejects with the request's failure.
 */
export function streamRequestReplyRun(args: {
	agentId: string;
	threadId: string;
	messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
	forwardedProps: Record<string, unknown>;
	organizationId: string | undefined;
	signal: AbortSignal;
	onEvent: (event: AGUIEvent) => void;
}): Promise<void> {
	const runId = crypto.randomUUID();
	return streamRuntime({
		url: runtimePaths(args.agentId).run,
		input: {
			threadId: args.threadId,
			runId,
			messages: args.messages.map((message, index) => ({
				id: `${runId}-${index}`,
				role: message.role,
				content: message.content,
			})),
			tools: [],
			context: [],
			state: {},
			forwardedProps: args.forwardedProps,
		},
		organizationId: args.organizationId,
		signal: args.signal,
		onEvent: args.onEvent,
	});
}
