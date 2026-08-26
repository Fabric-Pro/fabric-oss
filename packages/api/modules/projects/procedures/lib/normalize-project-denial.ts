/**
 * Collapses every project-access denial into one indistinguishable response.
 *
 * `requireProjectPermission` deliberately distinguishes a project that does not
 * exist (NOT_FOUND) from one the caller cannot reach (FORBIDDEN). That is useful
 * inside the app, and a disclosure on an endpoint that takes a caller-supplied
 * id: the pair lets any authenticated user probe project ids across tenants and
 * learn which ones exist. On the #1694 mutations both are normalized to a single
 * NOT_FOUND with fixed wording and no payload.
 *
 * This is a middleware rather than a try/catch in the handler because the
 * decorator throws from middleware — the handler body never runs. Chain it
 * BEFORE the decorator so it sits outside:
 *
 *   .use(normalizeProjectDenial).use(requireProjectPermission(...))
 *
 * Reversing the order leaves the decorator's own shapes on the wire.
 */
import { ORPCError } from "@orpc/client";
import { os } from "@orpc/server";

/** The single shape every denial collapses to. */
export const PROJECT_DENIAL_MESSAGE = "Project not found";

function isDenial(error: unknown): boolean {
	if (!(error instanceof ORPCError)) {
		return false;
	}
	return error.code === "NOT_FOUND" || error.code === "FORBIDDEN";
}

export const normalizeProjectDenial = os.middleware(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		if (isDenial(error)) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_DENIAL_MESSAGE,
			});
		}
		throw error;
	}
});
