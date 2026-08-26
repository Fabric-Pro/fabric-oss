"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { StoryPriority } from "../../../lib/stories/types";
import {
	HistoryError,
	HistoryLoading,
	HistoryPager,
	HistoryTimestamp,
} from "../BacklogHistoryShared";
import { PriorityBand } from "./PriorityBand";

/** Matches the server default so the pager's page size is not a surprise. */
const PAGE_SIZE = 20;

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	organizationId: string | null;
	storyId: string;
	identifier: string;
	currentPriority: StoryPriority;
};

/**
 * The full priority history for one work item, newest first.
 *
 * A dialog rather than more inline rows: a busy item's history is unbounded, and
 * an expanding row pushes every other item off screen exactly when someone is
 * trying to compare them. The row keeps the trajectory; this keeps the record.
 *
 * The oldest page ends with a terminal "Created as <band>" entry so the timeline
 * reaches back to the item's origin instead of starting mid-story. That entry is
 * derived, never stored — see the `initialPriority` note on the procedure.
 */
export function PriorityHistoryDialog({
	open,
	onOpenChange,
	projectId,
	organizationId,
	storyId,
	identifier,
	currentPriority,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	// Cursor stack: index 0 is the first page. Same shape as the roadmap's other
	// history surfaces, so the pager behaves identically wherever you meet one.
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const cursor = cursors.at(-1) ?? null;

	const query = useQuery({
		...orpc.projects.stories.priorityHistory.queryOptions({
			input: {
				projectId,
				organizationId,
				storyId,
				limit: PAGE_SIZE,
				...(cursor ? { cursor } : {}),
			},
		}),
		// Don't fetch a dialog nobody opened.
		enabled: open,
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("historyDialogTitle")}</DialogTitle>
					<DialogDescription>
						{t("historyDialogDescription", { identifier })}
					</DialogDescription>
				</DialogHeader>

				{query.isError ? (
					<HistoryError onRetry={() => query.refetch()} />
				) : query.isPending ? (
					<HistoryLoading />
				) : (
					<div>
						<ul className="space-y-3">
							{query.data.items.map((entry) => (
								<li key={entry.id} className="flex gap-2.5">
									<span
										aria-hidden
										className={
											entry.source === "AI"
												? "mt-1.5 size-1.5 shrink-0 rounded-full bg-secondary"
												: "mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
										}
									/>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
											{entry.fromPriority && (
												<>
													<PriorityBand
														priority={
															entry.fromPriority
														}
														responsive={false}
													/>
													<span
														aria-hidden
														className="text-muted-foreground"
													>
														→
													</span>
												</>
											)}
											<PriorityBand
												priority={entry.toPriority}
												responsive={false}
											/>
											<Badge
												status={
													entry.source === "AI"
														? "success"
														: "info"
												}
												className="text-[10px]"
											>
												{entry.source === "AI"
													? t("sourceAi")
													: t("sourceManual")}
											</Badge>
											<span className="text-muted-foreground">
												<HistoryTimestamp
													value={entry.createdAt}
													compact
												/>
												{entry.actorName
													? ` · ${entry.actorName}`
													: null}
											</span>
										</div>
										{entry.reason && (
											<p className="mt-1 break-words text-muted-foreground text-xs">
												{entry.reason}
											</p>
										)}
									</div>
								</li>
							))}

							{/* Terminal entry — only on the last page, where it
							    belongs chronologically. */}
							{!query.data.nextCursor && (
								<li className="flex gap-2.5">
									<span
										aria-hidden
										className="mt-1.5 size-1.5 shrink-0 rounded-full border border-muted-foreground/40"
									/>
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
										<span className="text-muted-foreground">
											{t("historyCreatedAs")}
										</span>
										<PriorityBand
											priority={
												query.data.initialPriority ??
												currentPriority
											}
											responsive={false}
											className="opacity-70"
										/>
									</div>
								</li>
							)}
						</ul>

						<HistoryPager
							canPrev={cursors.length > 1}
							canNext={Boolean(query.data.nextCursor)}
							isFetching={query.isFetching}
							onPrev={() =>
								setCursors((stack) => stack.slice(0, -1))
							}
							onNext={() =>
								setCursors((stack) =>
									query.data.nextCursor
										? [...stack, query.data.nextCursor]
										: stack,
								)
							}
							showingCount={query.data.items.length}
							page={cursors.length}
						/>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
