/**
 * Admin audit-log explorer route — `/app/admin/audit-log-explorer`.
 *
 * Lets Fabric staff query a customer's audit log via the customer's own
 * `org_*` / `fab_*` API key. The customer-facing data is fetched through
 * the `admin.auditLog.viaApiKey` oRPC procedure (server-side proxy), which
 * also emits an `admin.auditLog.viaApiKey` audit row of its own to capture
 * the staff-initiated cross-tenant read.
 *
 * Server-side gates:
 *   - Session required (redirect to /auth/login otherwise).
 *   - System-admin role required (redirect to /app otherwise).
 *
 * The page itself is a Server Component shell; the explorer interaction
 * lives in the Client Component `AuditLogExplorer`.
 */
import { AuditLogExplorer } from "@saas/admin/component/audit-log-explorer/AuditLogExplorer";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Audit Log Explorer",
	description:
		"Admin audit-log explorer — query a customer's audit log via their API key for cross-tenant forensic dogfooding.",
};

export default async function AdminAuditLogExplorerPage() {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	if (session.user?.role !== "admin") {
		redirect("/app");
	}
	return <AuditLogExplorer />;
}
