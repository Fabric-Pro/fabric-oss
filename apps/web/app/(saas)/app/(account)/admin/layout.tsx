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

export default async function AdminLayout({ children }: PropsWithChildren) {
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
										href: "/app/admin/users",
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
													href: "/app/admin/organizations",
													icon: (
														<Building2Icon className="size-4 opacity-50" />
													),
												},
											]
										: []),
									{
										title: "Agent Registry",
										href: "/app/admin/agents",
										icon: (
											<BotMessageSquareIcon className="size-4 opacity-50" />
										),
									},
									{
										title: "Feature Flags",
										href: "/app/admin/feature-flags",
										icon: (
											<ToggleLeftIcon className="size-4 opacity-50" />
										),
									},
									{
										title: "AI Adoption",
										href: "/app/admin/ai-adoption",
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
													href: "/app/admin/monitoring",
													icon: (
														<ActivityIcon className="size-4 opacity-50" />
													),
												},
											]
										: []),
									{
										title: t("admin.menu.auditLogExplorer"),
										href: "/app/admin/audit-log-explorer",
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
