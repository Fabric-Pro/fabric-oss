/**
 * Personal-context system health page.
 *
 * Deliberately NOT admin-gated: the whole purpose of this surface is that a
 * customer can answer "is this problem mine or theirs" without opening a
 * support ticket. The tenant-scoped parts of the response (their own failure
 * rate, their own connections) are resolved from the session by the procedure.
 */

import { getSession } from "@saas/auth/lib/server";
import { SystemHealthPage } from "@saas/system-health/components/SystemHealthPage";
import { redirect } from "next/navigation";

export const metadata = {
	title: "System health",
	description: "Live platform status for your workspace",
};

export default async function AccountSystemHealthPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return <SystemHealthPage />;
}
