import { FeatureFlagsPanel } from "@saas/admin/component/feature-flags/FeatureFlagsPanel";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Feature Flags",
	description:
		"Admin console for the DB-backed feature-flag overrides — resolved value and source per flag.",
};

export default async function FeatureFlagsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app");
	}

	return <FeatureFlagsPanel />;
}
