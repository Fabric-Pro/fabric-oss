"use client";

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	useMarkAllNotificationsRead,
	useMarkNotificationsRead,
} from "../hooks/use-mark-read";
import { useStackedCardStyle } from "../hooks/use-notification-preferences";
import { useNotifications } from "../hooks/use-notifications";
import { NotificationListItem } from "./NotificationListItem";
import { NotificationSettingsLink } from "./NotificationSettingsLink";
import { NotificationsEmptyState } from "./NotificationsEmptyState";

type Tab = "all" | "unread" | "mentions";

export function NotificationCenterPopover() {
	const t = useTranslations("app.notifications");
	const [tab, setTab] = useState<Tab>("all");
	const status = tab === "unread" ? "unread" : "all";
	const category = tab === "mentions" ? "MENTION" : undefined;
	// Popover intentionally shows only the first page — no Load more here.
	// The full Notifications page paginates with a button.
	const { data, isLoading } = useNotifications({
		status,
		category,
		limit: 10,
	});
	const markRead = useMarkNotificationsRead();
	const markAllRead = useMarkAllNotificationsRead();
	const viewAllPath = useContextPath("notifications");
	const { stacked, isLoading: styleLoading } = useStackedCardStyle();

	const items = data?.pages[0]?.items ?? [];
	// Hold the skeleton until the style is known too (#2117).
	const showSkeleton = isLoading || styleLoading;

	return (
		<div className="flex max-h-[520px] w-full flex-col">
			<header className="flex items-center justify-between gap-2 border-b px-4 py-3">
				<div>
					<p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
						{t("sectionLabel")}
					</p>
					<h2 className="font-serif text-lg leading-tight text-foreground">
						{t("title")}
					</h2>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => markAllRead.mutate()}
					disabled={markAllRead.isPending}
					className="text-xs"
				>
					{t("markAllRead")}
				</Button>
			</header>

			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as Tab)}
				className="border-b"
			>
				<TabsList className="h-auto w-full justify-start gap-1 rounded-none bg-transparent px-3 py-2">
					<TabsTrigger value="all" className="text-xs">
						{t("tabs.all")}
					</TabsTrigger>
					<TabsTrigger value="unread" className="text-xs">
						{t("tabs.unread")}
					</TabsTrigger>
					<TabsTrigger value="mentions" className="text-xs">
						{t("tabs.mentions")}
					</TabsTrigger>
				</TabsList>
			</Tabs>

			<div className="flex-1 overflow-y-auto">
				{showSkeleton ? (
					<div className="space-y-2 p-3">
						<Skeleton className="h-14 w-full" />
						<Skeleton className="h-14 w-full" />
						<Skeleton className="h-14 w-full" />
					</div>
				) : items.length === 0 ? (
					<NotificationsEmptyState />
				) : (
					// Cards need breathing room and their own gaps; the compact
					// list keeps the edge-to-edge hairline dividers.
					<ul className={stacked ? "space-y-2 p-2" : "divide-y"}>
						{items.map((n) => (
							<li key={n.id}>
								<NotificationListItem
									notification={n}
									stacked={stacked}
									onSelect={(id) => markRead.mutate([id])}
								/>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* flex-wrap: the settings link is unshrinkable (buttonVariants sets
			    whitespace-nowrap + shrink-0), so in long locales / narrow sheets
			    it drops to its own row instead of clipping. */}
			<footer className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2">
				<Link
					href={viewAllPath}
					className="text-xs font-medium text-primary hover:underline"
				>
					{t("viewAll")}
				</Link>
				<NotificationSettingsLink />
			</footer>
		</div>
	);
}
