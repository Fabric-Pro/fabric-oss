/**
 * Which organization a Living Memory repository-sync procedure acts in, and
 * what the caller may see of it (design 2026-09-23 §5.1).
 *
 * Every procedure composes `projectNotFoundUnlessVisible` (a project the
 * caller cannot discover is NOT_FOUND, before any permission is evaluated)
 * and then `requireProjectPermission`. This resolves the SAME effective
 * permissions the gate did, for two things the gate does not publish onto
 * the context: the project's HOSTING organization — never a caller-supplied
 * `organizationId`, nor the session's active one, which for a member of
 * several organizations need not be the project's — and whether the caller
 * could configure (for `get`, which shows integrations only to them). It
 * refuses on the gate's own terms, so the two can never disagree.
 *
 * A personal project (`organizationId: null`) is FORBIDDEN: the sync is
 * organization-scoped (its rows require an organization), and the null arm
 * is fail-closed, never a second tenancy branch.
 */
import { ORPCError } from "@orpc/client";
import { hasPermission, type Permission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../../../lib/effective-project-permissions";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../../../orpc/middleware/project-visibility";

export async function resolveContextSyncAccess(
	projectId: string,
	userId: string,
	required: Permission,
): Promise<{ organizationId: string; canConfigure: boolean }> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	if (!access) {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}
	const holds = (permission: Permission) =>
		access.source === "owner" ||
		hasPermission(access.permissions, permission);
	if (!holds(required)) {
		throw new ORPCError("FORBIDDEN", {
			message: `Missing required permission: ${required}`,
		});
	}
	if (!access.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Repository sync requires an organization project",
		});
	}
	return {
		organizationId: access.organizationId,
		canConfigure: holds(Permissions.CONTEXT_CREATE),
	};
}
