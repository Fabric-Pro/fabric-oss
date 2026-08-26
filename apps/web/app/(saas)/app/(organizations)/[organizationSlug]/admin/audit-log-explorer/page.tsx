/**
 * Workspace-scoped admin audit-log explorer —
 * `/app/{organizationSlug}/admin/audit-log-explorer`.
 *
 * Mirror of the personal `(account)/admin/audit-log-explorer/page.tsx`. Lets
 * Fabric staff query a customer's audit log via the customer's own `org_*` /
 * `fab_*` API key (see the personal route for the full data-flow notes). The
 * org slug only keeps the admin in their current workspace; it does not scope
 * the cross-tenant read.
 *
 * Server-side gates (re-asserted here as defense-in-depth alongside the parent
 * admin layout):
 *   - Session required (redirect to /auth/login otherwise).
 *   - System-admin role required (redirect to /app otherwise).
 *
 * The page is a Server Component shell; the explorer interaction lives in the
 * Client Component `AuditLogExplorer`.
 */
import { AuditLogExplorer } from "@saas/admin/component/audit-log-explorer/AuditLogExplorer";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Audit Log Explorer",
	description:
		"Admin audit-log explorer — query a customer's audit log via their API key for cross-tenant forensic dogfooding.",
};

export default async function OrganizationAdminAuditLogExplorerPage() {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	if (session.user?.role !== "admin") {
		redirect("/app");
	}
	return <AuditLogExplorer />;
}
