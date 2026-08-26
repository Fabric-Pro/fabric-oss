"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	Loader2Icon,
	PlusIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	AUTOMATION_I18N_KEY,
	type AutomationStatus,
	PRIORITY_I18N_KEY,
	STATE_I18N_KEY,
	type TestCasePriority,
	type TestCaseState,
} from "./constants";
import {
	HISTORY_DIALOG_PAGE,
	HISTORY_PANEL_PREVIEW,
	HistoryMoreDialog,
} from "./HistoryMoreDialog";
import { OwnerAvatar } from "./OwnerAvatar";

// ---------------------------------------------------------------------------
// Activity — the edit half of a case's history (creation provenance + state /
// priority / title / steps / automation changes). The run-result history is a
// sibling section (RunsSection); together they are the case's full timeline.
// ---------------------------------------------------------------------------

type ActivityType =
	| "CREATED"
	| "STATE_CHANGED"
	| "PRIORITY_CHANGED"
	| "RENAMED"
	| "STEPS_CHANGED"
	| "AUTOMATION_CHANGED"
	| "PM_LINK_CHANGED";

interface ActivityItem {
	id: string;
	type: ActivityType;
	actorUserId: string | null;
	actorName: string | null;
	actorLabel: string | null;
	fromValue: string | null;
	toValue: string | null;
	occurredAt: string;
}

export function ActivitySection({
	projectId,
	organizationId,
	testCaseId,
}: {
	projectId: string;
	organizationId: string | null;
	testCaseId: string;
}) {
	const t = useTranslations("projects.testCases");
	const [allOpen, setAllOpen] = useState(false);

	// The panel shows only the newest few; the rest live in the dialog.
	const query = useQuery(
		orpc.projects.testCases.activityHistory.queryOptions({
			input: {
				projectId,
				organizationId,
				testCaseId,
				limit: HISTORY_PANEL_PREVIEW,
			},
		}),
	);
	const items = (query.data?.items ?? []) as ActivityItem[];
	const total = query.data?.total ?? 0;

	// Paged full history — only fetched once the dialog is actually opened.
	const allQuery = useInfiniteQuery({
		...orpc.projects.testCases.activityHistory.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				organizationId,
				testCaseId,
				limit: HISTORY_DIALOG_PAGE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, allPages) => {
				const loaded = allPages.reduce(
					(sum, page) => sum + page.items.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
		enabled: allOpen,
	});
	const allItems = (allQuery.data?.pages ?? []).flatMap(
		(page) => page.items,
	) as ActivityItem[];

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
					{t("activity.heading")}
				</p>
				{total > items.length && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setAllOpen(true)}
						className="h-auto py-0.5 text-muted-foreground text-xs hover:text-foreground"
					>
						{t("activity.viewAll", { total })}
					</Button>
				)}
			</div>
			{query.isLoading ? (
				<div className="flex items-center justify-center py-6 text-muted-foreground">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				</div>
			) : query.isError ? (
				<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					{t("activity.loadFailed")}
				</p>
			) : items.length === 0 ? (
				<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					{t("activity.empty")}
				</p>
			) : (
				<ul className="space-y-1.5">
					{items.map((item) => (
						<ActivityRow key={item.id} item={item} />
					))}
				</ul>
			)}

			<HistoryMoreDialog
				open={allOpen}
				onOpenChange={setAllOpen}
				title={t("activity.heading")}
				description={t("activity.dialogDescription")}
				total={allQuery.data?.pages[0]?.total ?? total}
				shown={allItems.length}
				hasMore={allQuery.hasNextPage === true}
				onShowMore={() => allQuery.fetchNextPage()}
				isLoading={allQuery.isLoading}
				isLoadingMore={allQuery.isFetchingNextPage}
				isError={allQuery.isError}
			>
				{allItems.map((item) => (
					<ActivityRow key={item.id} item={item} />
				))}
			</HistoryMoreDialog>
		</div>
	);
}

function ActivityRow({ item }: { item: ActivityItem }) {
	const t = useTranslations("projects.testCases");
	const tState = useTranslations("projects.testCases");
	const when = new Date(item.occurredAt);
	const validDate = !Number.isNaN(when.getTime());

	// AI-drafted / imported / cloned creations carry an actorLabel and no user;
	// everything else is a user action.
	const isSystemActor = item.actorUserId === null && !!item.actorLabel;
	const actorName =
		item.actorName ?? item.actorLabel ?? t("row.unknownActor");

	return (
		<li className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="inline-flex items-center gap-1.5 text-foreground text-sm">
					<ActivityIcon type={item.type} isAi={isSystemActor} />
					{describe(item, t, tState)}
				</span>
				{validDate && (
					<time
						dateTime={when.toISOString()}
						title={when.toLocaleString()}
						className="text-muted-foreground text-xs"
					>
						{formatDistanceToNow(when, { addSuffix: true })}
					</time>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
				{isSystemActor ? (
					<span>{item.actorLabel}</span>
				) : (
					<span className="inline-flex items-center gap-1.5">
						<OwnerAvatar name={item.actorName} label={actorName} />
						<span>{t("activity.by", { name: actorName })}</span>
					</span>
				)}
			</div>
		</li>
	);
}

function ActivityIcon({ type, isAi }: { type: ActivityType; isAi: boolean }) {
	if (type === "CREATED") {
		return isAi ? (
			<SparklesIcon
				className="size-3.5 shrink-0 text-secondary"
				aria-hidden="true"
			/>
		) : (
			<PlusIcon
				className="size-3.5 shrink-0 text-muted-foreground"
				aria-hidden="true"
			/>
		);
	}
	return (
		<ArrowRightIcon
			className="size-3.5 shrink-0 text-muted-foreground"
			aria-hidden="true"
		/>
	);
}

/** One-line human description of an activity event. */
function describe(
	item: ActivityItem,
	t: ReturnType<typeof useTranslations>,
	tCase: ReturnType<typeof useTranslations>,
): string {
	const stateLabel = (v: string | null) =>
		v && v in STATE_I18N_KEY
			? tCase(STATE_I18N_KEY[v as TestCaseState])
			: (v ?? "");
	const priorityLabel = (v: string | null) =>
		v && v in PRIORITY_I18N_KEY
			? tCase(PRIORITY_I18N_KEY[v as TestCasePriority])
			: (v ?? "");
	const automationLabel = (v: string | null) =>
		v && v in AUTOMATION_I18N_KEY
			? tCase(AUTOMATION_I18N_KEY[v as AutomationStatus])
			: (v ?? "");

	switch (item.type) {
		case "CREATED":
			return t("activity.created");
		case "STATE_CHANGED":
			return t("activity.stateChanged", {
				from: stateLabel(item.fromValue),
				to: stateLabel(item.toValue),
			});
		case "PRIORITY_CHANGED":
			return t("activity.priorityChanged", {
				from: priorityLabel(item.fromValue),
				to: priorityLabel(item.toValue),
			});
		case "RENAMED":
			return t("activity.renamed");
		case "STEPS_CHANGED":
			return t("activity.stepsChanged", {
				from: item.fromValue ?? "0",
				to: item.toValue ?? "0",
			});
		case "AUTOMATION_CHANGED":
			return t("activity.automationChanged", {
				from: automationLabel(item.fromValue),
				to: automationLabel(item.toValue),
			});
		case "PM_LINK_CHANGED":
			return t("activity.pmLinkChanged");
		default: {
			// A new activity type must be given copy here rather than rendering
			// a raw enum at the user.
			const exhaustive: never = item.type;
			return exhaustive;
		}
	}
}
