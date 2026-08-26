/**
 * Organization-context system health page.
 *
 * Same component as the personal route — the tenant is resolved from the
 * session's active organization by the procedure, so the two routes cannot drift
 * in what they show. Any authenticated member of the organization may view it;
 * membership itself is what the active-organization session field encodes.
 */

import { getSession } from "@saas/auth/lib/server";
import { SystemHealthPage } from "@saas/system-health/components/SystemHealthPage";
import { redirect } from "next/navigation";

export const metadata = {
	title: "System health",
	description: "Live platform status for your workspace",
};

export default async function OrganizationSystemHealthPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return <SystemHealthPage />;
}
