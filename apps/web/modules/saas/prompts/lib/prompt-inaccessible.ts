import { ORPCError } from "@orpc/client";

/**
 * Whether a `prompts.get.byId` failure means the prompt is not there for
 * this caller to see — rather than the read itself having failed (transport,
 * 5xx, 400).
 *
 * `byId` throws NOT_FOUND both for an absent id and for a prompt outside the
 * caller's tenant (the lookup is tenant-filtered), and that non-disclosure is
 * intentional — telling the two apart would leak which ids belong to someone
 * else's tenant. `requireInputOrgPermission` throws FORBIDDEN for the same
 * underlying fact stated differently — the caller is not a member of the
 * prompt's organization — and "This prompt does not exist, or you do not have
 * access to it." is exactly as true there. Every OTHER error code (BAD_REQUEST,
 * a 5xx, a transport failure) means the read failed and the prompt may well
 * exist; that case needs different copy and is the only one that offers a
 * retry — retrying a NOT_FOUND or FORBIDDEN can never succeed.
 */
export function isPromptInaccessible(error: unknown): boolean {
	return (
		error instanceof ORPCError &&
		(error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
	);
}
