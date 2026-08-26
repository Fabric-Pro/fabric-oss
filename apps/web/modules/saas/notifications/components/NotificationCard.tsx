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
 * Categories that have a chip label in `app.notifications.categories`.
 *
 * A whitelist rather than a dynamic `t(\`categories.${category}\`)` lookup:
 * next-intl surfaces a missing message by rendering the key path, which would
 * print a raw enum like `categories.SOMETHING_NEW` into the chip the moment
 * NotificationCategory grows. Membership here is checked before the lookup, so
 * every key passed to `t` is one that exists and anything unmapped degrades to
 * the SYSTEM label.
 *
 * `t.has()` would express this more directly, but nothing in the repo uses it
 * and every suite mocks `useTranslations` as a bare `(key) => key` with no
 * `.has` — adopting it here would force unrelated mock churn.
 */
const LABELLED_CATEGORIES = new Set([
	"MENTION",
	"REPLY",
	"ASSIGNMENT",
	"DECISION_OWNER_ASSIGNED",
	"DECISION_OWNER_UPDATED",
	"STATUS",
	"AGENT",
	"PROJECT",
	"SYSTEM",
	"BILLING",
	"CONTEXT_INDEXING_STARTED",
	"CONTEXT_INDEXING_COMPLETED",
	"SUBSCRIPTION",
	"PUBLISHING",
]);

/**
 * Stacked-card notification (#2117), modelled on Fizzy's `card--notification`.
 *
 * Fizzy's chip identifies the subject as `[card id | board]`. Fabric has 27
 * notification types across 11 categories and only some carry a project, so a
 * literal port would leave system, billing and account-scoped rows with an
 * empty chip. Instead the chip always leads with the category and appends the
 * most specific context available: project name, else organization name, else
 * nothing. It never shows a raw id.
 *
 * Structure ports from Fizzy; the styling does not — this uses Fabric's own
 * tokens rather than Fizzy's dark theme and 2px radius.
 */
export function NotificationCard({
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

	const category = LABELLED_CATEGORIES.has(notification.category)
		? t(`categories.${notification.category}`)
		: t("categories.SYSTEM");
	// Most specific context wins. Both are null for personal/system rows, and
	// the separator is only emitted when there is something to separate.
	const context = notification.projectName ?? notification.organizationName;

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
				className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
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
			<header className="flex items-center gap-2">
				<span
					data-testid="notification-card-chip"
					className={cn(
						"inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]",
						isUnread
							? "bg-primary/15 text-primary"
							: "bg-muted text-muted-foreground",
					)}
				>
					<Icon className="size-3 shrink-0" aria-hidden />
					<span className="truncate">
						{context ? `${category} · ${context}` : category}
					</span>
				</span>
				<span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
					{notification.actor?.name ? (
						<span className="max-w-[10ch] truncate">
							{notification.actor.name}
						</span>
					) : null}
					<span>
						{formatDistanceToNow(created, { addSuffix: true })}
					</span>
				</span>
				{trailing}
			</header>

			<div className="mt-2 flex items-start gap-3">
				{notification.actor ? (
					<UserAvatar
						className="size-8 shrink-0"
						name={notification.actor.name ?? "?"}
						avatarUrl={notification.actor.image}
					/>
				) : (
					<span
						data-testid="notification-card-icon-bubble"
						className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground"
					>
						<Icon className="size-4" />
					</span>
				)}
				<span className="min-w-0 flex-1">
					<span
						data-testid="notification-card-title"
						className={cn(
							// `break-words` alongside the clamp: line-clamp bounds the
							// HEIGHT but does not force a break inside one unbroken
							// run of characters, so a long token — a status-page URL in
							// an announcement is the realistic case — would overflow
							// the card's right edge at narrow widths.
							"block line-clamp-2 break-words text-sm",
							// Weight, not colour. The border and wash on the card are
							// both colour cues, so this is what carries AC-8 —
							// unread stays distinguishable without relying on hue.
							isUnread
								? "font-semibold text-foreground"
								: "text-muted-foreground",
						)}
					>
						{notification.title}
					</span>
					{notification.snippet ? (
						<span className="mt-1 block line-clamp-2 break-words text-xs text-muted-foreground">
							{notification.snippet}
						</span>
					) : null}
				</span>
			</div>
		</>
	);

	const baseClass = cn(
		"group block rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
		isUnread
			? "border-primary/40 bg-primary/[0.03]"
			: "border-border bg-card",
	);

	// Archived cards are not actionable — static container so the nested
	// Restore button doesn't violate the "no button-in-button" rule.
	if (mode === "archived") {
		return <div className={baseClass}>{content}</div>;
	}
	if (notification.link) {
		// Admin-only incident cards render as a Link for both roles so tab order
		// and affordance stay identical; the handler short-circuits non-admins.
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
		<button
			type="button"
			onClick={handleClick}
			className={cn(baseClass, "w-full")}
		>
			{content}
		</button>
	);
}
