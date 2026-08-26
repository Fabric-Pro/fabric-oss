/**
 * Transport-agnostic error with a coarse code the API layer maps to an
 * `ORPCError`. Keeps the package free of any oRPC dependency.
 */
export type AtlasErrorCode =
	| "NOT_FOUND"
	| "CONFLICT"
	| "NO_REPOSITORY"
	| "REPOSITORY_REAUTH_REQUIRED"
	| "REPOSITORY_UNAVAILABLE"
	| "NO_AI_PROVIDER"
	| "PERSISTENCE_FAILED"
	| "BAD_REQUEST";

export class AtlasError extends Error {
	readonly code: AtlasErrorCode;
	constructor(code: AtlasErrorCode, message: string) {
		super(message);
		this.name = "AtlasError";
		this.code = code;
	}
}
