import { config } from "@repo/config";
import { getSession } from "@saas/auth/lib/server";
import { SettingsMenu } from "@saas/settings/components/SettingsMenu";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { PageHeader } from "@saas/shared/components/PageHeader";
import { SidebarContentLayout } from "@saas/shared/components/SidebarContentLayout";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { Logo } from "@shared/components/Logo";
import {
	ActivityIcon,
	BotMessageSquareIcon,
	Building2Icon,
	ScrollTextIcon,
	ToggleLeftIcon,
	TrendingUpIcon,
	UsersIcon,
} from "lucide-react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { PropsWithChildren } from "react";

/**
 * Workspace-scoped admin layout — `/app/{organizationSlug}/admin/*`.
 *
 * This is a mirror of the personal admin layout at `(account)/admin/layout.tsx`.
 * It exists so a system admin can use the entire Admin area (Users,
 * Organizations, Agent Registry, Monitoring, Audit Log Explorer) without the
 * URL dropping the org slug — the active workspace is derived purely from the
 * slug, so the slug-less `/app/admin/*` routes would flip the workspace
 * selector to "Personal". Keeping the slug leaves the admin in their current
 * organization workspace.
 *
 * The only difference from the personal layout is that the `SettingsMenu`
 * item hrefs keep the org slug (`/app/{slug}/admin/...`). Access control,
 * breadcrumbs, header, and the feature-flag gating of the Monitoring entry are
 * identical. The admin data itself is platform-wide (a system-admin signal
 * across all tenants); the slug only preserves "which workspace you're viewing
 * from", it does not scope the data.
 */
export default async function OrganizationAdminLayout({
	children,
	params,
}: PropsWithChildren<{ params: Promise<{ organizationSlug: string }> }>) {
	const { organizationSlug } = await params;
	const t = await getTranslations();
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app");
	}

	// Monitoring v2 admin dashboard is feature-flagged. The flag stays off in
	// v1 until SREs flip it on. Hidden from the sidebar when off; the page
	// itself also guards on the flag.
	const monitoringEnabled = isMonitoringFeatureEnabled(
		"feature-admin-monitoring-dashboard",
	);

	return (
		<>
			<TopRightControls />
			<div className="w-full pt-6">
				<PageBreadcrumbs
					items={[{ label: "Admin" }]}
					className="mb-6"
				/>
			</div>
			<PageHeader
				title={t("admin.title")}
				subtitle={t("admin.description")}
			/>
			<SidebarContentLayout
				sidebar={
					<SettingsMenu
						menuItems={[
							{
								avatar: <Logo className="size-8" />,
								title: t("admin.title"),
								items: [
									{
										title: t("admin.menu.users"),
										href: `/app/${organizationSlug}/admin/users`,
										icon: (
											<UsersIcon className="size-4 opacity-50" />
										),
									},
									...(config.organizations.enable
										? [
												{
													title: t(
														"admin.menu.organizations",
													),
													href: `/app/${organizationSlug}/admin/organizations`,
													icon: (
														<Building2Icon className="size-4 opacity-50" />
													),
												},
											]
										: []),
									{
										title: "Agent Registry",
										href: `/app/${organizationSlug}/admin/agents`,
										icon: (
											<BotMessageSquareIcon className="size-4 opacity-50" />
										),
									},
									{
										title: "Feature Flags",
										href: `/app/${organizationSlug}/admin/feature-flags`,
										icon: (
											<ToggleLeftIcon className="size-4 opacity-50" />
										),
									},
									{
										title: "AI Adoption",
										href: `/app/${organizationSlug}/admin/ai-adoption`,
										icon: (
											<TrendingUpIcon className="size-4 opacity-50" />
										),
									},
									...(monitoringEnabled
										? [
												{
													title: t(
														"admin.menu.monitoring",
													),
													href: `/app/${organizationSlug}/admin/monitoring`,
													icon: (
														<ActivityIcon className="size-4 opacity-50" />
													),
												},
											]
										: []),
									{
										title: t("admin.menu.auditLogExplorer"),
										href: `/app/${organizationSlug}/admin/audit-log-explorer`,
										icon: (
											<ScrollTextIcon className="size-4 opacity-50" />
										),
									},
								],
							},
						]}
					/>
				}
			>
				{children}
			</SidebarContentLayout>
		</>
	);
}
