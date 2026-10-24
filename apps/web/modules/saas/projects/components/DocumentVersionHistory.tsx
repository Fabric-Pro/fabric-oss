"use client";

/**
 * Document Version History Panel
 * Shows version history for a project document with diff comparison and restore capability.
 * Clicking a version opens a fullscreen diff viewer (VersionDiffViewer).
 */

import type { DocumentVersionAuthor } from "@repo/utils/document-version-author";
import { countDocumentWords } from "@repo/utils/document-word-count";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftRight,
	ClockIcon,
	FileTextIcon,
	HistoryIcon,
	Loader2Icon,
	RotateCcwIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { useCallback, useId, useState } from "react";
import { toast } from "sonner";
import { describeDocumentWriteRefusal } from "../lib/document-write-refusal";
import { VersionAuthorBadge } from "./VersionAuthorBadge";
import { VersionDiffViewer } from "./VersionDiffViewer";

/**
 * Why Restore is closed off right now (Fizzy #2946): a generation run is
 * queued or writing the document, which refuses the restore anyway, or this
 * tab's own regeneration is under way or waiting for its review.
 */
export type RestoreBlockedReason = "runLive" | "regenerating";

interface DocumentVersionHistoryProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	documentId: string;
	currentVersion: number;
	currentContent: string;
	/** `restoredVersion` is the version the restore was saved as. */
	onVersionRestored?: (
		restoredContent: string,
		restoredVersion?: number,
	) => void;
	/**
	 * Set while Restore would be refused or would race the tab's own
	 * regeneration: every Restore control is disabled and says why.
	 */
	restoreBlockedReason?: RestoreBlockedReason | null;
}

interface DocumentVersion {
	id: string;
	version: number;
	content: string;
	changeDescription: string | null;
	/**
	 * Raw `DocumentVersion.changedBy`: an opaque user id, the auto-refresh
	 * agent's sentinel, or null. NEVER render this — it is an internal id. Render
	 * `author` instead, which the server resolves into a display name.
	 */
	changedBy: string | null;
	/**
	 * Who wrote this version, resolved server-side (`getDocumentVersions`).
	 * `null` for legacy rows written before authorship was recorded — those
	 * render with no author line at all rather than a fabricated one.
	 */
	author: DocumentVersionAuthor | null;
	createdAt: string;
	promptVersion?: {
		id: string;
		version: number;
		prompt: {
			id: string;
			name: string;
			scope: string;
		};
	} | null;
}

/**
 * A Restore control that is closed off says why (Fizzy #2946). The button
 * is `aria-disabled`, not `disabled`, as in DownloadAllContextsButton: it
 * stays focusable and keeps its pointer events, so the tooltip hangs on the
 * button itself, a keyboard or screen-reader user reaches it as the one tab
 * stop and hears the reason it is described by, and its handler refuses the
 * press. With nothing blocking it, the control renders as it always did.
 */
function RestoreBlockedTooltip({
	text,
	children,
}: {
	text: string | null;
	children: ReactElement;
}) {
	if (text === null) {
		return children;
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent>{text}</TooltipContent>
		</Tooltip>
	);
}

/** How a closed-off Restore looks, now that `disabled` no longer dims it. */
const RESTORE_BLOCKED_CLASS = "cursor-not-allowed opacity-50";

