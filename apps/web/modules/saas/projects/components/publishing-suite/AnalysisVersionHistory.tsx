"use client";

/**
 * Version history drawer for a topic's Planning & Analysis prose (Fizzy
 * #1851, Task 10).
 *
 * Shaped like `FeatureVersionHistory.tsx` — the same
 * sheet-of-versions + fullscreen-diff + quick-restore-dialog structure — but
 * none of that component's data layer transfers: it is hard-wired to a
 * story's `description`/`acceptanceCriteria` pair, while this drawer's rows
 * are `PublishingTopicAnalysisRevision`s (a single markdown `body` plus the
 * AI analysis version it was seeded from), read and written through
 * `listAnalysisRevisions`/`saveAnalysisRevision` rather than the stories
 * version endpoints.
 *
 * The one behaviour that makes this component correct: restoring a revision
 * writes a NEW revision through the same save path, and that new revision
 * COPIES the restored row's `sourceAnalysisVersion` — it never adopts
 * `currentVersion`'s own source. A body seeded from AI v1 must stay stamped
 * v1 after a restore even while AI v3 exists: stamping v3 would claim the
 * author had read an analysis they never saw, and would permanently silence
 * the stale-analysis banner the editor shows whenever `sourceAnalysisVersion`
 * trails the newest READY analysis. `expectedVersion`, by contrast, DOES come
 * from the current side — it is the compare-and-set token, not part of the
 * content being restored, and it is read from the `currentVersion` prop
 * rather than the fetched list (which can be a request behind).
 *
 * ── Why this reads TWO queries ──────────────────────────────────────────────
 *
 * What is DISPLAYED comes from `listAnalysisTimeline`: one dense sequence
 * across AI runs and hand-saved revisions, because two independent counters
 * made a first manual save after six AI runs read as "Version 1 · AI v6" —
 * the version going backwards. That read is deliberately light and carries no
 * `body` ("Entries are light — no bodies"), which is the whole reason it can
 * scan both tables in full to compute a dense ordinal.
 *
 * But a diff needs prose and a restore posts prose, so `listAnalysisRevisions`
 * stays exactly as it was and supplies the two fields the timeline has no
 * business carrying: `body` and `authorUserId`. They are joined on
 * `revisionVersion`, the stored number both reads agree on. EVERYTHING else —
 * including `sourceAnalysisVersion` — is taken from the timeline entry, so
 * there is one source of truth per field rather than two that can disagree.
 *
 * The join is safe under paging because the timeline is a superset of the
 * revisions and both pages are 25: the revisions inside the first N timeline
 * pages are always inside the first N revision pages. "Load older" advances
 * both, and the lookup is still guarded — a revision entry whose body has not
 * arrived renders as a row without Compare or Restore rather than throwing.
 *
 * ── `seq` IS DISPLAY ONLY ───────────────────────────────────────────────────
 *
 * No write accepts it. `expectedVersion` is the `currentVersion` prop and
 * `sourceAnalysisVersion` is the entry's stored value; both ride in the
 * timeline response under their own names precisely so a caller reaching for a
 * write token finds the real one. The only new `seq` that reaches the database
 * is the prose inside `changeSummary`, which is a sentence rather than a
 * reference — older rows already hold that sentence with numbers from the old
 * scale, and no migration can correct prose, so the two coexist by design.
 */

import type { ApiRouterClient } from "@repo/api/orpc/router";
import type { DocumentVersionAuthor } from "@repo/utils/document-version-author";
import { VersionDiffViewer } from "@saas/projects/components/VersionDiffViewer";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { ScrollArea } from "@ui/components/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowLeftRight,
	ClockIcon,
	HistoryIcon,
	Loader2Icon,
	RotateCcwIcon,
	SparklesIcon,
	TriangleAlertIcon,
	UserIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

const CONFLICT_MESSAGE =
	"The analysis changed while you were editing. Refresh and try again.";
const STALE_SOURCE_MESSAGE =
	"That analysis version is no longer available. Refresh and try again.";
