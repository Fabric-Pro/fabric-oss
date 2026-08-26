/**
 * Read the oRPC error code (e.g. "NOT_FOUND", "FORBIDDEN") off a thrown client
 * error. oRPC surfaces `ORPCError` instances carrying a string `code`; this
 * reads it defensively without importing the class, so callers can branch on the
 * typed failure modes the procedures declare.
 */
export function getOrpcCode(error: unknown): string | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string"
	) {
		return (error as { code: string }).code;
	}
	return undefined;
}
