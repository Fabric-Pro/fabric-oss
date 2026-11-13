import type { LanguageModelMiddleware } from "ai";

/** Avoid cache writes for direct OpenAI requests with no reusable history. */
export function createOpenAIOneShotCacheMiddleware(
	modelName: string,
	resolvedProvider?: string,
	viaGateway = false,
): LanguageModelMiddleware {
	const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(modelName);
	const supported =
		version !== null &&
		(Number(version[1]) > 5 ||
			(Number(version[1]) === 5 && Number(version[2] ?? 0) >= 6));
	return {
		specificationVersion: "v4",
		transformParams: async ({ params }) => {
			const openai = params.providerOptions?.openai;
			const hasBreakpoint = (options: typeof params.providerOptions) =>
				options?.openai?.promptCacheBreakpoint !== undefined;
			if (
				resolvedProvider !== "OPENAI_DIRECT" ||
				viaGateway ||
				!supported ||
				(params.tools?.length ?? 0) > 0 ||
				params.prompt.some(
					(message) =>
						message.role === "assistant" || message.role === "tool",
				) ||
				openai?.promptCacheOptions !== undefined ||
				openai?.promptCacheKey !== undefined ||
				params.prompt.some(
					(message) =>
						hasBreakpoint(message.providerOptions) ||
						(Array.isArray(message.content) &&
							message.content.some((part) =>
								hasBreakpoint(part.providerOptions),
							)),
				)
			) {
				return params;
			}
			return {
				...params,
				providerOptions: {
					...params.providerOptions,
					openai: {
						...openai,
						promptCacheOptions: { mode: "explicit" },
					},
				},
			};
		},
	};
}
