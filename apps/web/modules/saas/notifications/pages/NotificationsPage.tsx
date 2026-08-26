"use client";

import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { NotificationListItem } from "../components/NotificationListItem";
import { NotificationSettingsLink } from "../components/NotificationSettingsLink";
import { NotificationsEmptyState } from "../components/NotificationsEmptyState";
import {
	useArchiveNotifications,
	useRestoreNotifications,
} from "../hooks/use-archive";
import {
	useMarkAllNotificationsRead,
	useMarkNotificationsRead,
} from "../hooks/use-mark-read";
import { useStackedCardStyle } from "../hooks/use-notification-preferences";
import {
	type NotificationsListInput,
	useNotifications,
} from "../hooks/use-notifications";

type Tab = "all" | "unread" | "mentions" | "inbound" | "conflict" | "archived";

// AC-10 scaffold. "conflict items" maps cleanly to PM_SYNC_CONFLICT; "inbound
// updates" collects status/assignment changes coming to you. The "drift
// tickets" tab is intentionally deferred — no drift notification type exists
// yet (it depends on the AI Merge feature).
const TAB_TYPES: Partial<Record<Tab, NotificationsListInput["types"]>> = {
	inbound: ["STORY_STATUS_CHANGED", "STORY_ASSIGNED"],
	conflict: ["PM_SYNC_CONFLICT"],
};

export function NotificationsPage() {
	const t = useTranslations("app.notifications");
	const [tab, setTab] = useState<Tab>("all");
	const status =
		tab === "unread" ? "unread" : tab === "archived" ? "archived" : "all";
	const category = tab === "mentions" ? "MENTION" : undefined;
	const types = TAB_TYPES[tab];
	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useNotifications({
			status,
			category,
			types,
			limit: 50,
		});
	const markRead = useMarkNotificationsRead();
	const markAllRead = useMarkAllNotificationsRead();
	const archive = useArchiveNotifications();
	const restore = useRestoreNotifications();
	const { stacked, isLoading: styleLoading } = useStackedCardStyle();

	const items = data?.pages.flatMap((p) => p.items) ?? [];
	// Hold the skeleton until the style is known too, so an opted-in reader
	// never watches compact rows repaint into cards (#2117).
	const showSkeleton = isLoading || styleLoading;

	// Archive triggers a toast with an Undo affordance. The cache
	// invalidation in `useArchiveNotifications`/`useRestoreNotifications`
	// handles the optimistic removal/restoration of the row.
	const handleArchive = (id: string) => {
		archive.mutate([id], {
			onSuccess: () => {
				toast(t("archivedToast"), {
					action: {
						label: t("undo"),
						onClick: () => restore.mutate([id]),
					},
				});
			},
		});
	};

	const handleRestore = (id: string) => {
		restore.mutate([id]);
	};

	return (
		<div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
			{/* Stacks on phones: the title plus two rigid buttons (buttonVariants
			    sets whitespace-nowrap + shrink-0) exceed a 375px viewport in a
			    single row. sm+ restores the original side-by-side layout. */}
			<header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
				<div>
					<p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
						{t("sectionLabel")}
					</p>
					<h1 className="font-serif text-3xl text-foreground">
						{t("title")}
					</h1>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{tab !== "archived" ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => markAllRead.mutate()}
							disabled={markAllRead.isPending}
						>
							{t("markAllRead")}
						</Button>
					) : null}
					<NotificationSettingsLink />
				</div>
			</header>

			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as Tab)}
				className="mb-4"
			>
				<TabsList>
					<TabsTrigger value="all">{t("tabs.all")}</TabsTrigger>
					<TabsTrigger value="unread">{t("tabs.unread")}</TabsTrigger>
					<TabsTrigger value="inbound">
						{t("tabs.inbound")}
					</TabsTrigger>
					<TabsTrigger value="conflict">
						{t("tabs.conflict")}
					</TabsTrigger>
					<TabsTrigger value="mentions">
						{t("tabs.mentions")}
					</TabsTrigger>
					<TabsTrigger value="archived">
						{t("tabs.archived")}
					</TabsTrigger>
				</TabsList>
			</Tabs>

			{/* Stacked cards are self-contained surfaces, so the shared outer
			    card frame and hairline dividers come off — they would double the
			    borders. The compact list keeps both. */}
			<div
				className={cn(
					stacked ? "" : "overflow-hidden rounded-lg border bg-card",
				)}
			>
				{showSkeleton ? (
					<div className="space-y-2 p-4">
						<Skeleton className="h-14 w-full" />
						<Skeleton className="h-14 w-full" />
						<Skeleton className="h-14 w-full" />
					</div>
				) : items.length === 0 ? (
					<NotificationsEmptyState />
				) : (
					<>
						<ul className={stacked ? "space-y-2" : "divide-y"}>
							{items.map((n) => (
								<li key={n.id}>
									<NotificationListItem
										notification={n}
										stacked={stacked}
										onSelect={(id) => markRead.mutate([id])}
										onArchive={
											tab === "archived"
												? undefined
												: handleArchive
										}
										onRestore={
											tab === "archived"
												? handleRestore
												: undefined
										}
										mode={
											tab === "archived"
												? "archived"
												: "default"
										}
									/>
								</li>
							))}
						</ul>
						{hasNextPage ? (
							// The divider and card fill belong to the framed
							// compact list; a stacked list has no frame to sit in.
							<div
								className={cn(
									"flex justify-center px-4 py-3",
									stacked ? "" : "border-t bg-card",
								)}
							>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => fetchNextPage()}
									disabled={isFetchingNextPage}
								>
									{isFetchingNextPage
										? t("loading")
										: t("loadMore")}
								</Button>
							</div>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}
