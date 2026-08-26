import { UserList } from "@saas/admin/component/users/UserList";

/**
 * Workspace-scoped admin users page — `/app/{organizationSlug}/admin/users`.
 *
 * Mirror of the personal `(account)/admin/users/page.tsx`. Renders the same
 * platform-wide `UserList`; the org slug only keeps the admin in their current
 * workspace (the role guard lives in the parent admin layout).
 */
export default function OrganizationAdminUserPage() {
	return (
		<div>
			<UserList />
		</div>
	);
}
