"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";

/**
 * The caller's recent notes on the entry's project, as small buttons that
 * fill the note field. A pick only fills it: the note stays editable and is
 * saved however the caller saves typed text.
 *
 * The read is keyed by project, so after the project changes only that
 * project's notes are offered, never the previous one's, even while loading.
 */
export function RecentNotes({
	projectId,
	onPick,
	disabled,
	className,
}: {
	projectId: string;
	onPick: (note: string) => void;
	disabled?: boolean;
	className?: string;
}) {
	const t = useTranslations("timeTracking.form");
	const { data } = useQuery({
		...orpc.timeTracking.listRecentNotes.queryOptions({
			input: { projectId },
		}),
		staleTime: 60_000,
	});
	const notes = data?.notes ?? [];
	if (notes.length === 0) {
		return null;
	}

	return (
		<fieldset
			aria-label={t("recentNotes")}
			className={cn("flex min-w-0 flex-wrap gap-1.5", className)}
		>
			{notes.map((note) => (
				<Button
					key={note}
					type="button"
					variant="outline"
					size="xs"
					title={note}
					aria-label={t("useRecentNote", { note })}
					disabled={disabled}
					// Keep focus in the note field: one that saves on blur would
					// otherwise save the half-typed text the pick replaces.
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => onPick(note)}
					className="max-w-48 rounded-full font-normal"
				>
					<span className="min-w-0 truncate">{note}</span>
				</Button>
			))}
		</fieldset>
	);
}
