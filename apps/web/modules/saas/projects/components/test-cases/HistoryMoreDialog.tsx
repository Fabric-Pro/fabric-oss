"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/**
 * The "View all" shell shared by every history list (per-case Activity, QA
 * drafting runs, QA analyses).
 *
 * Each panel shows only the newest few entries inline; this dialog is where the
 * rest lives. It pages in blocks rather than loading a whole history at once —
 * the caller owns the query and hands in the already-fetched rows plus a
 * `hasMore`/`onShowMore` pair, so this component stays presentational and every
 * list gets identical paging behaviour and copy.
 */
export function HistoryMoreDialog({
	open,
	onOpenChange,
	title,
	description,
	total,
	shown,
	hasMore,
	onShowMore,
	isLoading,
	isLoadingMore,
	isError,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	/** Total rows that exist, so the dialog can say "showing X of Y". */
	total: number;
	shown: number;
	hasMore: boolean;
	onShowMore: () => void;
	isLoading: boolean;
	isLoadingMore: boolean;
	isError: boolean;
	/** The rendered rows — each list owns its own row markup. */
	children: ReactNode;
}) {
	const t = useTranslations("projects.testCases");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				{/* The list scrolls inside the dialog so the header and the
				    Show-more control stay put on a long history. */}
				<div className="min-h-0 flex-1 overflow-y-auto pr-1">
					{isLoading ? (
						<div className="flex items-center justify-center py-10 text-muted-foreground">
							<Loader2Icon
								className="size-5 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						</div>
					) : isError ? (
						<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center text-muted-foreground text-sm">
							{t("history.dialog.loadFailed")}
						</p>
					) : (
						<ul className="space-y-1.5">{children}</ul>
					)}
				</div>

				{!isLoading && !isError && (
					<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
						<span
							className="text-muted-foreground text-xs"
							aria-live="polite"
						>
							{t("history.dialog.showing", { shown, total })}
						</span>
						{hasMore && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={onShowMore}
								disabled={isLoadingMore}
								className="gap-1.5"
							>
								{isLoadingMore && (
									<Loader2Icon
										aria-hidden="true"
										className="size-3.5 motion-safe:animate-spin"
									/>
								)}
								{t("history.dialog.showMore")}
							</Button>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** How many rows each history panel shows inline before "View all". */
export const HISTORY_PANEL_PREVIEW = 5;

/** How many rows the dialog loads at a time (initial page and each "Show more"). */
export const HISTORY_DIALOG_PAGE = 15;