const GENERIC_RESTORE_FAILURE_MESSAGE =
	"Could not restore this version. Refresh and try again.";
const UNKNOWN_AUTHOR_LABEL = "Unknown author";

/**
 * One row of `listAnalysisRevisions`, newest first. Inferred from the oRPC
 * output — never hand-typed — so a server-side shape change surfaces here at
 * compile time instead of silently drifting, matching `PublishingTopic` in
 * `topic-shared.ts`.
 *
 * Read ONLY for `body` and `authorUserId` now. Everything the drawer displays
 * comes off the timeline entry instead.
 */
type AnalysisRevision = Awaited<
	ReturnType<
		ApiRouterClient["projects"]["publishingSuite"]["listAnalysisRevisions"]
	>
>["revisions"][number];

/** One entry of the unified sequence, discriminated on `kind`. */
type AnalysisTimelineEntry = Awaited<
	ReturnType<
		ApiRouterClient["projects"]["publishingSuite"]["listAnalysisTimeline"]
	>
>["entries"][number];

type RevisionEntry = Extract<AnalysisTimelineEntry, { kind: "revision" }>;

/**
 * A revision entry joined to the prose only the revisions read carries.
 *
 * Deliberately narrow: `body` and `authorUserId` and nothing else. Anything
 * else copied across would be a second copy of a field the entry already has,
 * and the two reads can be a request apart.
 */
type RestorableRevision = {
	entry: RevisionEntry;
	body: string;
	authorUserId: string | null;
};

type SaveAnalysisRevisionResult = Awaited<
	ReturnType<
		ApiRouterClient["projects"]["publishingSuite"]["saveAnalysisRevision"]
	>
>;

export interface AnalysisVersionHistoryProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	topicId: string;
	organizationId: string | null;
	/**
	 * The highest revision version the caller currently knows about — becomes
	 * a restore's `expectedVersion` verbatim. Deliberately a prop rather than
	 * something derived from the fetched history: the list here can be a
	 * request behind the editor's own state, and reading `expectedVersion`
	 * back off it would reintroduce the stale-token race the compare-and-set
	 * in `saveAnalysisRevision` exists to catch. `null` before any revision
	 * has ever been saved.
	 *
	 * The STORED revision version, never a `seq`. The two are different scales
	 * and only coincide when no AI run was ever interleaved.
	 */
	currentVersion: number | null;
	/**
	 * Called after a successful restore with the version it landed on. The
	 * STORED revision version — `PlanningAnalysisTab` uses it as a concurrency
	 * token, so it must stay on the scale the server writes.
	 */
	onRestore?: (version: number) => void;
}

/** `{id, name} | null` (this endpoint's author shape) → the shape
 * `VersionDiffViewer` renders. Every author this table can name is a
 * person — there is no AI-agent writer for analysis revisions — so this
 * always maps to `HUMAN` rather than inspecting the name for a sentinel. */
function toDiffAuthor(
	author: RevisionEntry["author"],
): DocumentVersionAuthor | null {
	return author ? { kind: "HUMAN", name: author.name } : null;
}