export function DocumentVersionHistory({
	open,
	onOpenChange,
	projectId,
	documentId,
	currentVersion,
	currentContent,
	onVersionRestored,
	restoreBlockedReason = null,
}: DocumentVersionHistoryProps) {
	const { organizationId } = useOrganizationContext();
	const t = useTranslations("projects.versionHistory");
	const tRefusal = useTranslations("projects.documentWriteRefusal");
	// The sentence every disabled Restore control is described by. Only
	// Restore's refusal and this reason are translated; the rest of the
	// panel's copy is unchanged.
	const restoreBlockedText =
		restoreBlockedReason === "runLive"
			? t("restoreBlocked.runLive")
			: restoreBlockedReason === "regenerating"
				? t("restoreBlocked.regenerating")
				: null;
	const restoreBlocked = restoreBlockedText !== null;
	const rowRestoreBlockedId = useId();
	const dialogRestoreBlockedId = useId();
	const [restoreTarget, setRestoreTarget] = useState<DocumentVersion | null>(
		null,
	);
	const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
	const [showDiffViewer, setShowDiffViewer] = useState(false);
	const [diffVersion, setDiffVersion] = useState<DocumentVersion | null>(
		null,
	);

	const queryClient = useQueryClient();

	// Fetch version history
	const { data, isLoading } = useQuery({
		...orpc.projects.documents.versions.list.queryOptions({
			input: {
				projectId,
				documentId,
				organizationId,
			},
		}),
		enabled: open,
	});

	const versions = data?.versions as DocumentVersion[] | undefined;

	// Restore mutation - no global callbacks; each call site provides its own
	// onSuccess to avoid duplicate toasts and stale restoreTarget reads.
	// A refusal is said in the reader's words, never the server's (Fizzy
	// #2946). One a run or another write explains also refetches the
	// document, so the editor catches up with what refused it.
	const restoreMutation = useMutation(
		orpc.projects.documents.versions.restore.mutationOptions({
			onError: (error) => {
				const refusal = describeDocumentWriteRefusal(error, tRefusal);
				toast.error(refusal.message);
				if (
					refusal.kind === "runLive" ||
					refusal.kind === "changedMeanwhile"
				) {
					queryClient.invalidateQueries({
						queryKey: orpc.projects.documents.get.queryKey({
							input: { id: documentId, projectId },
						}),
					});
				}
			},
		}),
	);

	// Quick restore from version list
	const handleRestoreClick = useCallback(
		(e: React.MouseEvent, version: DocumentVersion) => {
			e.stopPropagation(); // Prevent row click (which opens diff viewer)
			// A closed-off Restore stays pressable (`aria-disabled`), so
			// the press is refused here, by mouse or by keyboard alike.
			if (restoreBlockedReason) {
				return;
			}
			setRestoreTarget(version);
			setRestoreConfirmOpen(true);
		},
		[restoreBlockedReason],
	);

	const handleRestoreConfirm = useCallback(() => {
		if (restoreBlockedReason) {
			return;
		}
		if (restoreTarget) {
			restoreMutation.mutate(
				{
					projectId,
					documentId,
					versionNumber: restoreTarget.version,
					organizationId,
				},
				{
					onSuccess: (data) => {
						toast.success(
							`Restored to version ${restoreTarget.version}`,
						);
						queryClient.invalidateQueries({
							queryKey: orpc.projects.documents.get.queryKey({
								input: { id: documentId, projectId },
							}),
						});
						queryClient.invalidateQueries({
							queryKey:
								orpc.projects.documents.versions.list.queryKey({
									input: {
										projectId,
										documentId,
										organizationId,
									},
								}),
						});
						setRestoreConfirmOpen(false);
						const restoredContent = restoreTarget.content;
						setRestoreTarget(null);
						if (restoredContent) {
							onVersionRestored?.(
								restoredContent,
								data?.document?.version,
							);
						}
					},
				},
			);
		}
	}, [
		restoreBlockedReason,
		restoreTarget,
		restoreMutation,
		projectId,
		documentId,
		organizationId,
		queryClient,
		onVersionRestored,
	]);

	// Open diff viewer when clicking a version row
	const handleVersionClick = useCallback(
		(version: DocumentVersion) => {
			setDiffVersion(version);
			setShowDiffViewer(true);
			onOpenChange(false); // Close the Sheet so it doesn't sit behind the diff viewer
		},
		[onOpenChange],
	);

	// Restore from diff viewer — uses per-call onSuccess to avoid stale state
	const handleDiffViewerRestore = useCallback(() => {
		if (restoreBlockedReason) {
			return;
		}
		if (diffVersion) {
			restoreMutation.mutate(
				{
					projectId,
					documentId,
					versionNumber: diffVersion.version,
					organizationId,
				},
				{
					onSuccess: (data) => {
						toast.success(
							`Restored to version ${diffVersion.version}`,
						);
						queryClient.invalidateQueries({
							queryKey: orpc.projects.documents.get.queryKey({
								input: { id: documentId, projectId },
							}),
						});
						queryClient.invalidateQueries({
							queryKey:
								orpc.projects.documents.versions.list.queryKey({
									input: {
										projectId,
										documentId,
										organizationId,
									},
								}),
						});
						setShowDiffViewer(false);
						onVersionRestored?.(
							diffVersion.content,
							data?.document?.version,
						);
					},
				},
			);
		}
	}, [
		restoreBlockedReason,
		diffVersion,
		restoreMutation,
		projectId,
		documentId,
		organizationId,
		queryClient,
		onVersionRestored,
	]);

	const formatDate = (dateStr: string) => {
		return new Intl.DateTimeFormat("en-US", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(dateStr));
	};

	const formatRelativeTime = (dateStr: string) => {
		const now = new Date();
		const date = new Date(dateStr);
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) {
			return "Just now";
		}
		if (diffMins < 60) {
			return `${diffMins}m ago`;
		}
		if (diffHours < 24) {
			return `${diffHours}h ago`;
		}
		if (diffDays < 7) {
			return `${diffDays}d ago`;
		}
		return formatDate(dateStr);
	};

	const getChangeIcon = (description: string | null) => {
		if (!description) {
			return <FileTextIcon className="h-3.5 w-3.5" />;
		}
		const lower = description.toLowerCase();
		if (lower.includes("initial") || lower.includes("generated")) {
			return <SparklesIcon className="h-3.5 w-3.5" />;
		}
		if (lower.includes("restored")) {
			return <RotateCcwIcon className="h-3.5 w-3.5" />;
		}
		return <FileTextIcon className="h-3.5 w-3.5" />;
	};

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent className="w-[400px] max-w-[90vw] sm:w-[480px] sm:max-w-[480px]">
					<SheetHeader>
						<SheetTitle className="flex items-center gap-2">
							<HistoryIcon className="h-5 w-5" />
							Version History
						</SheetTitle>
						<SheetDescription>
							Click a version to compare with current document
						</SheetDescription>
					</SheetHeader>
					{restoreBlockedText !== null && (
						<span id={rowRestoreBlockedId} className="sr-only">
							{restoreBlockedText}
						</span>
					)}

					<div className="mt-6">
						{isLoading ? (
							<div className="flex items-center justify-center py-8">
								<Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
							</div>
						) : !versions || versions.length === 0 ? (
							<div className="text-center py-8 text-muted-foreground">
								<HistoryIcon className="h-12 w-12 mx-auto mb-3 opacity-50" />
								<p className="font-medium">
									No version history yet
								</p>
								<p className="text-sm mt-1">
									Versions are created automatically when you
									edit the document
								</p>
							</div>
						) : (
							<>
								<div className="flex items-center justify-between mb-4">
									<p className="text-sm text-muted-foreground">
										Current version:{" "}
										<span className="font-medium text-foreground">
											v{currentVersion}
										</span>
									</p>
									<Badge
										variant="outline"
										className="text-xs"
									>
										{versions.length} version
										{versions.length !== 1 ? "s" : ""}
									</Badge>
								</div>
								<ScrollArea className="h-[calc(100vh-240px)] [&>[data-radix-scroll-area-viewport]>div]:w-full">
									<div className="space-y-2 pr-4">
										{versions.map((version) => {
											const isLatest =
												version.version ===
												currentVersion - 1;

											return (
												// biome-ignore lint/a11y/useSemanticElements: list row with nested content; cannot use <button>
												<div
													role="button"
													tabIndex={0}
													key={version.id}
													className={cn(
														"group w-full text-left p-4 rounded-lg border transition-all cursor-pointer",
														"hover:border-primary/40 hover:bg-primary/5",
														isLatest &&
															"border-primary/40 bg-primary/5",
														diffVersion?.id ===
															version.id &&
															showDiffViewer &&
															"ring-2 ring-primary/50",
													)}
													onClick={() =>
														handleVersionClick(
															version,
														)
													}
													onKeyDown={(e) => {
														if (
															e.key === "Enter" ||
															e.key === " "
														) {
															e.preventDefault();
															handleVersionClick(
																version,
															);
														}
													}}
												>
													<div className="flex items-start justify-between gap-2">
														<div className="flex items-center gap-2 min-w-0 overflow-hidden">
															<div className="flex items-center gap-1.5 text-muted-foreground">
																{getChangeIcon(
																	version.changeDescription,
																)}
															</div>
															<span className="font-semibold text-sm">
																v
																{
																	version.version
																}
															</span>
															{isLatest && (
																<Badge
																	variant="outline"
																	className="text-[10px] px-1.5 py-0"
																>
																	Previous
																</Badge>
															)}
														</div>

														<div className="flex items-center gap-1 shrink-0">
															<span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
																<ArrowLeftRight className="h-3 w-3" />
																Compare
															</span>
															<RestoreBlockedTooltip
																text={
																	restoreBlockedText
																}
															>
																<Button
																	variant="ghost"
																	size="sm"
																	className={cn(
																		"h-7 px-2 text-xs text-muted-foreground hover:text-foreground",
																		restoreBlocked &&
																			RESTORE_BLOCKED_CLASS,
																	)}
																	aria-disabled={
																		restoreBlocked ||
																		undefined
																	}
																	aria-describedby={
																		restoreBlocked
																			? rowRestoreBlockedId
																			: undefined
																	}
																	onClick={(
																		e,
																	) =>
																		handleRestoreClick(
																			e,
																			version,
																		)
																	}
																	// Enter or Space on Restore is
																	// Restore's, never the row's
																	// Compare: the row would take
																	// the key and cancel the press.
																	onKeyDown={(
																		e,
																	) => {
																		if (
																			e.key ===
																				"Enter" ||
																			e.key ===
																				" "
																		) {
																			e.stopPropagation();
																		}
																	}}
																>
																	<RotateCcwIcon className="h-3.5 w-3.5 mr-1" />
																	Restore
																</Button>
															</RestoreBlockedTooltip>
														</div>
													</div>

													{version.changeDescription && (
														<p className="text-sm text-muted-foreground mt-1.5 ml-5">
															{
																version.changeDescription
															}
														</p>
													)}

													{version.promptVersion && (
														<div className="flex items-center gap-1.5 mt-1.5 ml-5">
															<SparklesIcon className="h-3 w-3 text-primary/70" />
															<span className="text-xs text-muted-foreground">
																Prompt:{" "}
																<span className="font-medium text-foreground/80">
																	{
																		version
																			.promptVersion
																			.prompt
																			.name
																	}
																</span>
																<span className="text-muted-foreground/70">
																	{" "}
																	v
																	{
																		version
																			.promptVersion
																			.version
																	}
																</span>
															</span>
														</div>
													)}

													<div className="flex items-center gap-3 mt-2 ml-5 text-xs text-muted-foreground">
														<time
															className="flex items-center gap-1"
															dateTime={new Date(
																version.createdAt,
															).toISOString()}
															title={formatDate(
																version.createdAt,
															)}
														>
															<ClockIcon className="h-3 w-3" />
															{formatRelativeTime(
																version.createdAt,
															)}
														</time>
														<VersionAuthorBadge
															author={
																version.author
															}
														/>
														<span className="text-muted-foreground/60">
															{version.content
																? `${countDocumentWords(version.content)} words`
																: ""}
														</span>
													</div>
												</div>
											);
										})}
									</div>
								</ScrollArea>
							</>
						)}
					</div>
				</SheetContent>
			</Sheet>

			{/* Quick Restore Confirmation Dialog */}
			<Dialog
				open={restoreConfirmOpen}
				onOpenChange={setRestoreConfirmOpen}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Restore to Version {restoreTarget?.version}?
						</DialogTitle>
						<DialogDescription>
							This will replace the current document content with
							version {restoreTarget?.version}. Your current
							content will be saved as a new version in history.
						</DialogDescription>
					</DialogHeader>

					{restoreTarget?.changeDescription && (
						<div className="p-3 rounded-lg bg-muted">
							<p className="text-sm font-medium mb-1">
								Version {restoreTarget.version} description:
							</p>
							<p className="text-sm text-muted-foreground">
								{restoreTarget.changeDescription}
							</p>
						</div>
					)}

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setRestoreConfirmOpen(false)}
						>
							Cancel
						</Button>
						<RestoreBlockedTooltip text={restoreBlockedText}>
							<Button
								onClick={handleRestoreConfirm}
								disabled={restoreMutation.isPending}
								aria-disabled={restoreBlocked || undefined}
								aria-describedby={
									restoreBlocked
										? dialogRestoreBlockedId
										: undefined
								}
								className={
									restoreBlocked
										? RESTORE_BLOCKED_CLASS
										: undefined
								}
							>
								{restoreMutation.isPending && (
									<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
								)}
								<RotateCcwIcon className="mr-2 h-4 w-4" />
								Restore
							</Button>
						</RestoreBlockedTooltip>
					</DialogFooter>
					{restoreBlockedText !== null && (
						<span id={dialogRestoreBlockedId} className="sr-only">
							{restoreBlockedText}
						</span>
					)}
				</DialogContent>
			</Dialog>

			{/* Fullscreen Diff Viewer */}
			{showDiffViewer && diffVersion && (
				<VersionDiffViewer
					open={showDiffViewer}
					onOpenChange={setShowDiffViewer}
					selectedVersion={diffVersion}
					currentContent={currentContent}
					currentVersion={currentVersion}
					onRestore={handleDiffViewerRestore}
					isRestoring={restoreMutation.isPending}
					restoreDisabledReason={restoreBlockedText}
				/>
			)}
		</>
	);
}
