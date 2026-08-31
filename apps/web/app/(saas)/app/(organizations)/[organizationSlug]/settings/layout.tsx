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
import { UserAvatar } from "@shared/components/UserAvatar";
import {
	ActivityIcon,
	BarChart3Icon,
	BellIcon,
	BrainCircuitIcon,
	CreditCardIcon,
	FileTextIcon,
	HistoryIcon,
	KeyIcon,
	LinkIcon,
	LockKeyholeIcon,
	ScrollTextIcon,
	SearchIcon,
	Settings2Icon,
	SettingsIcon,
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
		// Account-global settings that an organization member must still be able
		// to reach (Fizzy #1875, R7/R8). Both pages are properties of the
		// ACCOUNT, not of this organization — no organization is passed into
		// either, and nothing about them is scoped per tenant (R9).
		//
		// APPENDED, never prepended: SettingsMenu renders its compact sidebar
		// header from `menuItems[0].title` / `.avatar`, so putting this group
		// first would head an organization-owned page with the user's own name
		// and avatar. That stayed invisible while the organization group was the
		// only one here.
		//
		// Nested under `account/` rather than sitting at the top level beside
		// the organization's own pages. Two of the four would otherwise collide
		// outright — `general` is a profile here and an organization there,
		// `danger-zone` deletes an account here and an organization there — and
		// the collision is not merely a naming clash: a person who followed a
		// bookmark to delete their account would land on the page that deletes
		// the organization. The other two carry the same ambiguity more quietly,
		// so all four live in one place that says whose they are.
		{
			title: t("settings.menu.account.title"),
			avatar: (
				<UserAvatar
					name={session?.user?.name ?? ""}
					avatarUrl={session?.user?.image}
				/>
			),
			items: [
				{
					title: t("settings.menu.account.general"),
					href: `${organizationSettingsBasePath}/account/profile`,
					icon: <SettingsIcon className="size-4 opacity-50" />,
				},
				{
					title: t("settings.menu.account.security"),
					href: `${organizationSettingsBasePath}/account/security`,
					icon: <LockKeyholeIcon className="size-4 opacity-50" />,
				},
				{
					title: "Notifications",
					href: `${organizationSettingsBasePath}/account/notifications`,
					icon: <BellIcon className="size-4 opacity-50" />,
				},
				{
					title: t("settings.menu.account.dangerZone"),
					href: `${organizationSettingsBasePath}/account/danger-zone`,
					icon: <TriangleAlertIcon className="size-4 opacity-50" />,
				},
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
