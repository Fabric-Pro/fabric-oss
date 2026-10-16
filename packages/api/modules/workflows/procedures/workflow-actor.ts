import { ORPCError } from "@orpc/client";
import { os } from "@orpc/server";
import {
	toOrpcError,
	type WorkflowActor,
} from "../lib/workflow-command-context";

/**
 * The actor a workflow procedure hands its command: the session's user in the
 * organization the procedure resolved with `resolveOrganizationId`. There is no
 * organization-less actor (ADR-018), so a request that resolves to none is
 * refused here rather than reaching a command with a fail-closed null.
 *
 * Takes the resolved organization, never the caller's own input: resolving it
 * is what enforces the authorized-project binding.
 */
export function workflowActor(
	userId: string,
	resolvedOrganizationId: string | undefined,
): WorkflowActor {
	if (!resolvedOrganizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "An organization is required to work with workflows",
		});
	}
	return { userId, organizationId: resolvedOrganizationId };
}

/**
 * Turns a workflow command's refusal into the procedure's error. Mounted on a
 * procedure with `.use(workflowCommandErrors)`, so its handler awaits the
 * command and a `WorkflowCommandError` leaves it as the matching `ORPCError`.
 */
export const workflowCommandErrors = os.middleware(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		throw toOrpcError(error);
	}
});
