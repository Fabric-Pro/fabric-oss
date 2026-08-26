"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/** No-filter lists at or below this run immediately; above it we ask for
 * confirmation first (a whole-list re-rank is a deliberate, credit-using
 * action, so a large one shouldn't fire on a single click). */
export const REPRIORITIZE_ASK_THRESHOLD = 100;

/** Kept in lock-step with the server's `MAX_REPRIORITIZED_ITEMS`
 * (reprioritize-stories.ts): the most items one run processes. The whole
 * selected set is ranked together in a single pass up to this ceiling; only a
 * list larger than this is covered across more than one run. */
const REPRIORITIZE_MAX_PER_RUN = 500;

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Count of items in the current (filtered) view. */
	filteredCount: number;
	/** Count of all active items of this kind, ignoring roadmap filters. */
	entireCount: number;
	/** Whether the roadmap has any active filters right now. */
	hasActiveFilters: boolean;
	/** Run over the chosen scope. `scope` picks which id set the caller sends. */
	onConfirm: (scope: "filtered" | "entire") => void;
};

/**
 * Confirmation before a list-wide AI re-prioritization, shown only when a
 * choice or a caution is warranted:
 *
 * - **Filters active** → ask which set to run: the filtered view, or the entire
 *   roadmap. Priority is relative, so re-ranking only a slice is a real choice
 *   the user should make deliberately, not a silent default.
 * - **No filters, but a large list** (> {@link REPRIORITIZE_ASK_THRESHOLD}) →
 *   confirm the whole-list run before it fires, since it uses AI credits and
 *   can take a moment.
 * - **A chosen scope exceeds {@link REPRIORITIZE_MAX_PER_RUN}** → an amber (not
 *   destructive) caution that this run covers the first {cap} items (oldest
 *   first) and the tail needs another run. Below the ceiling, every selected
 *   item is ranked together in one pass, so no caution shows.
 *
 * When there are no filters and the list is within the ask threshold, the
 * caller skips this dialog entirely and runs immediately.
 */
export function ReprioritizeScopeDialog({
	open,
	onOpenChange,
	filteredCount,
	entireCount,
	hasActiveFilters,
	onConfirm,
}: Props) {
	const t = useTranslations("projects.stories.priority");

	// The largest scope the user could pick is what decides whether to caution;
	// with no filters "filtered" === "entire", so this collapses correctly.
	const maxScope = hasActiveFilters
		? Math.max(filteredCount, entireCount)
		: entireCount;
	// Only a list larger than a single run's ceiling gets the caution — up to
	// the ceiling the whole selection is ranked together, nothing is skipped.
	const showCeiling = maxScope > REPRIORITIZE_MAX_PER_RUN;

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{hasActiveFilters
							? t("scopeDialogTitleFiltered")
							: t("scopeDialogTitleAll", { count: entireCount })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{hasActiveFilters
							? t("scopeDialogBodyFiltered")
							: t("scopeDialogBodyAll")}
					</AlertDialogDescription>
				</AlertDialogHeader>

				{showCeiling && (
					// Amber caution — informational, not an error. The run still
					// proceeds; it just can't cover more than the ceiling at once.
					// Body is `text-foreground` (not `text-highlight-foreground`,
					// which is a near-black meant for text ON solid amber and is
					// unreadable over this faint tint in dark mode); the amber
					// lives in the border + icon. Matches the settings/security
					// callout pattern.
					<div className="flex items-start gap-2 rounded-md border border-highlight/40 bg-highlight/10 p-3 text-foreground text-sm">
						<TriangleAlertIcon
							aria-hidden
							className="mt-0.5 size-4 shrink-0 text-highlight"
						/>
						{/* With filters, the two scopes can straddle the ceiling,
						    so the note states the general rule rather than
						    asserting the user's specific pick will spill over; the
						    per-button counts show which scope actually exceeds it.
						    Without filters there is one button, so it is direct. */}
						<p>
							{hasActiveFilters
								? t("scopeDialogCeilingChoice", {
										cap: REPRIORITIZE_MAX_PER_RUN,
									})
								: t("scopeDialogCeiling", {
										cap: REPRIORITIZE_MAX_PER_RUN,
									})}
						</p>
					</div>
				)}

				<AlertDialogFooter>
					<AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
					{hasActiveFilters ? (
						<>
							{/* Filtered is the primary action — the user is
							    looking at that slice — with Entire beside it. */}
							<AlertDialogAction
								onClick={() => onConfirm("entire")}
								className="bg-muted text-foreground hover:bg-muted/80"
							>
								{t("scopeRunEntire", { count: entireCount })}
							</AlertDialogAction>
							<AlertDialogAction
								onClick={() => onConfirm("filtered")}
							>
								{t("scopeRunFiltered", {
									count: filteredCount,
								})}
							</AlertDialogAction>
						</>
					) : (
						<AlertDialogAction onClick={() => onConfirm("entire")}>
							{t("scopeRunConfirm", { count: entireCount })}
						</AlertDialogAction>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
