"use client";

import {
	formatDurationMinutes,
	TIME_ACTIVITY_LABELS,
} from "@repo/utils/time-tracking";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { PencilIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { shortDateLabel } from "../lib/date-labels";
import { draftFromEntry } from "../lib/entry-draft";
import type { LoggableProject, TimeEntry } from "../lib/time-entry-model";
import { wallClockInZone } from "../lib/zoned-time";
import { DeleteEntryButton } from "./DeleteEntryButton";
import { TimeEntryForm } from "./TimeEntryForm";

/**
 * One logged entry, read-only until Edit opens the entry form in its place.
 *
 * `day` rows sit under their project in the day view and name the work item;
 * `story` rows sit on a work item's page and lead with the date instead.
 */
export function TimeEntryRow({
	entry,
	variant,
	organizationId,
	projects,
	knownEntries,
	onDeleted,
}: {
	entry: TimeEntry;
	variant: "day" | "story";
	organizationId: string;
	projects: readonly LoggableProject[];
	knownEntries: readonly TimeEntry[];
	/**
	 * Called once the entry is deleted, to move focus to something that
	 * outlives this row: the row and its Delete button are gone by then.
	 */
	onDeleted: () => void;
}) {
	const t = useTranslations("timeTracking.entry");
	const locale = useLocale();
	const [editing, setEditing] = useState(false);
	const activity = TIME_ACTIVITY_LABELS[entry.activity];
	const duration = formatDurationMinutes(entry.durationMinutes);

	if (editing) {
		return (
			<div className="border-t border-border px-4 py-3 first:border-t-0">
				<TimeEntryForm
					organizationId={organizationId}
					projects={projects}
					initialDraft={draftFromEntry(entry)}
					entry={entry}
					lockProjectAndItem={variant === "story"}
					showWorkDate
					knownEntries={knownEntries}
					focusToken={1}
					onSaved={() => setEditing(false)}
					onCancel={() => setEditing(false)}
					extraActions={
						<DeleteEntryButton
							entryId={entry.id}
							summary={t("summary", { duration, activity })}
							onDeleted={() => {
								setEditing(false);
								onDeleted();
							}}
						/>
					}
				/>
			</div>
		);
	}

	const range =
		entry.startAt && entry.stopAt
			? `${wallClockInZone(entry.startAt, entry.timezone).time} – ${wallClockInZone(entry.stopAt, entry.timezone).time}`
			: null;

	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 first:border-t-0">
			{variant === "story" ? (
				<span className="w-24 shrink-0 text-muted-foreground text-sm tabular-nums">
					{shortDateLabel(entry.workDate, locale)}
				</span>
			) : null}
			<div className="min-w-0 flex-1 basis-60 text-sm">
				<span className="font-medium">{activity}</span>
				{variant === "day" && entry.storyIdentifier ? (
					<span className="text-muted-foreground">
						{" · "}
						<span className="font-mono text-xs">
							{entry.storyIdentifier}
						</span>{" "}
						{entry.storyTitle}
					</span>
				) : null}
				{range ? (
					<span className="text-muted-foreground tabular-nums">
						{` · ${range}`}
					</span>
				) : null}
				{entry.description ? (
					<p className="truncate text-muted-foreground">
						{entry.description}
					</p>
				) : null}
			</div>
			{entry.billable ? null : (
				<Badge variant="info">{t("nonBillable")}</Badge>
			)}
			<span className="w-16 shrink-0 text-right font-semibold text-sm tabular-nums">
				{duration}
			</span>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={t("edit", { duration, activity })}
				onClick={() => setEditing(true)}
			>
				<PencilIcon aria-hidden="true" />
			</Button>
		</div>
	);
}
