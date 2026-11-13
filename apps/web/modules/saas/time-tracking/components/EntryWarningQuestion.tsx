"use client";

import {
	formatDurationMinutes,
	TIME_ACTIVITY_LABELS,
	type TimeEntryWarning,
} from "@repo/utils/time-tracking";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { shortDateLabel } from "../lib/date-labels";
import type { TimeEntry } from "../lib/time-entry-model";

/** What the proposed entry would be, for when the duplicate is not loaded. */
interface ProposedEntrySummary {
	workDate: string;
	durationMinutes: number | null;
	activity: TimeEntry["activity"];
	target: string;
}

/**
 * The server's objection to a save, asked as one inline question beside the
 * form rather than in a dialog: the person answers it where they typed.
 */
export function EntryWarningQuestion({
	warning,
	knownEntries,
	proposed,
	isSaving,
	onConfirm,
	onDismiss,
}: {
	warning: TimeEntryWarning;
	knownEntries: readonly TimeEntry[];
	proposed: ProposedEntrySummary;
	isSaving: boolean;
	onConfirm: () => void;
	onDismiss: () => void;
}) {
	const t = useTranslations("timeTracking.warnings");
	const locale = useLocale();

	let question: string;
	let confirmLabel: string;
	switch (warning.code) {
		case "LIKELY_DUPLICATE": {
			const duplicate = knownEntries.find((entry) =>
				warning.entryIds.includes(entry.id),
			);
			const minutes =
				duplicate?.durationMinutes ?? proposed.durationMinutes;
			question = t("duplicate", {
				duration:
					minutes === null ? "" : formatDurationMinutes(minutes),
				activity:
					TIME_ACTIVITY_LABELS[
						duplicate?.activity ?? proposed.activity
					],
				target: duplicate
					? duplicate.storyIdentifier
						? `${duplicate.storyIdentifier} ${duplicate.storyTitle ?? ""}`.trim()
						: duplicate.projectName
					: proposed.target,
			});
			confirmLabel = t("duplicateConfirm");
			break;
		}
		case "OVER_DAILY_LIMIT":
			question = t("overLimit", {
				date: shortDateLabel(proposed.workDate, locale),
				total: formatDurationMinutes(warning.totalMinutes),
			});
			confirmLabel = t("overLimitConfirm");
			break;
		default: {
			const unhandled: never = warning;
			throw new Error(
				`Unhandled time warning: ${JSON.stringify(unhandled)}`,
			);
		}
	}

	return (
		<div
			role="alert"
			className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
		>
			<AlertTriangleIcon
				aria-hidden="true"
				className="size-4 shrink-0 text-highlight-ink dark:text-highlight"
			/>
			<span className="min-w-0 flex-1 basis-64">{question}</span>
			<div className="flex gap-2">
				<Button
					type="button"
					size="xs"
					variant="outline"
					onClick={onConfirm}
					loading={isSaving}
				>
					{confirmLabel}
				</Button>
				<Button
					type="button"
					size="xs"
					variant="ghost"
					onClick={onDismiss}
					disabled={isSaving}
				>
					{t("skip")}
				</Button>
			</div>
		</div>
	);
}
