import type { ActiveOrganization } from "../auth";

export function isOrganizationAdmin(
	organization?: ActiveOrganization | null,
	user?: {
		id: string;
		role?: string | null;
	} | null,
) {
	const userOrganizationRole = organization?.members.find(
		(member) => member.userId === user?.id,
	)?.role;

	return (
		["owner", "admin"].includes(userOrganizationRole ?? "") ||
		user?.role === "admin"
	);
}

// Note: unlike isOrganizationAdmin, system admins are NOT treated as org owners.
// Org ownership is intentionally scoped to actual org membership — a global
// system admin shouldn't auto-acquire owner-only abilities like ownership transfer.
export function isOrganizationOwner(
	organization?: ActiveOrganization | null,
	user?: {
		id: string;
	} | null,
) {
	const userOrganizationRole = organization?.members.find(
		(member) => member.userId === user?.id,
	)?.role;

	return userOrganizationRole === "owner";
}
