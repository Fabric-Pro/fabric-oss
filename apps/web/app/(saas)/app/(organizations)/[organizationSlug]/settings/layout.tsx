import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { config } from "@repo/config";
import {
	getActiveOrganization,
	getSession,
	isGuestInOrg,
} from "@saas/auth/lib/server";
import { McpLogo } from "@saas/mcp/components/McpLogo";
import { OrganizationLogo } from "@saas/organizations/components/OrganizationLogo";
import { OrgSettingsLayoutClient } from "@saas/settings/components/OrgSettingsLayoutClient";
import { SettingsSidebarLayout } from "@saas/settings/components/SettingsSidebarLayout";
import { isDeploymentAdminEmail } from "@saas/settings/lib/deployment-admin";
import { isUserActivityDashboardEnabled } from "@saas/settings/lib/user-activity-flag";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import {
	ActivityIcon,
	BarChart3Icon,
	BrainCircuitIcon,
	CreditCardIcon,
	FileTextIcon,
	HistoryIcon,
	KeyIcon,
	LinkIcon,
	ScrollTextIcon,
	SearchIcon,
	Settings2Icon,
	SparklesIcon,
	TriangleAlertIcon,
	Users2Icon,
} from "lucide-react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { PropsWithChildren } from "react";

export default async function SettingsLayout({
	children,
	params,
}: PropsWithChildren<{
	params: Promise<{ organizationSlug: string }>;
}>) {
	const t = await getTranslations();
	const session = await getSession();
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// Guests (users with project-only access) cannot view org settings.
	if (session?.user) {
		const guest = await isGuestInOrg(session.user.id, organization.id);
		if (guest) {
			redirect(`/app/${organizationSlug}`);
		}
	}

	const userIsOrganizationAdmin = isOrganizationAdmin(
		organization,
		session?.user,
	);
	// Deployment admins (emails in FABRIC_DEPLOYMENT_ADMIN_EMAILS) see
	// the Audit Log entry regardless of membership so a Fabric SRE can
	// diagnose any tenant on a deployed instance. The raw env value
	// never leaves the server.
	const isDeploymentAdmin = isDeploymentAdminEmail(
		session?.user?.email ?? null,
	);

	const organizationSettingsBasePath = `/app/${organizationSlug}/settings`;

	// All menu items are visible to all members
	// Individual pages handle read-only mode for non-admins
	const menuItems = [
		{
			title: organization.name,
			avatar: (
				<OrganizationLogo
					name={organization.name}
					logoUrl={organization.logo}
				/>
			),
			items: [
				{
					title: t("settings.menu.organization.general"),
					href: `${organizationSettingsBasePath}/general`,
					icon: <Settings2Icon className="size-4 opacity-50" />,
				},
				{
					title: t("settings.menu.organization.members"),
					href: `${organizationSettingsBasePath}/members`,
					icon: <Users2Icon className="size-4 opacity-50" />,
				},
				{
					title: "AI Providers",
					href: `${organizationSettingsBasePath}/ai-providers`,
					icon: <BrainCircuitIcon className="size-4 opacity-50" />,
				},
				{
					title: "AI Models",
					href: `${organizationSettingsBasePath}/ai-models`,
					icon: <SparklesIcon className="size-4 opacity-50" />,
				},
				{
					title: "AI Memory",
					href: `${organizationSettingsBasePath}/ai-memory`,
					icon: <HistoryIcon className="size-4 opacity-50" />,
				},
				{
					title: "RAG Providers",
					href: `${organizationSettingsBasePath}/rag-providers`,
					icon: <FileTextIcon className="size-4 opacity-50" />,
				},
				{
					title: "Search Providers",
					href: `${organizationSettingsBasePath}/search-providers`,
					icon: <SearchIcon className="size-4 opacity-50" />,
				},
				{
					title: "MCP Registry",
					href: `${organizationSettingsBasePath}/mcp`,
					icon: <McpLogo size={16} className="opacity-50" />,
				},
				{
					title: "OpenAPI Services",
					href: `${organizationSettingsBasePath}/openapi`,
					icon: <LinkIcon className="size-4 opacity-50" />,
				},
				{
					title: "Agent Registry",
					href: `${organizationSettingsBasePath}/agents`,
					icon: <RobotIcon className="size-4 opacity-50" />,
				},
				{
					title: "Prompts",
					href: `${organizationSettingsBasePath}/prompts`,
					icon: <ScrollTextIcon className="size-4 opacity-50" />,
				},
				{
					title: "API Keys",
					href: `${organizationSettingsBasePath}/api-keys`,
					icon: <KeyIcon className="size-4 opacity-50" />,
				},
				// Audit Log is visible to owners, admins, and deployment
				// admins (the env-list SRE bypass). Members and viewers
				// don't see the entry; direct URL access is blocked by
				// the procedure middleware.
				...(userIsOrganizationAdmin || isDeploymentAdmin
					? [
							{
								title: t("settings.auditLog.menu.organization"),
								href: `${organizationSettingsBasePath}/audit-log`,
								icon: (
									<ScrollTextIcon className="size-4 opacity-50" />
								),
							},
						]
					: []),
				// User Activity dashboard — same visibility rule
				// as Audit Log (owners/admins + deployment admins), plus the
				// FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD kill switch.
				...((userIsOrganizationAdmin || isDeploymentAdmin) &&
				isUserActivityDashboardEnabled()
					? [
							{
								title: "User Activity",
								href: `${organizationSettingsBasePath}/user-activity`,
								icon: (
									<ActivityIcon className="size-4 opacity-50" />
								),
							},
						]
					: []),
				...(config.organizations.enable &&
				config.organizations.enableBilling
					? [
							{
								title: t("settings.menu.organization.billing"),
								href: `${organizationSettingsBasePath}/billing`,
								icon: (
									<CreditCardIcon className="size-4 opacity-50" />
								),
							},
						]
					: []),
				// AI Usage is read-only visibility (not billing), so it's
				// available even when org billing is disabled. The page
				// itself enforces admin permission.
				{
					title: "AI Usage",
					href: `${organizationSettingsBasePath}/usage`,
					icon: <BarChart3Icon className="size-4 opacity-50" />,
				},
				// Danger Zone is admin-only (not just read-only)
				...(userIsOrganizationAdmin
					? [
							{
								title: t(
									"settings.menu.organization.dangerZone",
								),
								href: `${organizationSettingsBasePath}/danger-zone`,
								icon: (
									<TriangleAlertIcon className="size-4 opacity-50" />
								),
							},
						]
					: []),
			],
		},
	];

	return (
		<OrgSettingsLayoutClient
			organizationSlug={organizationSlug}
			organizationName={organization.name}
		>
			<SettingsSidebarLayout menuItems={menuItems}>
				{children}
			</SettingsSidebarLayout>
		</OrgSettingsLayoutClient>
	);
}