export function AnalysisVersionHistory({
	open,
	onOpenChange,
	projectId,
	topicId,
	organizationId,
	currentVersion,
	onRestore,
}: AnalysisVersionHistoryProps) {
	const [restoreTarget, setRestoreTarget] =
		useState<RestorableRevision | null>(null);
	const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
	const [showDiffViewer, setShowDiffViewer] = useState(false);
	const [diffVersion, setDiffVersion] = useState<RestorableRevision | null>(
		null,
	);

	const queryClient = useQueryClient();
	const listInput = { projectId, topicId, organizationId };

	// Paged rather than one read of the whole history. The table is
	// append-only and every row carries a `body` the writer bounds at 40,000
	// characters, so an unpaged read grows without limit for exactly the
	// topics that have been worked on hardest — the ones whose history a
	// person is most likely to open.
	const listQuery = useInfiniteQuery({
		...orpc.projects.publishingSuite.listAnalysisRevisions.infiniteOptions({
			input: (cursor: number | undefined) => ({
				...listInput,
				cursor,
			}),
			initialPageParam: undefined as number | undefined,
			// The server decides where the boundary is; this only forwards it.
			// Deriving "is there more" from `revisions.length` here would be a
			// second opinion about a page only the query saw whole.
			getNextPageParam: (lastPage: {
				nextCursor: number | null;
			}): number | undefined => lastPage.nextCursor ?? undefined,
		}),
		enabled: open,
	});

	// The displayed sequence. Cursored on `seq`, which is this read's own
	// scale — the revisions query above is cursored on `version`, and the two
	// cursors are never interchangeable even though both are numbers.
	const timelineQuery = useInfiniteQuery({
		...orpc.projects.publishingSuite.listAnalysisTimeline.infiniteOptions({
			input: (cursor: number | undefined) => ({
				...listInput,
				cursor,
			}),
			initialPageParam: undefined as number | undefined,
			getNextPageParam: (lastPage: {
				nextCursor: number | null;
			}): number | undefined => lastPage.nextCursor ?? undefined,
		}),
		enabled: open,
	});

	// Both, not either: the timeline decides what rows exist and the revisions
	// read decides which of them can be compared or restored. Rendering on the
	// first alone would flash a list whose controls appear a moment later.
	const isLoading = timelineQuery.isLoading || listQuery.isLoading;

	const revisions = useMemo(
		() => listQuery.data?.pages.flatMap((page) => page.revisions) ?? [],
		[listQuery.data],
	);
	const entries = useMemo(
		() => timelineQuery.data?.pages.flatMap((page) => page.entries) ?? [],
		[timelineQuery.data],
	);

	// Keyed on the STORED revision version, the only number both reads share.
	// Keying on `seq` would be a category error: the revisions read has never
	// heard of it.
	const bodyByRevisionVersion = useMemo(() => {
		const map = new Map<number, AnalysisRevision>();
		for (const revision of revisions) {
			map.set(revision.version, revision);
		}
		return map;
	}, [revisions]);

	const mergeRevision = useCallback(
		(entry: RevisionEntry): RestorableRevision | null => {
			const row = bodyByRevisionVersion.get(entry.revisionVersion);
			return row
				? {
						entry,
						body: row.body,
						authorUserId: row.authorUserId,
					}
				: null;
		},
		[bodyByRevisionVersion],
	);

	// What "current" means for the diff viewer's left-hand pane. The highest
	// version IS the saved current state — nothing but this save path ever
	// inserts a row — so matching on `currentVersion` (falling back to the
	// newest row) is enough; there is no separate "live" body to thread
	// through as a prop.
	//
	// Still resolved from the REVISIONS list rather than the timeline, because
	// what this is for is a body, and the timeline carries none.
	const currentRevision = useMemo(
		() =>
			revisions.find((r) => r.version === currentVersion) ??
			revisions[0] ??
			null,
		[revisions, currentVersion],
	);
	const currentBody = currentRevision?.body ?? "";

	// Display only — and now on the unified scale, so the pane's label agrees
	// with the numbers in the list behind it. The `kind` guard is load-bearing:
	// an `ai_run` entry has no `revisionVersion` at all, and matching without
	// it would compare `undefined` against a number on every AI row.
	//
	// The compare-and-set token stays the `currentVersion` prop — see
	// `performRestore` — so a stale caller still loses the race it should lose.
	const currentDisplaySeq = useMemo(() => {
		if (!currentRevision) {
			return 0;
		}
		const match = entries.find(
			(e) =>
				e.kind === "revision" &&
				e.revisionVersion === currentRevision.version,
		);
		return match?.seq ?? 0;
	}, [entries, currentRevision]);

	const restoreMutation = useMutation(
		orpc.projects.publishingSuite.saveAnalysisRevision.mutationOptions({
			onSuccess: (result: SaveAnalysisRevisionResult) => {
				// No number in the message. `result.version` is the STORED
				// revision version, and the seq the new entry will occupy is
				// not known until the timeline refetches — naming the stored
				// one here would contradict every number in the list behind
				// the toast.
				toast.success("Restored. A new version has been saved.");
				// BOTH lists. They are separate cache entries on separate
				// scales, and a restore writes a row that belongs in each;
				// invalidating only one leaves the drawer showing history
				// without the version it has just written.
				for (const queryKey of [
					// `key()`, NOT `queryKey()`. The two are not
					// interchangeable, and the difference is invisible at
					// runtime: `queryKey({ input })` stamps `type: "query"`
					// into the key, so once this list became an infinite
					// query — whose cache entry is stamped `type: "infinite"`
					// — that key matched nothing. The restore would have kept
					// succeeding, kept toasting, and left the drawer showing
					// history without the version it had just written.
					// `key()` is the partial form built for invalidation and
					// matches whatever type the entry carries.
					orpc.projects.publishingSuite.listAnalysisRevisions.key({
						input: listInput,
					}),
					orpc.projects.publishingSuite.listAnalysisTimeline.key({
						input: listInput,
					}),
				]) {
					queryClient.invalidateQueries({ queryKey });
				}
				setRestoreConfirmOpen(false);
				setRestoreTarget(null);
				setShowDiffViewer(false);
				// The STORED version, not a seq: the caller holds this as a
				// concurrency token.
				onRestore?.(result.version);
			},
			onError: (error: unknown) => {
				// A lost race (CONFLICT) and a stale source version
				// (BAD_REQUEST) are both recoverable states, not crashes —
				// refreshing resolves either one.
				const code = (error as { code?: string } | null)?.code;
				const message =
					code === "CONFLICT"
						? CONFLICT_MESSAGE
						: code === "BAD_REQUEST"
							? STALE_SOURCE_MESSAGE
							: GENERIC_RESTORE_FAILURE_MESSAGE;
				toast.error(message);
			},
		}),
	);

	const performRestore = useCallback(
		(target: RestorableRevision) => {
			restoreMutation.mutate({
				projectId,
				topicId,
				organizationId,
				body: target.body,
				// The compare-and-set token: the version CURRENT state is at,
				// not the restored revision's own version — and never `seq`,
				// which no write on this endpoint accepts.
				expectedVersion: currentVersion,
				// The restored revision's OWN source — never `currentVersion`'s.
				// Copying this is the one behaviour that makes a restore
				// correct: it is what brings the stale-analysis banner back
				// when the restored body predates the newest AI analysis. The
				// STORED value off the entry, not its `sourceSeq` twin.
				sourceAnalysisVersion: target.entry.sourceAnalysisVersion,
				// Prose, not a reference — so this one takes the number the
				// reader actually saw. Rows written before the unified scale
				// hold the old number in this same sentence; the two coexist,
				// and no migration can correct prose.
				changeSummary: `Restored from version ${target.entry.seq}`,
			});
		},
		[restoreMutation, projectId, topicId, organizationId, currentVersion],
	);

	const handleRestoreClick = useCallback(
		(e: React.MouseEvent, target: RestorableRevision) => {
			// Stops the row's own onClick (which opens the fullscreen compare
			// view) from also firing — Restore and Compare are two different
			// actions layered on one row.
			e.stopPropagation();
			setRestoreTarget(target);
			setRestoreConfirmOpen(true);
		},
		[],
	);

	const handleRestoreConfirm = useCallback(() => {
		if (restoreTarget) {
			performRestore(restoreTarget);
		}
	}, [restoreTarget, performRestore]);

	const handleVersionClick = useCallback(
		(target: RestorableRevision) => {
			setDiffVersion(target);
			setShowDiffViewer(true);
			onOpenChange(false);
		},
		[onOpenChange],
	);

	const handleDiffViewerRestore = useCallback(() => {
		if (diffVersion) {
			performRestore(diffVersion);
		}
	}, [diffVersion, performRestore]);

	// One control, two cursors. The timeline decides whether there is more to
	// show, because it is the superset; the revisions query is advanced in step
	// so the bodies for the newly-revealed rows arrive with them. Calling into
	// an exhausted revisions query is the right no-op when everything left in
	// the timeline is an AI run.
	const handleLoadOlder = useCallback(() => {
		timelineQuery.fetchNextPage();
		if (listQuery.hasNextPage) {
			listQuery.fetchNextPage();
		}
	}, [timelineQuery, listQuery]);

	const formatDate = (dateValue: string | Date) =>
		new Intl.DateTimeFormat("en-US", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(dateValue));

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent className="w-[400px] max-w-[90vw] sm:w-[480px] sm:max-w-[480px]">
					<SheetHeader>
						<SheetTitle className="flex items-center gap-2">
							<HistoryIcon
								className="size-5"
								aria-hidden="true"
							/>
							Version history
						</SheetTitle>
						<SheetDescription>
							Every AI run and saved edit, in one sequence. Click
							a saved version to compare it with the current
							analysis
						</SheetDescription>
					</SheetHeader>

					<div className="mt-6">
						{isLoading ? (
							<div className="flex items-center justify-center py-8">
								<Loader2Icon
									className="size-6 text-muted-foreground motion-safe:animate-spin"
									aria-hidden="true"
								/>
							</div>
						) : entries.length === 0 ? (
							<div className="py-8 text-center text-muted-foreground">
								<HistoryIcon
									className="mx-auto mb-3 size-12 opacity-50"
									aria-hidden="true"
								/>
								<p className="font-medium">
									No version history yet
								</p>
								<p className="mt-1 text-sm">
									Versions are created by an AI run, and the
									first time you save an edit or restore a
									previous one
								</p>
							</div>
						) : (
							<ScrollArea className="h-[calc(100vh-240px)] [&>[data-radix-scroll-area-viewport]>div]:w-full">
								<div className="space-y-2 pr-4">
									{entries.map((entry) => {
										// An AI run is a NUMBER IN THE SEQUENCE,
										// not a place to go. Its prose lives in
										// `publishing_topic_planning_analysis`,
										// which this drawer's diff and restore
										// paths cannot read — so the row is a
										// plain div with no role, no tabIndex
										// and no handlers, for EVERY status
										// rather than only the failed ones. A
										// READY run is just as unrestorable
										// here as a failed one, and an
										// interactive row that does nothing is
										// worse than a static one.
										if (entry.kind === "ai_run") {
											const requestedByLabel =
												entry.requestedBy?.name.trim() ||
												UNKNOWN_AUTHOR_LABEL;
											return (
												<div
													key={entry.analysisId}
													className={cn(
														"w-full rounded-lg border border-dashed p-4 text-left",
														entry.status ===
															"FAILED" &&
															"border-destructive/40 bg-destructive/5",
													)}
												>
													<div className="flex items-start justify-between gap-2">
														<div className="flex min-w-0 flex-wrap items-center gap-2">
															<span className="font-semibold text-sm">
																v{entry.seq}
															</span>
															<Badge
																variant="outline"
																className="px-1.5 py-0 text-[10px]"
															>
																<SparklesIcon
																	className="mr-1 size-2.5"
																	aria-hidden="true"
																/>
																AI run
															</Badge>
															{entry.status ===
															"FAILED" ? (
																<Badge
																	variant="destructive"
																	className="px-1.5 py-0 text-[10px]"
																>
																	<TriangleAlertIcon
																		className="mr-1 size-2.5"
																		aria-hidden="true"
																	/>
																	Failed
																</Badge>
															) : null}
															{entry.status ===
															"GENERATING" ? (
																<Badge
																	variant="outline"
																	className="px-1.5 py-0 text-[10px]"
																>
																	<Loader2Icon
																		className="mr-1 size-2.5 motion-safe:animate-spin"
																		aria-hidden="true"
																	/>
																	Generating
																</Badge>
															) : null}
														</div>
													</div>

													<p className="mt-1.5 text-muted-foreground text-sm">
														{entry.status ===
														"FAILED"
															? "This run failed. It keeps its number because the number was taken when the run started."
															: entry.status ===
																	"GENERATING"
																? "This run is still generating."
																: "Analysis generated by AI."}
													</p>

													<div className="mt-2 flex items-center gap-3 text-muted-foreground text-xs">
														<time
															className="flex items-center gap-1"
															dateTime={new Date(
																entry.createdAt,
															).toISOString()}
															title={formatDate(
																entry.createdAt,
															)}
														>
															<ClockIcon
																className="size-3"
																aria-hidden="true"
															/>
															{formatDistanceToNow(
																new Date(
																	entry.createdAt,
																),
																{
																	addSuffix: true,
																},
															)}
														</time>
														<span className="flex items-center gap-1">
															<UserIcon
																className="size-3"
																aria-hidden="true"
															/>
															{requestedByLabel}
														</span>
													</div>
												</div>
											);
										}

										const isCurrent =
											entry.revisionVersion ===
											currentVersion;
										const authorLabel =
											entry.author?.name.trim() ||
											UNKNOWN_AUTHOR_LABEL;
										// Null when the body page has not
										// arrived yet. The row still renders —
										// it holds a number in the sequence —
										// but Compare and Restore both need
										// prose, so they stay off until it has.
										const target = mergeRevision(entry);

										const rowClassName = cn(
											"group w-full rounded-lg border p-4 text-left transition-colors",
											isCurrent &&
												"border-primary/40 bg-primary/5",
											diffVersion?.entry.revisionId ===
												entry.revisionId &&
												showDiffViewer &&
												"ring-2 ring-primary/50",
										);

										// Written once and rendered by either
										// branch below. The two differ only in
										// whether the wrapper is a control, and
										// duplicating forty lines of markup to
										// say that is how the two drift apart.
										const rowContent = (
											<>
												<div className="flex items-start justify-between gap-2">
													<div className="flex min-w-0 items-center gap-2 overflow-hidden">
														<span className="font-semibold text-sm">
															v{entry.seq}
														</span>
														{/* Omitted rather than guessed
														    when the referenced analysis
														    row is absent — the server
														    sends null for exactly that
														    case, and a wrong number here
														    is worse than none. */}
														{entry.sourceSeq !==
														null ? (
															<Badge
																variant="outline"
																className="px-1.5 py-0 text-[10px]"
															>
																<SparklesIcon
																	className="mr-1 size-2.5"
																	aria-hidden="true"
																/>
																From v
																{
																	entry.sourceSeq
																}
															</Badge>
														) : null}
														{isCurrent ? (
															<Badge
																variant="outline"
																className="px-1.5 py-0 text-[10px]"
															>
																Current
															</Badge>
														) : null}
													</div>

													<div className="flex shrink-0 items-center gap-1">
														{target ? (
															<span className="flex items-center gap-1 text-muted-foreground text-xs opacity-0 transition-opacity group-hover:opacity-100">
																<ArrowLeftRight
																	className="size-3"
																	aria-hidden="true"
																/>
																Compare
															</span>
														) : null}
														{target &&
														!isCurrent ? (
															<Button
																type="button"
																variant="ghost"
																size="sm"
																className="h-7 px-2 text-muted-foreground text-xs hover:text-foreground"
																onClick={(e) =>
																	handleRestoreClick(
																		e,
																		target,
																	)
																}
															>
																<RotateCcwIcon
																	className="mr-1 size-3.5"
																	aria-hidden="true"
																/>
																Restore
															</Button>
														) : null}
													</div>
												</div>

												{entry.changeSummary ? (
													<p className="mt-1.5 text-muted-foreground text-sm">
														{entry.changeSummary}
													</p>
												) : null}

												<div className="mt-2 flex items-center gap-3 text-muted-foreground text-xs">
													<time
														className="flex items-center gap-1"
														dateTime={new Date(
															entry.createdAt,
														).toISOString()}
														title={formatDate(
															entry.createdAt,
														)}
													>
														<ClockIcon
															className="size-3"
															aria-hidden="true"
														/>
														{formatDistanceToNow(
															new Date(
																entry.createdAt,
															),
															{ addSuffix: true },
														)}
													</time>
													<span className="flex items-center gap-1">
														<UserIcon
															className="size-3"
															aria-hidden="true"
														/>
														{authorLabel}
													</span>
												</div>
											</>
										);

										// A row whose body has not arrived is
										// not a control. Two elements rather
										// than one with conditional attributes:
										// a conditional `role` reads to the
										// linter as a static div carrying click
										// handlers, which is the exact bug that
										// rule exists to catch, and suppressing
										// it would blind the rule to a real one.
										if (!target) {
											return (
												<div
													key={entry.revisionId}
													className={rowClassName}
												>
													{rowContent}
												</div>
											);
										}

										return (
											// biome-ignore lint/a11y/useSemanticElements: list row with nested controls; cannot use <button>
											<div
												role="button"
												tabIndex={0}
												key={entry.revisionId}
												// An explicit label, not the default
												// content-derived name: without it this
												// row's accessible name would swallow its
												// nested Restore button's own label,
												// making the two indistinguishable to
												// anything that queries by name.
												aria-label={`Compare version ${entry.seq}${isCurrent ? " (current)" : ""}`}
												className={cn(
													rowClassName,
													"cursor-pointer hover:border-primary/40 hover:bg-primary/5",
												)}
												onClick={() =>
													handleVersionClick(target)
												}
												onKeyDown={(e) => {
													if (
														e.key === "Enter" ||
														e.key === " "
													) {
														e.preventDefault();
														handleVersionClick(
															target,
														);
													}
												}}
											>
												{rowContent}
											</div>
										);
									})}
									{timelineQuery.hasNextPage ? (
										<Button
											variant="outline"
											className="w-full"
											onClick={handleLoadOlder}
											disabled={
												timelineQuery.isFetchingNextPage
											}
										>
											{timelineQuery.isFetchingNextPage ? (
												<>
													<Loader2Icon
														className="mr-2 size-4 motion-safe:animate-spin"
														aria-hidden="true"
													/>
													Loading older versions
												</>
											) : (
												"Load older versions"
											)}
										</Button>
									) : null}
								</div>
							</ScrollArea>
						)}
					</div>
				</SheetContent>
			</Sheet>

			{/* Quick restore confirmation */}
			<Dialog
				open={restoreConfirmOpen}
				onOpenChange={setRestoreConfirmOpen}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Restore version {restoreTarget?.entry.seq}?
						</DialogTitle>
						<DialogDescription>
							This saves version {restoreTarget?.entry.seq}'s text
							as a new revision. The current text stays in history
							— nothing is overwritten.
						</DialogDescription>
					</DialogHeader>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setRestoreConfirmOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={handleRestoreConfirm}
							disabled={restoreMutation.isPending}
						>
							{restoreMutation.isPending ? (
								<Loader2Icon
									className="mr-2 size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							Confirm
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Fullscreen compare view */}
			{showDiffViewer && diffVersion ? (
				<VersionDiffViewer
					open={showDiffViewer}
					onOpenChange={setShowDiffViewer}
					selectedVersion={{
						id: diffVersion.entry.revisionId,
						// The unified number, so the pane agrees with the list
						// it was opened from.
						version: diffVersion.entry.seq,
						content: diffVersion.body,
						changeDescription: diffVersion.entry.changeSummary,
						changedBy: diffVersion.authorUserId,
						author: toDiffAuthor(diffVersion.entry.author),
						createdAt: new Date(
							diffVersion.entry.createdAt,
						).toISOString(),
					}}
					currentContent={currentBody}
					currentVersion={currentDisplaySeq}
					onRestore={handleDiffViewerRestore}
					isRestoring={restoreMutation.isPending}
				/>
			) : null}
		</>
	);
}
