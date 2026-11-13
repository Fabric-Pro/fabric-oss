"use client";

import {
	addDays,
	formatDurationMinutes,
	weekRange,
} from "@repo/utils/time-tracking";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { orpc } from "@shared/lib/orpc-query-utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	EmptyState,
	EmptyStateAction,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ClockIcon,
	PlusIcon,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { useSuggestionRun } from "../hooks/use-suggestion-run";
import type { TimerStartValues } from "../hooks/use-timer";
import { longDateLabel, weekRangeLabel } from "../lib/date-labels";
import type { EntrySelection } from "../lib/entry-draft";
import { suggestedWorkDates } from "../lib/suggestion-model";
import {
	buildWeekTable,
	minutesByDate,
	newEntryDefaults,
	weekDates,
} from "../lib/time-entry-model";
import {
	readRememberedView,
	rememberView,
	resolveViewState,
	type TimeView,
} from "../lib/view-state";
import {
	browserTimeZone,
	newEntryTimeZone,
	todayInZone,
} from "../lib/zoned-time";
import { DayView } from "./DayView";
import { InfoHint } from "./InfoHint";
import { StartTimerButton } from "./StartTimerButton";
import { TimerSettings } from "./TimerSettings";
import { CheckActivityButton, TimeSuggestions } from "./TimeSuggestions";
import { WeekTable } from "./WeekTable";

/**
 * My time: the caller's confirmed time across the organization's projects,
 * by week or by day, and the line to log more.
 *
 * The view and date live in the URL so a reload keeps them. Both depend on
 * the browser (its time zone decides "today", its storage the remembered
 * view), so no date or time is rendered until the page has mounted there: a
 * server guess would be replaced on hydration, and the server's date
 * formatting need not match the browser's character for character.
 */
