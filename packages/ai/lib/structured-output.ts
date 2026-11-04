/**
 * Structured output through `generateText` + `Output.object`.
 *
 * The AI SDK deprecated `generateObject` in favour of `generateText` with an
 * `output` setting. The two report a schema mismatch or unparsable answer the
 * same way — a `NoObjectGeneratedError` carrying `finishReason`, `usage` and
 * `response` — but they differ when the model returns NO text and stops for a
 * reason other than "stop" (for example a reasoning model that spends its whole
 * output budget thinking and ends on "length"). `generateObject` threw a
 * `NoObjectGeneratedError` with that `finishReason`; `generateText` resolves
 * normally and only its `output` getter throws a bare `NoOutputGeneratedError`,
 * which carries no `finishReason` at all.
 *
 * Callers classify the old error by `finishReason` (an output-token cut-off is
 * not a malformed answer) and retry or salvage on it, so
 * `requireStructuredOutput` reads the output inside the awaited call and turns
 * that empty case back into the `NoObjectGeneratedError` `generateObject`
 * raised. Every other error passes through unchanged.
 */
import {
	type FinishReason,
	type GenerateTextResult,
	type LanguageModelResponseMetadata,
	type LanguageModelUsage,
	NoObjectGeneratedError,
	NoOutputGeneratedError,
	type OutputInterface,
	type ToolSet,
} from "ai";

/** The result of a one-shot `generateText` call whose `output` yields OBJECT. */
export type StructuredTextResult<OBJECT> = GenerateTextResult<
	ToolSet,
	Record<string, unknown>,
	OutputInterface<OBJECT>
>;

interface StructuredResultFields {
	readonly output: unknown;
	readonly finishReason: FinishReason;
	readonly usage: LanguageModelUsage;
	readonly response: LanguageModelResponseMetadata & { messages?: unknown };
}

/**
 * Awaits a `generateText({ output: Output.object(...) })` call and checks that
 * it produced an output, keeping the `generateObject` error contract.
 */
export async function requireStructuredOutput<
	RESULT extends StructuredResultFields,
>(pending: PromiseLike<RESULT>): Promise<RESULT> {
	const result = await pending;
	try {
		void result.output;
	} catch (error) {
		if (!NoOutputGeneratedError.isInstance(error)) {
			throw error;
		}
		const { messages: _messages, ...response } = result.response;
		throw new NoObjectGeneratedError({
			message:
				"No object generated: the model did not return a response.",
			response,
			usage: result.usage,
			finishReason: result.finishReason,
		});
	}
	return result;
}
