"use client";

import { buttonVariants } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

// Notification preferences live only on the personal account (there is no
// org-scoped equivalent), so this always points at the hardcoded personal
// route — the same pattern `UserMenu`/`NavBar` use for `/app/settings/general`.
// This means the link resolves correctly even from an org/project context,
// which is what the tooltip hint clarifies to the user.
const NOTIFICATION_SETTINGS_PATH = "/app/settings/notifications";

/**
 * Shared "Notification Settings" entry point rendered on both the bell-dropdown
 * modal (`NotificationCenterPopover`) and the View All Notifications page
 * (`NotificationsPage`). Icon + visible label keeps it discoverable without
 * hover; the tooltip clarifies that it opens personal account settings.
 */
export function NotificationSettingsLink({
	className,
}: {
	className?: string;
}) {
	const t = useTranslations("app.notifications");
	const label = t("settings");

	// The `Tooltip` wrapper self-provides a `TooltipProvider` (500ms app-wide
	// default), so no outer provider is needed here.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Link
					href={NOTIFICATION_SETTINGS_PATH}
					aria-label={label}
					className={cn(
						buttonVariants({ variant: "ghost", size: "sm" }),
						"gap-1.5 text-xs text-muted-foreground",
						className,
					)}
				>
					<SettingsIcon className="size-4" aria-hidden="true" />
					<span>{label}</span>
				</Link>
			</TooltipTrigger>
			<TooltipContent>{t("settingsHint")}</TooltipContent>
		</Tooltip>
	);
}