export function MyTimePage({ organizationId }: { organizationId: string }) {
	const t = useTranslations("timeTracking");
	const locale = useLocale();
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const [browser, setBrowser] = useState<{
		timeZone: string;
		rememberedView: TimeView | null;
	} | null>(null);
	useEffect(() => {
		setBrowser({
			timeZone: browserTimeZone(),
			rememberedView: readRememberedView(),
		});
	}, []);
	const [focusToken, setFocusToken] = useState(0);

	const timeZone = browser?.timeZone ?? "UTC";
	const today = todayInZone(timeZone);
	const { view, date } = resolveViewState({
		view: searchParams.get("view"),
		date: searchParams.get("date"),
		rememberedView: browser?.rememberedView ?? null,
		today,
	});
	const week = weekRange(date);
	const dates = useMemo(() => weekDates(week.from), [week.from]);

	const projectsQuery = useQuery({
		...orpc.timeTracking.listLoggableProjects.queryOptions({
			input: { organizationId },
		}),
		enabled: browser !== null,
	});
	const entriesQuery = useQuery({
		...orpc.timeTracking.listEntries.queryOptions({
			input: { organizationId, from: week.from, to: week.to },
		}),
		enabled: browser !== null,
		// Stepping into another week keeps the page (and anything half typed
		// in the entry line) on screen until the new week arrives.
		placeholderData: keepPreviousData,
	});

	const suggestionsQuery = useQuery({
		...orpc.timeTracking.listSuggestions.queryOptions({
			input: { organizationId },
		}),
		enabled: browser !== null,
	});
	const suggestionRun = useSuggestionRun({
		organizationId,
		timeZone,
		enabled: browser !== null,
	});

	const entries = entriesQuery.data?.entries ?? [];
	const projects = projectsQuery.data?.projects ?? [];
	const suggestions = suggestionsQuery.data?.suggestions ?? [];
	const suggestedDates = useMemo(
		() => suggestedWorkDates(suggestionsQuery.data?.suggestions ?? []),
		[suggestionsQuery.data],
	);
	// Hidden while there is nothing to confirm and no check to report on;
	// "Check my activity" then sits in the page header.
	const showSuggestions =
		suggestions.length > 0 ||
		suggestionRun.checking ||
		suggestionRun.notice !== null;
	const table = useMemo(
		() => buildWeekTable(entriesQuery.data?.entries ?? [], week.from),
		[entriesQuery.data, week.from],
	);

	// Start timer runs on what the entry line currently holds; before the
	// day view has shown it, on what the line would start from (the last
	// entry's project and activity).
	const [quickEntry, setQuickEntry] = useState<EntrySelection | null>(null);
	const entryDefaults = newEntryDefaults(entries, projects);
	const timerStartValues: TimerStartValues | null = quickEntry?.projectId
		? {
				projectId: quickEntry.projectId,
				activity: quickEntry.activity,
				story: quickEntry.story,
			}
		: entryDefaults.projectId
			? {
					projectId: entryDefaults.projectId,
					activity: entryDefaults.activity,
					story: null,
				}
			: null;

	const navigate = (next: { view?: TimeView; date?: string }) => {
		const params = new URLSearchParams(searchParams.toString());
		params.set("view", next.view ?? view);
		params.set("date", next.date ?? date);
		router.replace(`${pathname}?${params}`, { scroll: false });
	};
	const chooseView = (next: TimeView) => {
		rememberView(next);
		navigate({ view: next });
	};
	const logTime = () => {
		navigate({ view: "day" });
		setFocusToken((token) => token + 1);
	};

	const step = view === "week" ? 7 : 1;
	const periodTotal =
		view === "week"
			? (entriesQuery.data?.totalMinutes ?? 0)
			: minutesByDate(entries, [date])[date];
	const loading =
		browser === null ||
		entriesQuery.isPending ||
		projectsQuery.isPending ||
		(view === "week" && entriesQuery.isPlaceholderData);
	const failed = entriesQuery.isError || projectsQuery.isError;

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-1">
					<h1 className="font-semibold text-2xl">{t("title")}</h1>
					<InfoHint label={t("aboutTitle")}>{t("about")}</InfoHint>
					<PageTourButton pageId="time" />
					<TimerSettings organizationId={organizationId} />
				</div>
				{projects.length > 0 ? (
					<div className="flex flex-wrap items-center gap-2">
						{showSuggestions ? null : (
							<CheckActivityButton
								checking={suggestionRun.checking}
								onCheck={suggestionRun.check}
							/>
						)}
						<StartTimerButton
							organizationId={organizationId}
							values={timerStartValues}
							data-onboarding-target="time-start-timer"
						/>
						<Button
							type="button"
							onClick={logTime}
							data-onboarding-target="time-log-time"
						>
							<PlusIcon aria-hidden="true" />
							{t("logTime")}
						</Button>
					</div>
				) : null}
			</div>

			{showSuggestions ? (
				<TimeSuggestions
					organizationId={organizationId}
					suggestions={suggestions}
					knownEntries={entries}
					checking={suggestionRun.checking}
					notice={suggestionRun.notice}
					onCheck={suggestionRun.check}
				/>
			) : null}

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<fieldset
						className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/60 p-0.5"
						data-onboarding-target="time-view-switch"
					>
						<legend className="sr-only">{t("view")}</legend>
						{(["day", "week"] as const).map((option) => (
							<button
								key={option}
								type="button"
								aria-pressed={view === option}
								onClick={() => chooseView(option)}
								className={cn(
									"rounded-[5px] border px-3 py-1 font-medium text-xs",
									"motion-safe:transition-colors motion-safe:duration-150",
									"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
									view === option
										? "border-border bg-card text-foreground shadow-sm"
										: "border-transparent text-muted-foreground hover:text-foreground",
								)}
							>
								{option === "day"
									? t("dayView")
									: t("weekView")}
							</button>
						))}
					</fieldset>
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						aria-label={
							view === "week"
								? t("previousWeek")
								: t("previousDay")
						}
						onClick={() => navigate({ date: addDays(date, -step) })}
					>
						<ChevronLeftIcon aria-hidden="true" />
					</Button>
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						aria-label={
							view === "week" ? t("nextWeek") : t("nextDay")
						}
						onClick={() => navigate({ date: addDays(date, step) })}
					>
						<ChevronRightIcon aria-hidden="true" />
					</Button>
					{browser === null ? (
						<Skeleton className="ml-2 h-5 w-48" />
					) : (
						<h2 className="ml-2 font-semibold text-base">
							{view === "week"
								? weekRangeLabel(week.from, week.to, locale)
								: longDateLabel(date, locale)}
						</h2>
					)}
				</div>
				<p className="flex items-baseline gap-3">
					<span className="text-muted-foreground text-sm">
						{view === "week" ? t("weekTotal") : t("dayTotal")}
					</span>
					<span className="font-semibold text-xl tabular-nums">
						{loading ? "–" : formatDurationMinutes(periodTotal)}
					</span>
				</p>
			</div>

			{loading ? (
				<output className="block space-y-2">
					<span className="sr-only">{t("loading")}</span>
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</output>
			) : failed ? (
				<p className="py-12 text-center text-muted-foreground text-sm">
					{t("loadFailed")}
				</p>
			) : view === "week" ? (
				table.rows.length === 0 ? (
					<EmptyState className="rounded-lg border border-border bg-card">
						<EmptyStateIcon>
							<ClockIcon className="size-8" aria-hidden="true" />
						</EmptyStateIcon>
						<EmptyStateTitle>{t("emptyWeek")}</EmptyStateTitle>
						{projects.length > 0 ? (
							<EmptyStateAction>
								<Button type="button" onClick={logTime}>
									<PlusIcon aria-hidden="true" />
									{t("logTime")}
								</Button>
							</EmptyStateAction>
						) : null}
					</EmptyState>
				) : (
					<WeekTable
						table={table}
						today={today}
						suggestedDates={suggestedDates}
						onOpenDay={(day) =>
							navigate({ view: "day", date: day })
						}
					/>
				)
			) : (
				<DayView
					organizationId={organizationId}
					date={date}
					today={today}
					weekDates={dates}
					entries={entries}
					projects={projects}
					timeZone={newEntryTimeZone(
						projectsQuery.data?.profileTimeZone,
						timeZone,
					)}
					focusToken={focusToken}
					onSelectDate={(day) => navigate({ date: day })}
					onQuickEntryChange={setQuickEntry}
				/>
			)}
		</div>
	);
}
