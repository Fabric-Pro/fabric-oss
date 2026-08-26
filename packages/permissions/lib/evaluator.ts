import type { Permission } from "./permissions";

/**
 * Check whether a granted permission set includes the required permission.
 * Pure function — callers resolve the granted set before calling.
 */
export function hasPermission(
	granted: readonly Permission[],
	required: Permission,
): boolean {
	return granted.includes(required);
}

/**
 * Check whether a granted permission set includes ALL required permissions.
 */
export function hasAllPermissions(
	granted: readonly Permission[],
	required: readonly Permission[],
): boolean {
	return required.every((p) => granted.includes(p));
}

/**
 * Check whether a granted permission set includes ANY of the required permissions.
 */
export function hasAnyPermission(
	granted: readonly Permission[],
	required: readonly Permission[],
): boolean {
	return required.some((p) => granted.includes(p));
}
