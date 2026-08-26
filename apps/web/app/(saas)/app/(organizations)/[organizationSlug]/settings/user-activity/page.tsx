/**
 * Org-scoped User Activity dashboard page.
 *
 * Server component. Mirrors the audit-log page: resolves the org,
 * requires owner/admin membership or deployment-admin (env-list bypass),
 * and 404s when the FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD kill switch
 * is off. Non-admins navigating directly see a forbidden panel; the
 * procedures enforce the same gate server-side regardless.
 */
import { getOrganizationMembership } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { UserActivityView } from "@saas/settings/components/user-activity/UserActivityView";
import { isDeploymentAdminEmail } from "@saas/settings/lib/deployment-admin";
import { isUserActivityDashboardEnabled } from "@saas/settings/lib/user-activity-flag";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { Card, CardContent } from "@ui/components/card";
import { XIcon } from "lucide-react";
import { notFound } from "next/navigation";

export const metadata = {
	title: "User Activity",
	description: "Member last-active and sign-in history",
};

export default async function OrganizationUserActivityPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	if (!isUserActivityDashboardEnabled()) {
		return notFound();
	}

	const { organizationSlug } = await params;
	const [session, organization] = await Promise.all([
		getSession(),
		getActiveOrganization(organizationSlug),
	]);

	if (!organization) {
		return notFound();
	}

	const userId = session?.user?.id;
	const membership = userId
		? await getOrganizationMembership(organization.id, userId)
		: null;
	const role = membership?.role ?? null;
	const isAdminOrOwner = role === "owner" || role === "admin";
	const isDeploymentAdmin = isDeploymentAdminEmail(
		session?.user?.email ?? null,
	);

	if (!(isAdminOrOwner || isDeploymentAdmin)) {
		return (
			<>
				<SettingsHero
					title="User Activity"
					label="Organization"
					description="Only organization admins can view member activity."
				/>
				<Card className="border-destructive/30 bg-destructive/5">
					<CardContent className="flex flex-col items-start gap-3 p-6">
						<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
							<XIcon className="size-4" />
							Access restricted
						</div>
						<p className="max-w-2xl text-sm text-muted-foreground">
							You need the organization admin or owner role to
							view member activity.
						</p>
					</CardContent>
				</Card>
			</>
		);
	}

	return (
		<>
			<SettingsHero
				title="User Activity"
				label="Organization"
				description="When members last used Fabric, and how often they sign in. Sessions last 30 days, so sign-ins are rare even for daily users — read 'Last active' for engagement. History starts when audit logging was enabled for this deployment."
			/>
			<SettingsList>
				<UserActivityView organizationId={organization.id} />
			</SettingsList>
		</>
	);
}
