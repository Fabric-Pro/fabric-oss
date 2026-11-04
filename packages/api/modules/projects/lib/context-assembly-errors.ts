import { ContextAssemblyError } from "@repo/rag/lib/context-continuity";
/** Static errors only: never pass storage metadata, source text or raw exception messages. */
export function contextAssemblyRefusal(error: unknown) {
	const refusal =
		error instanceof ContextAssemblyError
			? error
			: new ContextAssemblyError("UNAVAILABLE");
	const code =
		refusal.status === 400
			? ("BAD_REQUEST" as const)
			: refusal.status === 403
				? ("FORBIDDEN" as const)
				: refusal.status === 404
					? ("NOT_FOUND" as const)
					: refusal.status === 409
						? ("CONFLICT" as const)
						: refusal.status === 413
							? ("PAYLOAD_TOO_LARGE" as const)
							: ("SERVICE_UNAVAILABLE" as const);
	return {
		status: refusal.status,
		code,
		reason: refusal.code,
		message: refusal.message,
	};
}
