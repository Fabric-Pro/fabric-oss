"use client";

/**
 * Version History Panel
 * Shows version history for a workflow with rollback capability
 */

import { orpcClient } from "@shared/lib/orpc-client";
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
	CheckCircle2Icon,
	ClockIcon,
	HistoryIcon,
	Loader2Icon,
	RotateCcwIcon,
	UserIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

interface VersionHistoryPanelProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workflowId: string;
	currentVersion: number;
	publishedVersion?: number | null;
}

interface WorkflowVersion {
	id: string;
	version: number;
	changelog: string | null;
	isPublished: boolean;
	publishedAt: Date | null;
	createdBy: string | null;
	createdAt: Date;
}

export function VersionHistoryPanel({
	open,
	onOpenChange,
	workflowId,
	currentVersion,
	publishedVersion,
}: VersionHistoryPanelProps) {
	const [rollbackTarget, setRollbackTarget] =
		useState<WorkflowVersion | null>(null);
	const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);

	const queryClient = useQueryClient();

	// Fetch version history
	const { data: versions, isLoading } = useQuery({
		queryKey: ["workflow-versions", workflowId],
		queryFn: async () => {
			const result = await orpcClient.workflows.versions.list({
				id: workflowId,
			});
			return result.versions as WorkflowVersion[];
		},
		enabled: open,
	});

	// Rollback mutation
	const rollbackMutation = useMutation({
		mutationFn: async (targetVersion: number) => {
			return await orpcClient.workflows.publish.rollback({
				workflowId,
				targetVersion,
			});
		},
		onSuccess: (data) => {
			toast.success(data.message);
			queryClient.invalidateQueries({
				queryKey: ["workflow", workflowId],
			});
			queryClient.invalidateQueries({
				queryKey: ["workflow-versions", workflowId],
			});
			setRollbackConfirmOpen(false);
			setRollbackTarget(null);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to rollback workflow",
			);
		},
	});

	const handleRollbackClick = useCallback((version: WorkflowVersion) => {
		setRollbackTarget(version);
		setRollbackConfirmOpen(true);
	}, []);

	const handleRollbackConfirm = useCallback(() => {
		if (rollbackTarget) {
			rollbackMutation.mutate(rollbackTarget.version);
		}
	}, [rollbackTarget, rollbackMutation]);

	const formatDate = (date: Date) => {
		return new Intl.DateTimeFormat("en-US", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(date));
	};

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent className="w-[400px] sm:w-[540px]">
					<SheetHeader>
						<SheetTitle className="flex items-center gap-2">
							<HistoryIcon className="h-5 w-5" />
							Version History
						</SheetTitle>
						<SheetDescription>
							View and manage previous versions of this workflow
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
								<p>No versions yet</p>
								<p className="text-sm">
									Publish your workflow to create the first
									version
								</p>
							</div>
						) : (
							<ScrollArea className="h-[calc(100vh-200px)]">
								<div className="space-y-3 pr-4">
									{versions.map((version) => {
										const isCurrentVersion =
											version.version === currentVersion;
										const isPublishedVersion =
											version.version ===
											publishedVersion;

										return (
											<div
												key={version.id}
												className={cn(
													"p-4 rounded-lg border transition-colors",
													isCurrentVersion &&
														"border-primary bg-primary/5",
													isPublishedVersion &&
														!isCurrentVersion &&
														"border-green-500/50 bg-green-50/50 dark:bg-green-950/20",
												)}
											>
												<div className="flex items-start justify-between">
													<div className="flex items-center gap-2">
														<span className="font-semibold">
															v{version.version}
														</span>
														{isCurrentVersion && (
															<Badge
																variant="outline"
																className="text-xs"
															>
																Current
															</Badge>
														)}
														{isPublishedVersion && (
															<Badge
																variant="outline"
																className="text-xs bg-green-100 text-green-700 border-green-300 dark:bg-green-900 dark:text-green-300 dark:border-green-700"
															>
																<CheckCircle2Icon className="h-3 w-3 mr-1" />
																Published
															</Badge>
														)}
													</div>

													{!isCurrentVersion && (
														<Button
															variant="ghost"
															size="sm"
															onClick={() =>
																handleRollbackClick(
																	version,
																)
															}
															className="text-muted-foreground hover:text-foreground"
														>
															<RotateCcwIcon className="h-4 w-4 mr-1" />
															Rollback
														</Button>
													)}
												</div>

												{version.changelog && (
													<p className="text-sm text-muted-foreground mt-2">
														{version.changelog}
													</p>
												)}

												<div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
													<span className="flex items-center gap-1">
														<ClockIcon className="h-3 w-3" />
														{formatDate(
															version.createdAt,
														)}
													</span>
													{version.createdBy && (
														<span className="flex items-center gap-1">
															<UserIcon className="h-3 w-3" />
															{version.createdBy}
														</span>
													)}
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

			{/* Rollback Confirmation Dialog */}
			<Dialog
				open={rollbackConfirmOpen}
				onOpenChange={setRollbackConfirmOpen}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Rollback to Version {rollbackTarget?.version}?
						</DialogTitle>
						<DialogDescription>
							This will create a new version with the content from
							version {rollbackTarget?.version}. The current
							version will be preserved in history.
						</DialogDescription>
					</DialogHeader>

					{rollbackTarget?.changelog && (
						<div className="p-3 rounded-lg bg-muted">
							<p className="text-sm font-medium mb-1">
								Version {rollbackTarget.version} changelog:
							</p>
							<p className="text-sm text-muted-foreground">
								{rollbackTarget.changelog}
							</p>
						</div>
					)}

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setRollbackConfirmOpen(false)}
						>
							Cancel
						</Button>
						<Button
							onClick={handleRollbackConfirm}
							disabled={rollbackMutation.isPending}
						>
							{rollbackMutation.isPending && (
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
							)}
							<RotateCcwIcon className="mr-2 h-4 w-4" />
							Rollback
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
