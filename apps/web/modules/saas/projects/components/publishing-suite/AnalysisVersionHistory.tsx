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
 */

import type { ApiRouterClient } from "@repo/api/orpc/router";
import type { DocumentVersionAuthor } from "@repo/utils/document-version-author";
import { VersionDiffViewer } from "@saas/projects/components/VersionDiffViewer";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
 * `author` is a relation (`onDelete: SetNull`), so it can legitimately be
 * `null` for a departed author — the row stays, and the UI renders an
 * "unknown author" label rather than hiding the version.
 */
type AnalysisRevision = Awaited<
	ReturnType<
		ApiRouterClient["projects"]["publishingSuite"]["listAnalysisRevisions"]
	>
>["revisions"][number];

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
	 */
	currentVersion: number | null;
	/** Called after a successful restore with the version it landed on. */
	onRestore?: (version: number) => void;
}

/** `{id, name} | null` (this endpoint's author shape) → the shape
 * `VersionDiffViewer` renders. Every author this table can name is a
 * person — there is no AI-agent writer for analysis revisions — so this
 * always maps to `HUMAN` rather than inspecting the name for a sentinel. */
function toDiffAuthor(
	author: AnalysisRevision["author"],
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
	const [restoreTarget, setRestoreTarget] = useState<AnalysisRevision | null>(
		null,
	);
	const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
	const [showDiffViewer, setShowDiffViewer] = useState(false);
	const [diffVersion, setDiffVersion] = useState<AnalysisRevision | null>(
		null,
	);

	const queryClient = useQueryClient();
	const listInput = { projectId, topicId, organizationId };

	const { data, isLoading } = useQuery({
		...orpc.projects.publishingSuite.listAnalysisRevisions.queryOptions({
			input: listInput,
		}),
		enabled: open,
	});

	const revisions = data?.revisions ?? [];

	// What "current" means for the diff viewer's left-hand pane. The highest
	// version IS the saved current state — nothing but this save path ever
	// inserts a row — so matching on `currentVersion` (falling back to the
	// newest row) is enough; there is no separate "live" body to thread
	// through as a prop.
	//
	// Resolved as ONE row rather than as parallel lookups for body and
	// version: the pane's label must name the row the pane is showing. The
	// two can otherwise disagree, because `currentVersion` is the caller's
	// view and this list is its own query — when another client saves a
	// revision, `currentVersion` is still null while the list already has
	// rows, and independent fallbacks would render real text labelled "v0".
	const currentRevision = useMemo(
		() =>
			revisions.find((r) => r.version === currentVersion) ??
			revisions[0] ??
			null,
		[revisions, currentVersion],
	);
	const currentBody = currentRevision?.body ?? "";
	// Display only. The compare-and-set token stays the `currentVersion`
	// prop — see `performRestore` — so a stale caller still loses the race
	// it should lose.
	const currentDisplayVersion = currentRevision?.version ?? 0;

	const restoreMutation = useMutation(
		orpc.projects.publishingSuite.saveAnalysisRevision.mutationOptions({
			onSuccess: (result: SaveAnalysisRevisionResult) => {
				toast.success(`Restored to version ${result.version}`);
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listAnalysisRevisions.queryKey(
							{ input: listInput },
						),
				});
				setRestoreConfirmOpen(false);
				setRestoreTarget(null);
				setShowDiffViewer(false);
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
		(revision: AnalysisRevision) => {
			restoreMutation.mutate({
				projectId,
				topicId,
				organizationId,
				body: revision.body,
				// The compare-and-set token: the version CURRENT state is at,
				// not the restored revision's own version.
				expectedVersion: currentVersion,
				// The restored revision's OWN source — never `currentVersion`'s.
				// Copying this is the one behaviour that makes a restore
				// correct: it is what brings the stale-analysis banner back
				// when the restored body predates the newest AI analysis.
				sourceAnalysisVersion: revision.sourceAnalysisVersion,
				changeSummary: `Restored from version ${revision.version}`,
			});
		},
		[restoreMutation, projectId, topicId, organizationId, currentVersion],
	);

	const handleRestoreClick = useCallback(
		(e: React.MouseEvent, revision: AnalysisRevision) => {
			// Stops the row's own onClick (which opens the fullscreen compare
			// view) from also firing — Restore and Compare are two different
			// actions layered on one row.
			e.stopPropagation();
			setRestoreTarget(revision);
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
		(revision: AnalysisRevision) => {
			setDiffVersion(revision);
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
							Click a version to compare it with the current
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
						) : revisions.length === 0 ? (
							<div className="py-8 text-center text-muted-foreground">
								<HistoryIcon
									className="mx-auto mb-3 size-12 opacity-50"
									aria-hidden="true"
								/>
								<p className="font-medium">
									No version history yet
								</p>
								<p className="mt-1 text-sm">
									Versions are created the first time you save
									an edit or restore a previous one
								</p>
							</div>
						) : (
							<ScrollArea className="h-[calc(100vh-240px)] [&>[data-radix-scroll-area-viewport]>div]:w-full">
								<div className="space-y-2 pr-4">
									{revisions.map((revision) => {
										const isCurrent =
											revision.version === currentVersion;
										const authorLabel =
											revision.author?.name.trim() ||
											UNKNOWN_AUTHOR_LABEL;

										return (
											// biome-ignore lint/a11y/useSemanticElements: list row with nested controls; cannot use <button>
											<div
												role="button"
												tabIndex={0}
												key={revision.id}
												// An explicit label, not the default
												// content-derived name: without it this
												// row's accessible name would swallow its
												// nested Restore button's own label,
												// making the two indistinguishable to
												// anything that queries by name.
												aria-label={`Compare version ${revision.version}${isCurrent ? " (current)" : ""}`}
												className={cn(
													"group w-full cursor-pointer rounded-lg border p-4 text-left transition-colors",
													"hover:border-primary/40 hover:bg-primary/5",
													isCurrent &&
														"border-primary/40 bg-primary/5",
													diffVersion?.id ===
														revision.id &&
														showDiffViewer &&
														"ring-2 ring-primary/50",
												)}
												onClick={() =>
													handleVersionClick(revision)
												}
												onKeyDown={(e) => {
													if (
														e.key === "Enter" ||
														e.key === " "
													) {
														e.preventDefault();
														handleVersionClick(
															revision,
														);
													}
												}}
											>
												<div className="flex items-start justify-between gap-2">
													<div className="flex min-w-0 items-center gap-2 overflow-hidden">
														<span className="font-semibold text-sm">
															v{revision.version}
														</span>
														<Badge
															variant="outline"
															className="px-1.5 py-0 text-[10px]"
														>
															<SparklesIcon
																className="mr-1 size-2.5"
																aria-hidden="true"
															/>
															AI v
															{
																revision.sourceAnalysisVersion
															}
														</Badge>
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
														<span className="flex items-center gap-1 text-muted-foreground text-xs opacity-0 transition-opacity group-hover:opacity-100">
															<ArrowLeftRight
																className="size-3"
																aria-hidden="true"
															/>
															Compare
														</span>
														{isCurrent ? null : (
															<Button
																type="button"
																variant="ghost"
																size="sm"
																className="h-7 px-2 text-muted-foreground text-xs hover:text-foreground"
																onClick={(e) =>
																	handleRestoreClick(
																		e,
																		revision,
																	)
																}
															>
																<RotateCcwIcon
																	className="mr-1 size-3.5"
																	aria-hidden="true"
																/>
																Restore
															</Button>
														)}
													</div>
												</div>

												{revision.changeSummary ? (
													<p className="mt-1.5 text-muted-foreground text-sm">
														{revision.changeSummary}
													</p>
												) : null}

												<div className="mt-2 flex items-center gap-3 text-muted-foreground text-xs">
													<time
														className="flex items-center gap-1"
														dateTime={new Date(
															revision.createdAt,
														).toISOString()}
														title={formatDate(
															revision.createdAt,
														)}
													>
														<ClockIcon
															className="size-3"
															aria-hidden="true"
														/>
														{formatDistanceToNow(
															new Date(
																revision.createdAt,
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
											</div>
										);
									})}
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
							Restore version {restoreTarget?.version}?
						</DialogTitle>
						<DialogDescription>
							This saves version {restoreTarget?.version}'s text
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
						id: diffVersion.id,
						version: diffVersion.version,
						content: diffVersion.body,
						changeDescription: diffVersion.changeSummary,
						changedBy: diffVersion.authorUserId,
						author: toDiffAuthor(diffVersion.author),
						createdAt: new Date(
							diffVersion.createdAt,
						).toISOString(),
					}}
					currentContent={currentBody}
					currentVersion={currentDisplayVersion}
					onRestore={handleDiffViewerRestore}
					isRestoring={restoreMutation.isPending}
				/>
			) : null}
		</>
	);
}
