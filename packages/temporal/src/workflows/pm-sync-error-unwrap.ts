/**
 * Walk a thrown error's `cause` chain (and Temporal's `ActivityFailure`
 * wrappers) to extract the most informative root cause message and class.
 *
 * Temporal SDK wraps activity throws in `ActivityFailure` whose own `.message`
 * is a generic string like "Activity task failed". The actual reason from
 * the activity (e.g. "PM ticket fetch failed for 75 via wit_get_work_item:
 * Error retrieving work item: Client does not support form elicitation.")
 * lives in `.cause.message`. Walk through nested causes so the user sees
 * the real reason in the failure side panel.
 */
export function unwrapPmSyncError(error: unknown): {
	message: string;
	errorClass: string;
} {
	let current: unknown = error;
	let depth = 0;
	let bestMessage = "";
	let bestClass = "UnknownError";

	while (current != null && depth < 8) {
		const e = current as {
			message?: unknown;
			cause?: unknown;
			type?: unknown;
			name?: unknown;
		};

		const message = typeof e.message === "string" ? e.message : "";
		const type = typeof e.type === "string" ? e.type : "";
		const name = typeof e.name === "string" ? e.name : "";

		// "Activity task failed" / "Workflow execution failed" are generic
		// Temporal wrappers that carry no real information — keep walking.
		const isGenericWrapper =
			message === "Activity task failed" ||
			message === "Workflow execution failed";

		if (message && !isGenericWrapper) {
			bestMessage = message;
			bestClass = type || name || bestClass;
			// Continue walking — sometimes the most specific cause is deeper
			// (e.g. ApplicationFailure -> Error). Keep the latest non-generic.
		} else if (!bestMessage && (type || name)) {
			bestClass = type || name;
		}

		current = e.cause;
		depth += 1;
	}

	if (!bestMessage) {
		bestMessage =
			error instanceof Error
				? error.message || "Unknown error"
				: String(error);
	}

	return { message: bestMessage.slice(0, 500), errorClass: bestClass };
}
