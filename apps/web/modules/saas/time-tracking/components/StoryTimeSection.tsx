"use client";

import { formatDurationMinutes } from "@repo/utils/time-tracking";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { ClockIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { emptyDraft } from "../lib/entry-draft";
import { newEntryDefaults } from "../lib/time-entry-model";
import {
	browserTimeZone,
	newEntryTimeZone,
	todayInZone,
} from "../lib/zoned-time";
import { InfoHint } from "./InfoHint";
import { StartTimerButton } from "./StartTimerButton";
import { TimeEntryForm } from "./TimeEntryForm";
import { TimeEntryRow } from "./TimeEntryRow";

/**
 * "My time on this item" on a work item's page: the caller's own entries on
 * it, their total, and a Log time line fixed to this project and item.
 *
 * Time tracking belongs to organizations, so the section renders nothing for
 * a personal project. Log time is offered only when the caller can log time
 * on the project right now.
 */
export function StoryTimeSection({
	organizationId,
	projectId,
	story,
}: {
	organizationId: string | null | undefined;
	projectId: string;
	story: { id: string; identifier: string; title: string };
}) {
	if (!organizationId) {
		return null;
	}
	return (
		<StoryTimeSectionBody
			organizationId={organizationId}
			projectId={projectId}
			story={story}
		/>
	);
}

function StoryTimeSectionBody({
	organizationId,
	projectId,
	story,
}: {
	organizationId: string;
	projectId: string;
	story: { id: string; identifier: string; title: string };
}) {
	const t = useTranslations("timeTracking.story");
	const [logging, setLogging] = useState(false);
	const [timeZone, setTimeZone] = useState<string | null>(null);
	const sectionRef = useRef<HTMLElement>(null);
	useEffect(() => {
		setTimeZone(browserTimeZone());
	}, []);

	const entriesQuery = useQuery(
		orpc.timeTracking.listForStory.queryOptions({
			input: { projectId, storyId: story.id },
		}),
	);
	const projectsQuery = useQuery(
		orpc.timeTracking.listLoggableProjects.queryOptions({
			input: { organizationId },
		}),
	);

	const entries = [...(entriesQuery.data?.entries ?? [])].sort((a, b) =>
		b.workDate === a.workDate
			? b.createdAt.localeCompare(a.createdAt)
			: b.workDate.localeCompare(a.workDate),
	);
	const projects = projectsQuery.data?.projects ?? [];
	const entryTimeZone = timeZone
		? newEntryTimeZone(projectsQuery.data?.profileTimeZone, timeZone)
		: null;
	const canLog = projects.some((project) => project.id === projectId);
	const { activity } = newEntryDefaults(entries, projects);

	return (
		<section
			ref={sectionRef}
			tabIndex={-1}
			aria-labelledby={`story-time-${story.id}`}
			className="space-y-4 border-t pt-6 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<h3
						id={`story-time-${story.id}`}
						className="flex items-center gap-2 font-semibold text-base"
					>
						<ClockIcon className="size-4" aria-hidden="true" />
						{t("title")}
					</h3>
					<InfoHint label={t("aboutTitle")}>{t("about")}</InfoHint>
					{entriesQuery.data ? (
						<span className="font-semibold text-sm tabular-nums">
							{formatDurationMinutes(
								entriesQuery.data.totalMinutes,
							)}
						</span>
					) : null}
				</div>
				{canLog && timeZone ? (
					<div className="flex flex-wrap items-center gap-2">
						<StartTimerButton
							organizationId={organizationId}
							size="sm"
							values={{ projectId, activity, story }}
						/>
						{logging ? null : (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setLogging(true)}
							>
								<PlusIcon aria-hidden="true" />
								{t("logTime")}
							</Button>
						)}
					</div>
				) : null}
			</div>

			{logging && entryTimeZone ? (
				<div className="rounded-lg border border-border bg-card p-4">
					<TimeEntryForm
						organizationId={organizationId}
						projects={projects}
						initialDraft={emptyDraft({
							projectId,
							activity,
							story,
							workDate: todayInZone(entryTimeZone),
							timezone: entryTimeZone,
						})}
						lockProjectAndItem
						showWorkDate
						knownEntries={entries}
						focusToken={1}
						onSaved={() => setLogging(false)}
						onCancel={() => setLogging(false)}
					/>
				</div>
			) : null}

			{entriesQuery.isPending ? (
				<Skeleton className="h-10 w-full" />
			) : entriesQuery.isError ? (
				<p className="text-muted-foreground text-sm">
					{t("loadFailed")}
				</p>
			) : entries.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("empty")}</p>
			) : (
				<div className="overflow-hidden rounded-lg border border-border bg-card">
					{entries.map((entry) => (
						<TimeEntryRow
							key={entry.id}
							entry={entry}
							variant="story"
							organizationId={organizationId}
							projects={projects}
							knownEntries={entries}
							onDeleted={() => sectionRef.current?.focus()}
						/>
					))}
				</div>
			)}
		</section>
	);
}
