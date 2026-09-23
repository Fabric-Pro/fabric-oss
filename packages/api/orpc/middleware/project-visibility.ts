/**
 * Answer NOT_FOUND for a project the caller cannot see, before any permission
 * is evaluated, and in exactly the words an id that names no project gets.
 *
 * ## What this adds over the permission gate
 *
 * `requireProjectPermission` already answers NOT_FOUND, in these same words,
 * for a caller with no tie to the project at all — not its owner, no active
 * ProjectMember row, not a member of its host organization (Fizzy #2639). The
 * cross-tenant existence oracle is closed there, for every project procedure.
 *
 * This middleware is STRICTER: it asks `hasProjectAccess`, the "may you
 * discover" predicate, which has no org-role path. An organization member
 * with no ProjectMember row who did not create the project can act on it
 * through the gate's org-role fallback but cannot discover it, and here is
 * answered NOT_FOUND. A caller who can see the project, and lacks the
 * permission, still hears FORBIDDEN from the permission gate after this,
 * which is correct: they already know the project exists.
 *
 * It is opt-in, like `resolveUnambiguousOrganization`: a procedure composes it
 * ahead of its permission middleware when discovery, not just existence, is
 * the boundary it wants. The global `requireProjectPermission` keeps its
 * org-role fallback because it is also the bootstrap for every new
 * organization project (see that middleware's docblock).
 *
 * The name deliberately does not start with `require`: the permission-coverage
 * test counts any `require…(` call as a permission declaration, and this is
 * not one. A procedure using it still declares its permission separately.
 *
 * The procedure input must include `projectId: string`.
 */

import { ORPCError, os } from "@orpc/server";
import { hasProjectAccess } from "@repo/database";

/** What a missing project and an invisible one are both answered with. */
export const PROJECT_NOT_FOUND_MESSAGE = "Project not found";

type VisibilityContext = {
	user?: { id: string };
	tenantContext?: { userId: string | null };
};

export const projectNotFoundUnlessVisible = os
	.$context<VisibilityContext>()
	.middleware(async ({ context, next }, input: unknown) => {
		const projectId = (input as { projectId?: unknown } | undefined)
			?.projectId;
		if (typeof projectId !== "string" || projectId.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "projectId is required for project-scoped procedures",
			});
		}

		const userId =
			context.tenantContext?.userId ?? context.user?.id ?? null;
		if (!userId) {
			throw new ORPCError("UNAUTHORIZED");
		}

		// A hard boundary, never downgraded by RBAC_DRY_RUN: it decides what
		// the caller may learn exists, not what they may do.
		if (!(await hasProjectAccess(projectId, userId))) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		}
		return next();
	});
