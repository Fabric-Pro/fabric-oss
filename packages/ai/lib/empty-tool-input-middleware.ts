import type { LanguageModelMiddleware } from "ai";

/**
 * The provider stream-part union, taken from the middleware type rather than
 * imported from `@ai-sdk/provider` — that package is a transitive dependency
 * here, and re-declaring it as a direct one to name a type is not worth it.
 */
type ProviderStreamPart = Awaited<
	ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
>["stream"] extends ReadableStream<infer Part>
	? Part
	: never;

/**
 * Restores tool calls that `@ai-sdk/openai@3` drops on the floor.
 *
 * The provider assembles a streamed tool call from OpenAI-shaped deltas and
 * only emits `tool-call` once the accumulated `arguments` string parses as
 * JSON. A tool with NO parameters is sent as `arguments: ""` with no further
 * deltas — `isParsableJson("")` is false, so the call is never emitted, and
 * v3's `flush` (unlike `@ai-sdk/openai-compatible`, which still iterates
 * `!hasFinished` calls) enqueues only `finish`. The call is dropped silently:
 * `tool-input-start` arrives, nothing follows, `execute` never runs, and the
 * model never receives a result to answer from.
 *
 * Observed on Fizzy #2040 as "MCP is broken" — because the tools this hits
 * are the zero-argument discovery and identity ones an agent calls FIRST.
 * Confirmed by a controlled A/B on staging: zero-argument tools failed every
 * time, tools taking arguments succeeded every time.
 *
 * The repair is deliberately narrow. A call is only synthesised when NO input
 * delta ever arrived, which is exactly the no-parameter case. A call whose
 * arguments began arriving and stopped mid-JSON is genuinely truncated —
 * inventing `{}` there would run the tool with arguments the model never
 * chose, so those are still dropped, as they are today.
 */
export function createEmptyToolInputRepairMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v3",
		wrapStream: async ({ doStream }) => {
			const { stream, ...rest } = await doStream();

			/**
			 * tool-input-start seen and no tool-call yet, mapped to the tool
			 * name and whatever input text has arrived so far.
			 *
			 * The accumulated text matters: after the first chunk the provider
			 * enqueues `tool-input-delta` UNCONDITIONALLY, as
			 * `delta: arguments ?? ""`. A no-parameter call therefore does emit
			 * deltas — empty ones. Treating the arrival of any delta as
			 * "arguments started" is what made the first version of this
			 * middleware a no-op in production while passing against a mock
			 * that only ever emitted the no-delta shape.
			 */
			const awaitingInput = new Map<
				string,
				{ toolName: string; text: string }
			>();

			const repaired = stream.pipeThrough(
				new TransformStream<ProviderStreamPart, ProviderStreamPart>({
					transform(part, controller) {
						switch (part.type) {
							case "tool-input-start":
								awaitingInput.set(part.id, {
									toolName: part.toolName,
									text: "",
								});
								break;
							case "tool-input-delta": {
								const pending = awaitingInput.get(part.id);
								if (pending) {
									pending.text += part.delta ?? "";
								}
								break;
							}
							case "tool-call":
								awaitingInput.delete(part.toolCallId);
								break;
							case "finish": {
								for (const [
									id,
									pending,
								] of awaitingInput.entries()) {
									// Anything that actually arrived means the
									// call was truncated mid-JSON, not empty.
									// Synthesising `{}` there would run the tool
									// with arguments the model never chose.
									if (pending.text.trim() !== "") {
										continue;
									}
									controller.enqueue({
										type: "tool-input-end",
										id,
									});
									controller.enqueue({
										type: "tool-call",
										toolCallId: id,
										toolName: pending.toolName,
										input: "{}",
									});
								}
								awaitingInput.clear();
								break;
							}
						}

						controller.enqueue(part);
					},
				}),
			);

			return { stream: repaired, ...rest };
		},
	};
}
