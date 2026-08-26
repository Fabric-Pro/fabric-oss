"use client";

import {
	AlertTriangleIcon,
	CheckSquareIcon,
	Loader2Icon,
	SquareIcon,
} from "lucide-react";
import type { AgendaStatus } from "../hooks/use-upcoming-meetings";

const NOT_TRACKED_LABEL =
	"Not tracked — link this meeting to generate an agenda";

/**
 * The digest's per-meeting agenda checklist indicator (#2106, FR3).
 *
 * Every state carries a distinct GLYPH and a distinct ACCESSIBLE NAME, never
 * colour alone — the four linked states are otherwise indistinguishable to a
 * colour-blind or screen-reader user. `role="img"` + `aria-label` gives the
 * whole indicator one name instead of leaking the icon's internals.
 */
export function AgendaStatusIndicator({
	linkedMeetingId,
	agendaStatus,
}: {
	linkedMeetingId: string | null;
	agendaStatus: AgendaStatus | null;
}) {
	// D4. An unlinked meeting has no database row, so no agenda can exist for
	// it — a different claim from "no agenda yet", and the reason this branch
	// comes first and ignores `agendaStatus` entirely.
	if (!linkedMeetingId) {
		return (
			<span
				role="img"
				aria-label={NOT_TRACKED_LABEL}
				title={NOT_TRACKED_LABEL}
				className="w-4 shrink-0 text-center text-sm text-muted-foreground"
			>
				<span aria-hidden="true">—</span>
			</span>
		);
	}

	const { Icon, label, className } = (() => {
		switch (agendaStatus) {
			case "READY":
				return {
					Icon: CheckSquareIcon,
					label: "Agenda ready",
					className: "text-emerald-600 dark:text-emerald-400",
				};
			case "GENERATING":
				return {
					Icon: Loader2Icon,
					label: "Agenda generating",
					className: "animate-spin text-muted-foreground",
				};
			case "FAILED":
				return {
					Icon: AlertTriangleIcon,
					label: "Agenda generation failed",
					className: "text-destructive",
				};
			default:
				return {
					Icon: SquareIcon,
					label: "No agenda yet",
					className: "text-muted-foreground",
				};
		}
	})();

	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className="shrink-0 leading-none"
		>
			<Icon className={`size-4 ${className}`} aria-hidden="true" />
		</span>
	);
}
