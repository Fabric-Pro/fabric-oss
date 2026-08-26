import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

/**
 * Workspace-scoped admin index — `/app/{organizationSlug}/admin`.
 *
 * The admin area has no standalone landing screen; the first menu entry is
 * Users. Both the NavBar and the UserMenu "Admin" links target this bare
 * `/app/{slug}/admin` path (kept slug-ful so the workspace selector stays on
 * the current org), so this redirects to the Users sub-page — the canonical
 * admin entry point — while preserving the org slug.
 *
 * Re-asserts the system-admin guard (defense-in-depth alongside the parent
 * admin layout) before redirecting.
 */
export default async function OrganizationAdminIndexPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	if (session.user?.role !== "admin") {
		redirect("/app");
	}
	redirect(`/app/${organizationSlug}/admin/users`);
}
