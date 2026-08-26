"use client";

/**
 * Feature Version History Panel
 * Shows version history for a feature (user story) with diff comparison and restore capability.
 * Clicking a version opens a fullscreen diff viewer (VersionDiffViewer).
 */

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
import {
	ArrowLeftRight,
	ClockIcon,
	FileTextIcon,
	HistoryIcon,
	Loader2Icon,
	RotateCcwIcon,
	SparklesIcon,
	UserIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { FeatureDraftingStage } from "../../lib/stories/types";
import { DRAFTING_STAGE_META } from "../../lib/stories/types";
import { VersionDiffViewer } from "../VersionDiffViewer";

interface FeatureVersionHistoryProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	storyId: string;
	currentVersion: number;
	currentDescription: string;
	currentAcceptanceCriteria: string;
	organizationId: string | null | undefined;
	onRestore?: () => void;
}

interface FeatureVersion {
	id: string;
	version: number;
	description: string | null;
	acceptanceCriteria: string | null;
	draftingStage: FeatureDraftingStage;
	changeDescription: string | null;
	changedBy: string | null;
	createdAt: string;
}

function buildFeatureContent(
	description: string | null,
	acceptanceCriteria: string | null,
): string {
	const parts: string[] = [];
	if (description) {
		parts.push(`## Description\n\n${description}`);
	}
	if (acceptanceCriteria) {
		parts.push(`## Acceptance Criteria\n\n${acceptanceCriteria}`);
	}
	return parts.join("\n\n") || "(empty)";
}

