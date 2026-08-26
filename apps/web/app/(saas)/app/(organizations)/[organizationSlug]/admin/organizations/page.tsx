import { OrganizationList } from "@saas/admin/component/organizations/OrganizationList";

/**
 * Workspace-scoped admin organizations list —
 * `/app/{organizationSlug}/admin/organizations`.
 *
 * Mirror of the personal `(account)/admin/organizations/page.tsx`. The
 * `OrganizationList` client component builds its row/edit/create links with the
 * workspace-aware `useAdminPath()` helper, so they keep the org slug and don't
 * bounce the admin back to the personal workspace.
 */
export default function OrganizationAdminOrganizationsPage() {
	return <OrganizationList />;
}
