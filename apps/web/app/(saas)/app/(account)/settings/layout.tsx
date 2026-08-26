import { config } from "@repo/config";
import { getSession } from "@saas/auth/lib/server";
import { McpLogo } from "@saas/mcp/components/McpLogo";
import { SettingsLayoutClient } from "@saas/settings/components/SettingsLayoutClient";
import { SettingsSidebarLayout } from "@saas/settings/components/SettingsSidebarLayout";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { UserAvatar } from "@shared/components/UserAvatar";
import {
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
	SettingsIcon,
	SparklesIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { PropsWithChildren } from "react";
export default async function SettingsLayout({ children }: PropsWithChildren) {
	const t = await getTranslations();
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const menuItems = [
		{
			title: t("settings.menu.account.title"),
			avatar: (
				<UserAvatar
					name={session.user.name ?? ""}
					avatarUrl={session.user.image}
				/>
			),
			items: [
				{
					title: t("settings.menu.account.general"),
					href: "/app/settings/general",
					icon: <SettingsIcon className="size-4 opacity-50" />,
				},
				{
					title: t("settings.menu.account.security"),
					href: "/app/settings/security",
					icon: <LockKeyholeIcon className="size-4 opacity-50" />,
				},
				{
					title: "Notifications",
					href: "/app/settings/notifications",
					icon: <BellIcon className="size-4 opacity-50" />,
				},
				{
					title: "AI Providers",
					href: "/app/settings/ai-providers",
					icon: <BrainCircuitIcon className="size-4 opacity-50" />,
				},
				{
					title: "AI Models",
					href: "/app/settings/ai-models",
					icon: <SparklesIcon className="size-4 opacity-50" />,
				},
				{
					title: "AI Memory",
					href: "/app/settings/ai-memory",
					icon: <HistoryIcon className="size-4 opacity-50" />,
				},
				{
					title: "RAG Providers",
					href: "/app/settings/rag-providers",
					icon: <FileTextIcon className="size-4 opacity-50" />,
				},
				{
					title: "Search Providers",
					href: "/app/settings/search-providers",
					icon: <SearchIcon className="size-4 opacity-50" />,
				},
				{
					title: "MCP Registry",
					href: "/app/settings/mcp",
					icon: <McpLogo size={16} className="opacity-50" />,
				},
				{
					title: "OpenAPI Services",
					href: "/app/settings/openapi",
					icon: <LinkIcon className="size-4 opacity-50" />,
				},
				{
					title: "Agent Registry",
					href: "/app/settings/agents",
					icon: <RobotIcon className="size-4 opacity-50" />,
				},
				{
					title: "Prompts",
					href: "/app/settings/prompts",
					icon: <ScrollTextIcon className="size-4 opacity-50" />,
				},
				{
					title: "API Keys",
					href: "/app/settings/api-keys",
					icon: <KeyIcon className="size-4 opacity-50" />,
				},
				{
					title: t("settings.auditLog.menu.personal"),
					href: "/app/settings/audit-log",
					icon: <ScrollTextIcon className="size-4 opacity-50" />,
				},
				...(config.users.enableBilling
					? [
							{
								title: t("settings.menu.account.billing"),
								href: "/app/settings/billing",
								icon: (
									<CreditCardIcon className="size-4 opacity-50" />
								),
							},
						]
					: []),
				// AI Usage is read-only visibility (not billing), so it's
				// available regardless of the billing flag.
				{
					title: "AI Usage",
					href: "/app/settings/usage",
					icon: <BarChart3Icon className="size-4 opacity-50" />,
				},
				{
					title: t("settings.menu.account.dangerZone"),
					href: "/app/settings/danger-zone",
					icon: <TriangleAlertIcon className="size-4 opacity-50" />,
				},
			],
		},
	];

	return (
		<SettingsLayoutClient>
			<SettingsSidebarLayout menuItems={menuItems}>
				{children}
			</SettingsSidebarLayout>
		</SettingsLayoutClient>
	);
}
