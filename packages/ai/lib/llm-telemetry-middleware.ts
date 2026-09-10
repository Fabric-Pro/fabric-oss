import { llmInstrumentation } from "@repo/observability/llm";
import type { LanguageModelMiddleware } from "ai";

interface LLMTelemetryContext {
	provider: string;
	model: string;
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
): ReadableStream<T> {
	const reader = stream.getReader();
	let terminal = false;

	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					if (!terminal) {
						terminal = true;
						invocation.fail();
					}
					controller.close();
					return;
				}

				const chunk = result.value;
				if (!terminal && chunk.type === "finish") {
					terminal = true;
					invocation.succeed(usageOf(chunk));
				} else if (!terminal && chunk.type === "error") {
					terminal = true;
					invocation.fail((chunk as { error?: unknown }).error);
				}
				controller.enqueue(chunk);
			} catch (error) {
				if (!terminal) {
					terminal = true;
					invocation.fail(error);
				}
				controller.error(error);
			}
		},
		async cancel(reason) {
			if (!terminal) {
				terminal = true;
				invocation.cancel();
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
	return {
		specificationVersion: "v3",
		wrapGenerate: async ({ doGenerate }) => {
			const invocation = llmInstrumentation.startInvocation(context);
			try {
				const result = await doGenerate();
				invocation.succeed(usageOf(result));
				return result;
			} catch (error) {
				invocation.fail(error);
				throw error;
			}
		},
		wrapStream: async ({ doStream }) => {
			const invocation = llmInstrumentation.startInvocation(context);
			let result: Awaited<ReturnType<typeof doStream>>;
			try {
				result = await doStream();
			} catch (error) {
				invocation.fail(error);
				throw error;
			}
			try {
				return {
					...result,
					stream: instrumentStream(result.stream, invocation),
				};
			} catch {
				invocation.cancel();
				return result;
			}
		},
	};
}
