import { APICallError, type LanguageModelMiddleware } from "ai";

export const GATEWAY_FLEX_JOB_TYPES: ReadonlySet<string> = new Set([
	"publishing-suggestion",
	"living-document-refresh",
	"newsletter-curation",
	"recurring-error-scan",
]);

export function gatewayFlexDisabled(): boolean {
	return (
		process.env.AI_GATEWAY_FLEX_DISABLED === "1" ||
		process.env.AI_GATEWAY_FLEX_DISABLED === "true"
	);
}

function isCapacityRefusal(error: unknown): boolean {
	// The gateway SDK keeps its HTTP APICallError in the cause chain. Any 429 or
	// 503 matches, so a gateway rate limit or outage also gets the one retry.
	const seen = new Set<unknown>();
	let current = error;
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		if (APICallError.isInstance(current)) {
			return current.statusCode === 429 || current.statusCode === 503;
		}
		current = current.cause;
	}
	return false;
}

type CallParams = Parameters<
	NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"];

function withoutServiceTier(params: CallParams): CallParams {
	const { serviceTier: _serviceTier, ...gateway } =
		params.providerOptions?.gateway ?? {};
	return {
		...params,
		providerOptions: { ...params.providerOptions, gateway },
	};
}

/** Request flex, with one standard-tier retry after an HTTP 429 or 503. */
export function createGatewayFlexMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		transformParams: async ({ params }) => ({
			...params,
			providerOptions: {
				...params.providerOptions,
				gateway: {
					...params.providerOptions?.gateway,
					serviceTier: "flex",
				},
			},
		}),
		wrapGenerate: async ({ doGenerate, params, model }) => {
			try {
				return await doGenerate();
			} catch (error) {
				if (!isCapacityRefusal(error)) {
					throw error;
				}
				return model.doGenerate(withoutServiceTier(params));
			}
		},
		wrapStream: async ({ doStream, params, model }) => {
			try {
				return await doStream();
			} catch (error) {
				if (!isCapacityRefusal(error)) {
					throw error;
				}
				return model.doStream(withoutServiceTier(params));
			}
		},
	};
}
