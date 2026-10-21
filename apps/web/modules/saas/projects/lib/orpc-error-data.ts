/**
 * The machine-readable fields a procedure puts in an error's `data`: a
 * refusal's own code (`ANALYSIS_IN_PROGRESS`, `DOCUMENT_GENERATION_IN_PROGRESS`,
 * `CONTEXT_UPDATE_TRUNCATED`, …) and a rate limit's `retryAfter` seconds.
 * Read defensively off a thrown oRPC error without importing its class;
 * never the message. The oRPC code itself (`CONFLICT`, `NOT_FOUND`, …) is
 * `getOrpcCode` in `components/field-mapping/orpc-error`.
 */
export function getOrpcErrorData(error: unknown): {
	code?: string;
	retryAfter?: number;
} {
	if (typeof error !== "object" || error === null || !("data" in error)) {
		return {};
	}
	const data = (error as { data?: unknown }).data;
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const { code, retryAfter } = data as {
		code?: unknown;
		retryAfter?: unknown;
	};
	return {
		code: typeof code === "string" ? code : undefined,
		retryAfter:
			typeof retryAfter === "number" && Number.isFinite(retryAfter)
				? retryAfter
				: undefined,
	};
}
