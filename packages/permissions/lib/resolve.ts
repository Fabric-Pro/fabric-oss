import type { Permission } from "./permissions";
import {
	ORG_ROLE_PERMISSIONS,
	type OrgRole,
	PROJECT_ROLE_PERMISSIONS,
	type ProjectRole,
} from "./roles";

const EMPTY: readonly Permission[] = Object.freeze([]);

/**
 * Resolve the permission set granted to an org member by their org role.
 * Returns empty set for null/undefined role.
 */
export function resolveOrgPermissions(
	role: OrgRole | string | null | undefined,
): readonly Permission[] {
	if (!role) {
		return EMPTY;
	}
	return ORG_ROLE_PERMISSIONS[role as OrgRole] ?? EMPTY;
}

/**
 * Resolve the permission set granted to a project member by their project role.
 * Returns empty set for null/undefined role.
 */
export function resolveProjectPermissions(
	role: ProjectRole | string | null | undefined,
): readonly Permission[] {
	if (!role) {
		return EMPTY;
	}
	return PROJECT_ROLE_PERMISSIONS[role as ProjectRole] ?? EMPTY;
}
