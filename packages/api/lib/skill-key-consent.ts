import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";

/** New Skills scopes are consent ceilings; every use still checks current authority. */
export function requiresSkillKeyConsent(scopes: readonly string[]): boolean {
	return scopes.some((scope) =>
		["*", "skills:write", "skills:publish", "governance:write"].includes(
			scope,
		),
	);
}
export function refusedSkillKeyScopes(
	scopes: readonly string[],
	role?: string,
): string[] {
	const permissions = role ? resolveOrgPermissions(role) : [];
	const effective = scopes.includes("*")
		? ["skills:write", "skills:publish", "governance:write"]
		: scopes;
	return effective.filter((scope) => {
		if (scope === "skills:write") {
			return (
				!hasPermission(permissions, Permissions.SKILL_CREATE) ||
				!hasPermission(permissions, Permissions.SKILL_UPDATE)
			);
		}
		if (scope === "skills:publish") {
			return !hasPermission(permissions, Permissions.SKILL_UPDATE);
		}
		if (scope === "governance:write") {
			return (
				!role ||
				!["owner", "admin"].includes(role) ||
				!hasPermission(permissions, Permissions.ORG_UPDATE)
			);
		}
		return false;
	});
}
