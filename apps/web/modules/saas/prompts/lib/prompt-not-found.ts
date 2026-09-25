import { ORPCError } from "@orpc/client";

/**
 * Whether a `prompts.get.byId` failure means the prompt does not exist —
 * rather than the read itself having failed (transport, 5xx, 400).
 *
 * `byId` throws NOT_FOUND both for an absent id and for a prompt outside the
 * caller's tenant (the lookup is tenant-filtered), and that non-disclosure is
 * intentional — telling the two apart would leak which ids belong to someone
 * else's tenant. Every other error code means the read failed and the prompt
 * may well exist; those two cases need different copy and only one of them
 * offers a retry.
 */
export function isPromptNotFound(error: unknown): boolean {
	return error instanceof ORPCError && error.code === "NOT_FOUND";
}
