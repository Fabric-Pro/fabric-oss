import { FeatureFlagsPanel } from "@saas/admin/component/feature-flags/FeatureFlagsPanel";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

/**
 * Workspace-scoped feature-flag console — `/app/{organizationSlug}/admin/feature-flags`.
 *
 * The only route that renders FeatureFlagsPanel: `/app/admin/**` is now a
 * catch-all redirecting into the organization tree (Fizzy #1875), so the
 * slug-less console it used to mirror no longer exists. Keeping the slug
 * matters because the active workspace is derived purely from it.
 *
 * What this page sets is the DEPLOYMENT-WIDE value, and the slug does not
 * scope it — an admin viewing from any workspace edits the same rows. A flag
 * the registry marks `orgScopable` can also carry a per-organization override
 * that outranks this, edited on that organization's admin page
 * (`admin/organizations/{id}`) rather than here. Access control either way:
 * instance admin only.
 */
export const metadata = {
	title: "Feature Flags",
	description:
		"Admin console for the DB-backed feature-flag overrides — resolved value and source per flag.",
};

export default async function OrganizationFeatureFlagsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app");
	}

	return <FeatureFlagsPanel />;
}
