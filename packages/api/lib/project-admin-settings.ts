import { hasPermission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "./effective-project-permissions";

/** Owner or PROJECT_SETTINGS_EDIT: needed for admin-only project settings such as the Initiatives switch. */
export async function canEditProjectAdminSettings(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	return (
		access?.source === "owner" ||
		(access != null &&
			hasPermission(
				access.permissions,
				Permissions.PROJECT_SETTINGS_EDIT,
			))
	);
}
