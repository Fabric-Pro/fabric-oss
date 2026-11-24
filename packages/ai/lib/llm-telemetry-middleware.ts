import {
	type LLMTokenUsage,
	llmInstrumentation,
} from "@repo/observability/llm";
import type { LanguageModelMiddleware } from "ai";

interface LLMTelemetryContext {
	provider: string;
	model: string;
	/** Observes provider failure before SDK conversion, with all counts seen so far. */
	captureFailedReply?: <T>(
		observe: (usage: Readonly<LLMTokenUsage>) => void,
		call: () => PromiseLike<T>,
	) => PromiseLike<T>;
}

interface FailedReply {
	failed: boolean;
	usage?: Readonly<LLMTokenUsage>;
}

interface TokenUsageSource {
	inputTokens?: unknown;
	outputTokens?: unknown;
}

function tokenCount(value: unknown): number {
	if (value && typeof value === "object") {
		return tokenCount((value as { total?: unknown }).total);
	}
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function usageOf(value: unknown) {
	const usage =
		value && typeof value === "object"
			? ((value as { usage?: TokenUsageSource }).usage ?? {})
			: {};
	return {
		inputTokens: tokenCount(usage.inputTokens),
		outputTokens: tokenCount(usage.outputTokens),
	};
}

function instrumentStream<T extends { type: string }>(
	stream: ReadableStream<T>,
	invocation: ReturnType<typeof llmInstrumentation.startInvocation>,
	reply: FailedReply,
): ReadableStream<T> {
	const reader = stream.getReader();
	let terminal = false;
	let failure: { error?: unknown } | undefined;

	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					if (!terminal) {
						terminal = true;
						invocation.fail(failure?.error, reply.usage);
					}
					controller.close();
					return;
				}

				const chunk = result.value;
				if (!terminal && chunk.type === "error") {
					// Some providers report a failed reply's usage on the finish chunk.
					failure ??= chunk as { error?: unknown };
				} else if (!terminal && chunk.type === "finish") {
					terminal = true;
					const { finishReason } = chunk as {
						finishReason?: { unified: string };
					};
					const usage = usageOf(chunk);
					if (
						failure ||
						reply.failed ||
						finishReason?.unified === "error"
					) {
						invocation.fail(failure?.error, {
							inputTokens:
								reply.usage?.inputTokens ?? usage?.inputTokens,
							outputTokens:
								reply.usage?.outputTokens ??
								usage?.outputTokens,
						});
					} else {
						invocation.succeed(usage);
					}
				}
				controller.enqueue(chunk);
			} catch (error) {
				if (!terminal) {
					terminal = true;
					invocation.fail(failure?.error ?? error, reply.usage);
				}
				controller.error(error);
			}
		},
		async cancel(reason) {
			if (!terminal) {
				terminal = true;
				if (failure || reply.failed) {
					invocation.fail(failure?.error, reply.usage);
				} else {
					invocation.cancel();
				}
			}
			await reader.cancel(reason);
		},
	});
}

/**
 * Trace every AI SDK model round-trip at the shared model-factory boundary.
 * Prompt, output, credentials, run IDs, and raw error details are never read.
 */
export function createLLMTelemetryMiddleware(
	context: LLMTelemetryContext,
): LanguageModelMiddleware {
	const { captureFailedReply = (_observe, call) => call() } = context;
	const capture = <T>(reply: FailedReply, call: () => PromiseLike<T>) =>
		captureFailedReply((usage) => {
			reply.failed = true;
			reply.usage = usage;
		}, call);
	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate }) => {
			const invocation = llmInstrumentation.startInvocation(context);
			const reply: FailedReply = { failed: false };
			try {
				const result = await capture(reply, doGenerate);
				invocation.succeed(usageOf(result));
				return result;
			} catch (error) {
				invocation.fail(error, reply.usage);
				throw error;
			}
		},
		wrapStream: async ({ doStream }) => {
			const invocation = llmInstrumentation.startInvocation(context);
			const reply: FailedReply = { failed: false };
			let result: Awaited<ReturnType<typeof doStream>>;
			try {
				result = await capture(reply, doStream);
			} catch (error) {
				invocation.fail(error, reply.usage);
				throw error;
			}
			try {
				return {
					...result,
					stream: instrumentStream(result.stream, invocation, reply),
				};
			} catch {
				invocation.cancel();
				return result;
			}
		},
	};
}
