import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";

/**
 * Reasons a Fabric tool gives for refusing in words written for the person
 * using the product. Every other failure has a message written for a developer
 * (a tool's id, an HTTP status), which is not shown.
 */
const REASONS_WITH_USER_MESSAGES: ReadonlySet<string> = new Set([
	"busy",
	"rate_limited",
	"limit",
	"usage_limit",
]);

/** A refusal that is worth trying again in a moment, and no failure of the person's. */
export function isBusyError(error: unknown): boolean {
	return error instanceof FabricToolError && error.reason === "busy";
}

/**
 * What to tell the person about a failure: the tool's own words when it gave a
 * reason meant for them (busy, rate limited, over a limit, out of AI usage),
 * otherwise `fallback`, a sentence the caller wrote for the action that failed.
 */
export function userMessageOf(error: unknown, fallback: string): string {
	if (
		error instanceof FabricToolError &&
		error.reason !== undefined &&
		REASONS_WITH_USER_MESSAGES.has(error.reason) &&
		error.message
	) {
		return error.message;
	}
	return fallback;
}
