import { isPermanentProviderFailure } from "@repo/ai";
import { ApplicationFailure } from "@temporalio/common";

const EMBEDDING_PROVIDER_REJECTED = "EMBEDDING_PROVIDER_REJECTED";

/** Preserve a provider verdict after RAG has returned a serializable result. */
export function embeddingFailure(result: {
	error?: string;
	permanentFailure?: boolean;
}): Error {
	const message = result.error || "Embedding generation failed";
	return result.permanentFailure
		? ApplicationFailure.nonRetryable(message, EMBEDDING_PROVIDER_REJECTED)
		: new Error(message);
}

/** Translate raw provider errors before a wrapper can erase their attribution. */
export function throwIfPermanentProviderFailure(error: unknown): void {
	if (isPermanentProviderFailure(error)) {
		throw ApplicationFailure.nonRetryable(
			error instanceof Error
				? error.message
				: "Embedding provider rejected the request",
			EMBEDDING_PROVIDER_REJECTED,
		);
	}
}
