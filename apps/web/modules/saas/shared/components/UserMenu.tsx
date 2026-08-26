"use client";

import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { purgeUser } from "@saas/meeting-digest/lib/personal-insights-cache";
import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks";
import { ColorModeToggle } from "@saas/shared/components/ColorModeToggle";
import { UserAvatar } from "@shared/components/UserAvatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Building2Icon,
	HomeIcon,
	LogOutIcon,
	MoreVerticalIcon,
	SettingsIcon,
	ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function UserMenu({ showUserName }: { showUserName?: boolean }) {
	const t = useTranslations();
	const { user } = useSession();
	const { isOrgContext } = useOrganizationContext();
	const settingsPath = useContextPath("settings/general");
	// Keep the current workspace base on the admin link so a system admin stays
	// in their org (`/app/{slug}/admin`) rather than flipping to "Personal".
	const adminPath = useContextPath("admin");
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const onLogout = () => {
		authClient.signOut({
			fetchOptions: {
				onSuccess: async () => {
					// #2104: cached personal meeting summaries are user-keyed,
					// so another Fabric account cannot read them in-app — but
					// anyone with devtools could. Erasing on sign-out is the
					// difference between "scoped" and "gone". Runs before the
					// redirect, which tears this page down.
					if (user?.id) {
						purgeUser(user.id);
					}
					window.location.href = new URL(
						config.auth.redirectAfterLogout,
						window.location.origin,
					).toString();
				},
			},
		});
	};

	if (!user || !mounted) {
		return null;
	}

	const { name, email, image } = user;

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex min-w-0 cursor-pointer w-full items-center justify-between gap-2 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-primary md:px-2.5 md:py-2 md:hover:bg-muted/40 transition-colors"
					aria-label="User menu"
				>
					<span className="flex min-w-0 items-center gap-2">
						<UserAvatar name={name ?? ""} avatarUrl={image} />
						{showUserName && (
							<span className="min-w-0 text-left leading-tight">
								<span className="block truncate font-medium text-sm">
									{name}
								</span>
								<span className="block truncate text-xs opacity-70">
									{email}
								</span>
							</span>
						)}
					</span>

					{showUserName && (
						<MoreVerticalIcon className="size-4 shrink-0 text-foreground/50" />
					)}
				</button>
			</DropdownMenuTrigger>

			<DropdownMenuContent
				align="end"
				sideOffset={8}
				className="w-[270px] rounded-2xl border-border/70 bg-card/95 p-2 shadow-xl shadow-foreground/10"
			>
				<div className="flex items-center gap-3 rounded-xl bg-muted/35 p-3">
					<UserAvatar name={name ?? ""} avatarUrl={image} />
					<div className="min-w-0 leading-tight">
						<DropdownMenuLabel className="p-0 text-sm font-medium">
							{name}
						</DropdownMenuLabel>
						<span className="block truncate text-xs text-muted-foreground">
							{email}
						</span>
					</div>
				</div>

				{/* Color mode — inline toggle */}
				<DropdownMenuItem
					className="mt-2 flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 hover:bg-muted/50 focus:bg-muted/50 cursor-default"
					onSelect={(e) => e.preventDefault()}
				>
					<span className="text-sm text-foreground/85">
						{t("app.userMenu.colorMode")}
					</span>
					<ColorModeToggle />
				</DropdownMenuItem>

				<div className="my-2 h-px bg-border/60" />

				{/* Account Settings — only in personal context */}
				{!isOrgContext && (
					<DropdownMenuItem
						asChild
						className="rounded-xl px-3 py-2.5"
					>
						<Link href="/app/settings/general">
							<SettingsIcon className="mr-2 size-4 text-muted-foreground" />
							{t("app.userMenu.accountSettings")}
						</Link>
					</DropdownMenuItem>
				)}

				{/* Organization Settings — only in org context */}
				{isOrgContext && !config.organizations.hideOrganization && (
					<DropdownMenuItem
						asChild
						className="rounded-xl px-3 py-2.5"
					>
						<Link href={settingsPath}>
							<Building2Icon className="mr-2 size-4 text-muted-foreground" />
							{t("app.menu.organizationSettings")}
						</Link>
					</DropdownMenuItem>
				)}

				{user.role === "admin" && (
					<DropdownMenuItem
						asChild
						className="rounded-xl px-3 py-2.5"
					>
						<Link href={adminPath}>
							<ShieldCheckIcon className="mr-2 size-4 text-muted-foreground" />
							{t("app.menu.admin")}
						</Link>
					</DropdownMenuItem>
				)}

				<DropdownMenuItem asChild className="rounded-xl px-3 py-2.5">
					<Link href="/">
						<HomeIcon className="mr-2 size-4 text-muted-foreground" />
						{t("app.userMenu.home")}
					</Link>
				</DropdownMenuItem>

				<DropdownMenuItem
					onClick={onLogout}
					className="rounded-xl px-3 py-2.5 text-destructive focus:text-destructive"
				>
					<LogOutIcon className="mr-2 size-4" />
					{t("app.userMenu.logout")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
