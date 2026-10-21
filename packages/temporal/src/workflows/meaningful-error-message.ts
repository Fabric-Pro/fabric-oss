/**
 * Workflow-safe, dependency-free cause-chain formatting. The caller supplies
 * its fallback so shared formatting carries no workflow-specific wording.
 */
export function extractMeaningfulErrorMessage(
	error: unknown,
	fallbackText: string,
): string {
	const generic = new Set([
		"Activity task failed",
		"Workflow execution failed",
	]);
	let current: unknown = error;
	let best = "";
	for (let depth = 0; current != null && depth < 8; depth++) {
		const entry = current as { message?: unknown; cause?: unknown };
		const message = typeof entry.message === "string" ? entry.message : "";
		if (message && !generic.has(message)) {
			best = message;
		}
		current = entry.cause;
	}
	return (best || fallbackText).slice(0, 500);
}
