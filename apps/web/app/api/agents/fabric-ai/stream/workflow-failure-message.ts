// Intentional duplication: `@repo/temporal` exports `unwrapPmSyncError`
// (returns `{ message, errorClass }`) and `extractMeaningfulErrorMessage`
// lives inside a workflow file that imports `@temporalio/workflow` runtime
// side-effects. Neither can be used here without a return-type mismatch or
// bundling workflow runtime into the Next.js web bundle. This helper is kept
// as a thin standalone to stay web-bundle-safe. Keep the generic-message list
// and 500-char truncation in sync with the `@repo/temporal` equivalents.
const GENERIC_TEMPORAL_MESSAGES = new Set([
	"workflow execution failed",
	"activity task failed",
	"activity task failed.",
]);

/**
 * Walks a Temporal error's `.cause` chain (WorkflowFailedError →
 * ActivityFailure → ApplicationFailure) and returns the deepest meaningful
 * message, skipping Temporal's generic wrapper messages. Falls back to the
 * default when nothing meaningful is found.
 *
 * The returned message is capped at 500 chars (matching the `@repo/temporal`
 * helpers) so an unbounded provider string cannot be forwarded to SSE clients.
 */
export function extractWorkflowFailureMessage(error: unknown): string {
	const DEFAULT = "Workflow execution failed";
	let current: unknown = error;
	let best: string | undefined;
	for (let depth = 0; depth < 8 && current != null; depth++) {
		if (current instanceof Error) {
			const message = current.message?.trim();
			if (
				message &&
				!GENERIC_TEMPORAL_MESSAGES.has(message.toLowerCase())
			) {
				best = current.message; // deepest meaningful wins
			}
		}
		current = (current as { cause?: unknown } | null | undefined)?.cause;
	}
	if (best !== undefined) {
		return best.length > 500 ? best.slice(0, 500) : best;
	}
	return DEFAULT;
}
