"use client";

import {
	formatDurationMinutes,
	TIME_ACTIVITY_LABELS,
} from "@repo/utils/time-tracking";
import { Button } from "@ui/components/button";
import { PlayIcon, XIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { shortDateLabel } from "../lib/date-labels";
import type { SavedTimer } from "../lib/timer-model";
import { TimerDot } from "./TimerDot";

/**
 * What a stop in this browser saved, until the widget is closed: the total,
 * where it went and how many entries, with Start again (same project,
 * activity and work item), Open in My time on that day, and Undo, which
 * deletes those entries and nothing else.
 */
export function TimerSavedPanel({
	saved,
	busy,
	onStartAgain,
	onOpenDay,
	onUndo,
	onClose,
}: {
	saved: SavedTimer;
	busy: boolean;
	onStartAgain: () => void;
	onOpenDay: () => void;
	onUndo: () => void;
	onClose: () => void;
}) {
	const t = useTranslations("timeTracking.timer");
	const locale = useLocale();

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<p className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
					<TimerDot state="saved" />
					{t("state.saved")}
				</p>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("saved.close")}
					onClick={onClose}
				>
					<XIcon aria-hidden="true" />
				</Button>
			</div>
			<p className="flex flex-wrap items-baseline gap-x-2">
				<span className="font-semibold text-3xl tabular-nums tracking-tight">
					{formatDurationMinutes(saved.totalMinutes)}
				</span>
				<span className="min-w-0 truncate text-muted-foreground text-sm">
					{saved.projectName} · {TIME_ACTIVITY_LABELS[saved.activity]}
				</span>
			</p>
			<p className="text-sm">
				{t("saved.entries", {
					count: saved.entryIds.length,
					date: saved.workDate
						? shortDateLabel(saved.workDate, locale)
						: "",
				})}
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					size="sm"
					disabled={busy}
					onClick={onStartAgain}
				>
					<PlayIcon aria-hidden="true" />
					{t("saved.startAgain")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={!saved.workDate}
					onClick={onOpenDay}
				>
					{t("saved.openInMyTime")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={busy || saved.entryIds.length === 0}
					onClick={onUndo}
				>
					{t("saved.undo")}
				</Button>
			</div>
		</div>
	);
}
