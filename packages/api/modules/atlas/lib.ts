import { ORPCError } from "@orpc/client";
import { AtlasError } from "@repo/atlas";

const CODE_MAP = {
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	NO_REPOSITORY: "BAD_REQUEST",
	REPOSITORY_REAUTH_REQUIRED: "CONFLICT",
	REPOSITORY_UNAVAILABLE: "CONFLICT",
	// PRECONDITION_FAILED, not BAD_REQUEST: the caller sent nothing wrong,
	// the tenant has not configured a provider yet. Every Atlas procedure
	// routes its refusal through this map, so a different code here would put
	// the same condition under two different semantics depending on which
	// procedure the user happened to reach (Fizzy #1875).
	NO_AI_PROVIDER: "PRECONDITION_FAILED",
	PERSISTENCE_FAILED: "INTERNAL_SERVER_ERROR",
	BAD_REQUEST: "BAD_REQUEST",
} as const;

/** Map a facade error to an ORPCError; rethrow anything else unchanged. */
export function mapAtlasError(error: unknown): never {
	if (error instanceof AtlasError) {
		throw new ORPCError(CODE_MAP[error.code], { message: error.message });
	}
	throw error;
}

/**
 * Feature gate. The whole feature is OFF unless `FABRIC_FEATURE_ATLAS`
 * is exactly "true" (false by default). Every procedure calls this first, so
 * the API behaves as if the routes don't exist when the flag is unset. The tab
 * itself is gated client-side by `NEXT_PUBLIC_FABRIC_FEATURE_ATLAS`.
 */
export function assertAtlasEnabled(): void {
	// `FABRIC_FEATURE_CODE_UNDERSTANDING` is the legacy env name, kept as a
	// fallback so the existing staging/prod flag config keeps the feature on
	// until it is migrated to `FABRIC_FEATURE_ATLAS`; remove it afterwards.
	const enabled =
		process.env.FABRIC_FEATURE_ATLAS === "true" ||
		process.env.FABRIC_FEATURE_CODE_UNDERSTANDING === "true";
	if (!enabled) {
		throw new ORPCError("NOT_FOUND", {
			message: "Atlas is not enabled.",
		});
	}
}
