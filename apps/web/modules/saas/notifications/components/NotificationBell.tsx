"use client";

import { useIsMobile } from "@shared/hooks/use-is-mobile";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetTrigger,
} from "@ui/components/sheet";
import { BellIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useNotificationUnreadCount } from "../hooks/use-notification-unread-count";
import { NotificationCenterPopover } from "./NotificationCenterPopover";

export function NotificationBell({
	variant = "desktop",
}: {
	variant?: "desktop" | "mobile";
}) {
	const t = useTranslations("app.notifications");
	const { data } = useNotificationUnreadCount();
	const isMobile = useIsMobile();
	const count = data?.count ?? 0;
	const label = count > 0 ? t("unreadLabel", { count }) : t("openLabel");

	const trigger = (
		<Button
			variant="ghost"
			size="icon"
			aria-label={label}
			className="relative"
		>
			<BellIcon className="size-5" />
			{count > 0 ? (
				<Badge
					variant="default"
					className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none"
				>
					{count > 99 ? "99+" : count}
				</Badge>
			) : null}
		</Button>
	);

	if (isMobile) {
		return (
			<Sheet>
				<SheetTrigger asChild>{trigger}</SheetTrigger>
				<SheetContent
					side="right"
					className="w-full max-w-sm p-0 sm:max-w-md"
				>
					<SheetTitle className="sr-only">{t("title")}</SheetTitle>
					<NotificationCenterPopover />
				</SheetContent>
			</Sheet>
		);
	}

	return (
		<Popover>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={variant === "mobile" ? 8 : 12}
				className="w-[380px] p-0"
			>
				<NotificationCenterPopover />
			</PopoverContent>
		</Popover>
	);
}
