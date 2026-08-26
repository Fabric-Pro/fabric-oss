"use client";

import { UserAvatar } from "@shared/components/UserAvatar";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import { XIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
	type NotificationRowProps,
	useNotificationRow,
} from "../hooks/use-notification-row";

/**
 * Compact notification row — the default presentation, and the one the app has
 * always shipped. The stacked-card alternative lives in `NotificationCard`
 * (#2117); `NotificationListItem` picks between them.
 *
 * Markup here is deliberately unchanged from the original single-component
 * implementation, so the existing test suite keeps guarding it verbatim.
 */
export function NotificationRow({
	notification,
	onSelect,
	onArchive,
	onRestore,
	mode = "default",
}: NotificationRowProps) {
	const t = useTranslations("app.notifications");
	const {
		Icon,
		targetPath,
		isUnread,
		created,
		isAdminOnlyType,
		shouldBlockAdminLink,
		handleClick,
		handleAdminGatedClick,
	} = useNotificationRow(notification, onSelect);

	// Archived rows surface a Restore button. Active rows surface a
	// hover-revealed X (also revealed by keyboard focus-visible for a11y).
	const trailing =
		mode === "archived" && onRestore ? (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={t("restore")}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onRestore(notification.id);
				}}
			>
				{t("restore")}
			</Button>
		) : onArchive ? (
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
				aria-label={t("dismiss")}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onArchive(notification.id);
				}}
			>
				<XIcon className="size-4" />
			</Button>
		) : null;

	const content = (
		<>
			{isUnread ? (
				<span
					role="img"
					aria-label={t("unreadIndicator")}
					className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
				/>
			) : (
				<span aria-hidden className="mt-1.5 size-1.5 shrink-0" />
			)}
			{notification.actor ? (
				<span className="relative shrink-0">
					<UserAvatar
						className="size-8"
						name={notification.actor.name ?? "?"}
						avatarUrl={notification.actor.image}
					/>
					<span
						aria-hidden
						data-testid="notification-category-badge"
						className={cn(
							"absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border border-card",
							isUnread
								? "bg-primary text-primary-foreground"
								: "bg-muted text-muted-foreground",
						)}
					>
						<Icon className="size-2.5" />
					</span>
				</span>
			) : (
				<span
					data-testid="notification-icon-bubble"
					className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground"
				>
					<Icon className="size-4" />
				</span>
			)}
			<span className="min-w-0 flex-1">
				<span
					className={cn(
						"block truncate text-sm",
						isUnread
							? "font-medium text-foreground"
							: "text-muted-foreground",
					)}
				>
					{notification.title}
				</span>
				{notification.snippet ? (
					<span className="mt-0.5 block truncate text-xs text-muted-foreground">
						{notification.snippet}
					</span>
				) : null}
				<span className="mt-1 block text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
					{formatDistanceToNow(created, { addSuffix: true })}
				</span>
			</span>
			{trailing ? (
				<span className="ml-2 shrink-0">{trailing}</span>
			) : null}
		</>
	);

	const baseClass =
		"group flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:bg-muted/40";

	// Archived rows are not actionable — they render as a static row so the
	// nested Restore button doesn't violate the "no button-in-button" rule.
	if (mode === "archived") {
		return <div className={baseClass}>{content}</div>;
	}
	if (notification.link) {
		// Admin-only incident rows are always rendered as a Link (with the
		// click handler short-circuiting non-admins) so the keyboard tab order
		// and the visual affordance stay identical for both roles. The toast
		// surfaces the role gap explicitly instead of silently turning the row
		// into a no-op.
		return (
			<Link
				href={targetPath}
				className={baseClass}
				onClick={isAdminOnlyType ? handleAdminGatedClick : handleClick}
				aria-disabled={shouldBlockAdminLink || undefined}
				data-admin-only={isAdminOnlyType ? "true" : undefined}
			>
				{content}
			</Link>
		);
	}
	return (
		<button type="button" onClick={handleClick} className={baseClass}>
			{content}
		</button>
	);
}
