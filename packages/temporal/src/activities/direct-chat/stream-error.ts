/**
 * Extracts a human-readable message from an AI SDK `error` stream part.
 *
 * The provider's real failure (e.g. "tools: too many", "input_schema invalid",
 * "context length exceeded") surfaces here. Without capturing it, the SDK later
 * throws a generic "No output generated. Check the stream for errors." that
 * otherwise becomes the user-facing error.
 */
export function extractStreamErrorMessage(part: unknown): string | undefined {
	if (!part || typeof part !== "object") {
		return undefined;
	}
	const err = (part as { error?: unknown }).error;
	if (err === undefined || err === null) {
		return undefined;
	}
	if (err instanceof Error) {
		return err.message;
	}
	if (typeof err === "string") {
		return err;
	}
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}