export function FeatureVersionHistory({
	open,
	onOpenChange,
	projectId,
	storyId,
	currentVersion,
	currentDescription,
	currentAcceptanceCriteria,
	organizationId,
	onRestore,
}: FeatureVersionHistoryProps) {
	const [restoreTarget, setRestoreTarget] = useState<FeatureVersion | null>(
		null,
	);
	const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
	const [showDiffViewer, setShowDiffViewer] = useState(false);
	const [diffVersion, setDiffVersion] = useState<FeatureVersion | null>(null);

	const queryClient = useQueryClient();

	// Fetch version history
	const { data, isLoading } = useQuery({
		...orpc.projects.stories.versions.list.queryOptions({
			input: {
				projectId,
				storyId,
				organizationId,
			},
		}),
		enabled: open,
	});

	const versions = data?.versions as FeatureVersion[] | undefined;

	// Restore mutation
	const restoreMutation = useMutation(
		orpc.projects.stories.versions.restore.mutationOptions({
			onError: (error) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to restore version",
				);
			},
		}),
	);

	const handleRestoreClick = useCallback(
		(e: React.MouseEvent, version: FeatureVersion) => {
			e.stopPropagation();
			setRestoreTarget(version);
			setRestoreConfirmOpen(true);
		},
		[],
	);

	const handleRestoreConfirm = useCallback(() => {
		if (restoreTarget) {
			restoreMutation.mutate(
				{
					projectId,
					storyId,
					versionNumber: restoreTarget.version,
					organizationId,
				},
				{
					onSuccess: () => {
						toast.success(
							`Restored to version ${restoreTarget.version}`,
						);
						queryClient.invalidateQueries({
							queryKey:
								orpc.projects.stories.versions.list.queryKey({
									input: {
										projectId,
										storyId,
										organizationId,
									},
								}),
						});
						setRestoreConfirmOpen(false);
						setRestoreTarget(null);
						onRestore?.();
					},
				},
			);
		}
	}, [
		restoreTarget,
		restoreMutation,
		projectId,
		storyId,
		organizationId,
		queryClient,
		onRestore,
	]);

	const handleVersionClick = useCallback(
		(version: FeatureVersion) => {
			setDiffVersion(version);
			setShowDiffViewer(true);
			onOpenChange(false);
		},
		[onOpenChange],
	);

	const handleDiffViewerRestore = useCallback(() => {
		if (diffVersion) {
			restoreMutation.mutate(
				{
					projectId,
					storyId,
					versionNumber: diffVersion.version,
					organizationId,
				},
				{
					onSuccess: () => {
						toast.success(
							`Restored to version ${diffVersion.version}`,
						);
						queryClient.invalidateQueries({
							queryKey:
								orpc.projects.stories.versions.list.queryKey({
									input: {
										projectId,
										storyId,
										organizationId,
									},
								}),
						});
						setShowDiffViewer(false);
						onRestore?.();
					},
				},
			);
		}
	}, [
		diffVersion,
		restoreMutation,
		projectId,
		storyId,
		organizationId,
		queryClient,
		onRestore,
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
		if (
			lower.includes("ai-enhanced") ||
			lower.includes("generated") ||
			lower.includes("ai-combined")
		) {
			return <SparklesIcon className="h-3.5 w-3.5" />;
		}
		if (lower.includes("restored")) {
			return <RotateCcwIcon className="h-3.5 w-3.5" />;
		}
		return <FileTextIcon className="h-3.5 w-3.5" />;
	};

	const currentContent = buildFeatureContent(
		currentDescription,
		currentAcceptanceCriteria,
	);

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent className="w-[400px] max-w-[90vw] sm:w-[480px] sm:max-w-[480px]">
					<SheetHeader>
						<SheetTitle className="flex items-center gap-2">
							<HistoryIcon className="h-5 w-5" />
							Feature Version History
						</SheetTitle>
						<SheetDescription>
							Click a version to compare with current feature
						</SheetDescription>
					</SheetHeader>

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
									Versions are created when you enhance the
									feature or restore a previous version
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
											const stageMeta =
												DRAFTING_STAGE_META[
													version.draftingStage
												];

											return (
												// biome-ignore lint/a11y/useSemanticElements: list row with nested content; cannot use <button>
												<div
													role="button"
													tabIndex={0}
													key={version.id}
													className={cn(
														"group w-full text-left p-4 rounded-lg border transition-colors cursor-pointer",
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
															{stageMeta && (
																<Badge
																	variant="outline"
																	className="text-[10px] px-1.5 py-0"
																	style={{
																		borderColor:
																			stageMeta.color,
																		color: stageMeta.color,
																	}}
																>
																	{
																		stageMeta.label
																	}
																</Badge>
															)}
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
															<Button
																variant="ghost"
																size="sm"
																className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
																onClick={(e) =>
																	handleRestoreClick(
																		e,
																		version,
																	)
																}
															>
																<RotateCcwIcon className="h-3.5 w-3.5 mr-1" />
																Restore
															</Button>
														</div>
													</div>

													{version.changeDescription && (
														<p className="text-sm text-muted-foreground mt-1.5 ml-5">
															{
																version.changeDescription
															}
														</p>
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
														{version.changedBy && (
															<span className="flex items-center gap-1">
																<UserIcon className="h-3 w-3" />
																Editor
															</span>
														)}
														<span className="text-muted-foreground/60">
															{(() => {
																const content =
																	buildFeatureContent(
																		version.description,
																		version.acceptanceCriteria,
																	);
																return `${content.split(/\s+/).length} words`;
															})()}
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
							This will replace the current feature content with
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
						<Button
							onClick={handleRestoreConfirm}
							disabled={restoreMutation.isPending}
						>
							{restoreMutation.isPending && (
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
							)}
							<RotateCcwIcon className="mr-2 h-4 w-4" />
							Restore
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Fullscreen Diff Viewer */}
			{showDiffViewer && diffVersion && (
				<VersionDiffViewer
					open={showDiffViewer}
					onOpenChange={setShowDiffViewer}
					selectedVersion={{
						id: diffVersion.id,
						version: diffVersion.version,
						content: buildFeatureContent(
							diffVersion.description,
							diffVersion.acceptanceCriteria,
						),
						changeDescription: diffVersion.changeDescription,
						changedBy: diffVersion.changedBy,
						createdAt: diffVersion.createdAt,
					}}
					currentContent={currentContent}
					currentVersion={currentVersion}
					onRestore={handleDiffViewerRestore}
					isRestoring={restoreMutation.isPending}
				/>
			)}
		</>
	);
}
