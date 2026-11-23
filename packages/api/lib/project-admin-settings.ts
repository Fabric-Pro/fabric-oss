import { hasPermission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "./effective-project-permissions";

/**
 * Owner or PROJECT_SETTINGS_EDIT: needed for admin-only project settings such
 * as the Initiatives switch. As at the permission gate, an organization role
 * grants nothing on a project the caller cannot open.
 */
export async function canEditProjectAdminSettings(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	if (!access || access.isVisible === false) {
		return false;
	}
	return (
		access.source === "owner" ||
		hasPermission(access.permissions, Permissions.PROJECT_SETTINGS_EDIT)
	);
}
