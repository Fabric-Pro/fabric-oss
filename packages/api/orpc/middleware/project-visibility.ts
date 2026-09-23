/**
 * Answer NOT_FOUND for a project the caller cannot see, before any permission
 * is evaluated, and in exactly the words an id that names no project gets.
 *
 * ## Why this runs first
 *
 * `requireProjectPermission` answers two different ways for the two ways a
 * caller can be kept out of a project. An id that names no project is
 * NOT_FOUND. A project that exists, in an organization the caller does not
 * belong to, resolves through `resolveEffectiveProjectPermissions` to no
 * permissions and is refused FORBIDDEN. So the permission gate alone tells
 * anyone who can authenticate which project ids are real in organizations
 * they have no part in. That is an existence oracle across tenants.
 *
 * Asking `hasProjectAccess` (the "may you discover" predicate) first closes it.
 * A project the caller cannot see is NOT_FOUND, with the same message as a
 * missing one. A caller who can see the project, and lacks the permission,
 * still hears FORBIDDEN from the permission gate after this, which is correct:
 * they already know the project exists.
 *
 * It is opt-in, like `resolveUnambiguousOrganization`: a procedure composes it
 * ahead of its permission middleware, and nothing else changes. The global
 * `requireProjectPermission` keeps its shape because it serves procedures
 * whose callers are allowed to act on projects `hasProjectAccess` hides from
 * them (the org-role fallback; see that middleware's docblock).
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
