"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ProjectFavoriteToggle } from "@saas/projects/components/ProjectFavoriteToggle";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	ArchiveIcon,
	CheckCircle2Icon,
	FileTextIcon,
	FolderIcon,
	MoreVerticalIcon,
	PlayIcon,
	RotateCcwIcon,
	Trash2Icon,
	TrashIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface ProjectsListViewProps {
	projects: Array<{
		id: string;
		userId: string;
		name: string;
		description: string | null;
		status: string;
		projectTypes: string[];
		tags: string[] | null;
		color: string | null;
		icon: string | null;
		/** Caller-scoped favorite state (#1694). */
		isFavorite?: boolean;
		createdAt: Date | string;
		updatedAt: Date | string;
		deletedAt?: Date | string | null;
		scheduledPermanentDeleteAt?: Date | string | null;
		_count?: {
			documents: number;
			contexts: number;
		};
		members?: Array<{
			role: string;
		}>;
	}>;
	canDeleteProject?: (projectId: string) => boolean;
	onUpdate: () => void;
	isDeleted?: boolean;
	isSelectionMode?: boolean;
	selectedIds?: Set<string>;
	onSelect?: (id: string, selected: boolean) => void;
}

const statusConfig = {
	DRAFT: {
		label: "Draft",
		color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
	},
	ACTIVE: {
		label: "Active",
		color: "bg-green-500/10 text-green-700 dark:bg-green-500/20 dark:text-green-400 border-0",
	},
	COMPLETED: {
		label: "Completed",
		color: "bg-blue-500/10 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400 border-0",
	},
	ARCHIVED: {
		label: "Archived",
		color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
	},
};

function ProjectListItem({
	project,
	onUpdate,
	isDeleted = false,
	isSelectionMode = false,
	isSelected = false,
	onSelect,
	canDelete = false,
}: {
	project: ProjectsListViewProps["projects"][0];
	onUpdate: () => void;
	isDeleted?: boolean;
	isSelectionMode?: boolean;
	isSelected?: boolean;
	onSelect?: (id: string, selected: boolean) => void;
	canDelete?: boolean;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();
	const { basePath, organizationId } = useOrganizationContext();

	// Soft delete mutation
	const deleteMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.delete({
				id: project.id,
				organizationId,
			});
		},
		onSuccess: () => {
			toast.success("Project moved to trash", {
				description: "You can restore it within 7 days.",
			});
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			onUpdate();
		},
		onError: (error) => {
			toast.error("Failed to delete project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Restore mutation
	const restoreMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.restore({ id: project.id });
		},
		onSuccess: () => {
			toast.success("Project restored successfully");
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			onUpdate();
		},
		onError: (error) => {
			toast.error("Failed to restore project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Permanent delete mutation
	const permanentDeleteMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.permanentDelete({
				id: project.id,
			});
		},
		onSuccess: () => {
			toast.success("Project permanently deleted");
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			onUpdate();
		},
		onError: (error) => {
			toast.error("Failed to permanently delete project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Update status mutation
	const updateStatusMutation = useMutation({
		mutationFn: async (
			status: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
		) => {
			return await orpcClient.projects.update({
				id: project.id,
				status,
			});
		},
		onSuccess: () => {
			toast.success("Project status updated");
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			onUpdate();
		},
		onError: (error) => {
			toast.error("Failed to update project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	function handleDelete() {
		confirm({
			title: "Delete Project",
			message: `Are you sure you want to delete "${project.name}"? The project will be moved to trash and automatically deleted after 7 days.`,
			confirmLabel: "Delete",
			cancelLabel: "Cancel",
			destructive: true,
			onConfirm: () => {
				deleteMutation.mutate();
			},
		});
	}

	function handleRestore() {
		restoreMutation.mutate();
	}

	function handlePermanentDelete() {
		confirm({
			title: "Permanently Delete Project",
			message: `Are you sure you want to PERMANENTLY delete "${project.name}"? This will delete all documents, contexts, and data. This action CANNOT be undone.`,
			confirmLabel: "Delete Forever",
			cancelLabel: "Cancel",
			destructive: true,
			onConfirm: () => {
				permanentDeleteMutation.mutate();
			},
		});
	}

	function handleStatusChange(
		status: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
	) {
		updateStatusMutation.mutate(status);
	}

	// Calculate days until permanent deletion for deleted projects
	const getDaysUntilDeletion = () => {
		if (!project.scheduledPermanentDeleteAt) {
			return null;
		}
		const deleteDate = new Date(project.scheduledPermanentDeleteAt);
		const now = new Date();
		const diffMs = deleteDate.getTime() - now.getTime();
		const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
		return diffDays;
	};

	const daysUntilDeletion = isDeleted ? getDaysUntilDeletion() : null;
	const hasMenuActions = !isDeleted || canDelete;

	const statusInfo =
		statusConfig[project.status as keyof typeof statusConfig] ||
		statusConfig.DRAFT;

	const handleCardClick = () => {
		if (isSelectionMode) {
			if (!canDelete) {
				return;
			}
			onSelect?.(project.id, !isSelected);
			return;
		}
		if (!isDeleted) {
			router.push(`${basePath}/projects/${project.id}`);
		}
	};

	return (
		<Card
			className={`transition-all group ${isDeleted ? "opacity-75" : "hover:shadow-md"} ${isSelected ? "border-primary ring-2 ring-primary/20" : ""}`}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: contains nested Checkbox (a button); cannot use <button> */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: contains nested Checkbox (a button); cannot use <button> */}
			<div
				className={`w-full text-left p-4 ${(isSelectionMode ? canDelete : !isDeleted) ? "cursor-pointer" : ""}`}
				onClick={handleCardClick}
			>
				<div className="flex items-start justify-between gap-4">
					{isSelectionMode && (
						<div className="pt-0.5 shrink-0">
							<Checkbox
								checked={isSelected}
								disabled={!canDelete}
								onCheckedChange={(checked) =>
									onSelect?.(project.id, !!checked)
								}
								onClick={(e) => e.stopPropagation()}
							/>
						</div>
					)}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-3 mb-2">
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<span className="inline-block">
										<h3 className="font-semibold text-base line-clamp-1">
											{project.name}
										</h3>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									<p>{project.name}</p>
								</TooltipContent>
							</Tooltip>
							<Badge className={statusInfo.color}>
								{statusInfo.label}
							</Badge>
						</div>

						{project.description && (
							<p className="text-sm text-muted-foreground line-clamp-1 mb-3">
								{project.description}
							</p>
						)}

						<div className="flex items-center gap-4 text-sm text-muted-foreground">
							{/* Tags */}
							{project.tags && project.tags.length > 0 && (
								<div className="flex flex-wrap gap-1.5">
									{project.tags.slice(0, 3).map((tag) => (
										<Badge
											key={tag}
											variant="secondary"
											className="text-xs font-normal"
										>
											{tag}
										</Badge>
									))}
									{project.tags.length > 3 && (
										<Badge
											variant="secondary"
											className="text-xs font-normal"
										>
											+{project.tags.length - 3}
										</Badge>
									)}
								</div>
							)}
						</div>
					</div>

					<div className="flex items-center gap-6 text-sm text-muted-foreground shrink-0">
						<div className="flex items-center gap-1">
							<FileTextIcon className="h-4 w-4" />
							<span>
								{project._count?.documents || 0} / 6 documents
								generated
							</span>
						</div>

						{isDeleted &&
						canDelete &&
						daysUntilDeletion !== null ? (
							<div className="text-xs min-w-[150px] text-right text-destructive font-medium">
								{daysUntilDeletion <= 0
									? "Will be deleted soon"
									: daysUntilDeletion === 1
										? "1 day until deletion"
										: `${daysUntilDeletion} days until deletion`}
							</div>
						) : (
							project.updatedAt && (
								<div className="text-xs min-w-[120px] text-right">
									Updated{" "}
									{formatDistanceToNow(
										typeof project.updatedAt === "string"
											? new Date(project.updatedAt)
											: project.updatedAt,
										{
											addSuffix: true,
										},
									)}
								</div>
							)
						)}

						{isDeleted && canDelete && (
							<Button
								variant="outline"
								size="sm"
								onClick={(e) => {
									e.stopPropagation();
									handleRestore();
								}}
								disabled={restoreMutation.isPending}
								className="opacity-0 group-hover:opacity-100 transition-opacity"
							>
								<RotateCcwIcon className="h-4 w-4 mr-1" />
								{restoreMutation.isPending
									? "Restoring..."
									: "Restore"}
							</Button>
						)}

						{/* Quick-access favorite (#1694) — same conditions as the
						    grid card, so the two views never disagree. */}
						{!isDeleted && !isSelectionMode && (
							<ProjectFavoriteToggle
								projectId={project.id}
								projectName={project.name}
								isFavorite={project.isFavorite ?? false}
							/>
						)}

						{hasMenuActions && (
							<DropdownMenu>
								<DropdownMenuTrigger
									asChild
									onClick={(e) => e.stopPropagation()}
								>
									<Button
										variant="ghost"
										size="icon-sm"
										className="opacity-0 group-hover:opacity-100 transition-opacity"
									>
										<MoreVerticalIcon className="h-4 w-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{isDeleted ? (
										canDelete && (
											<>
												<DropdownMenuItem
													onClick={(e) => {
														e.stopPropagation();
														handleRestore();
													}}
													disabled={
														restoreMutation.isPending
													}
												>
													<RotateCcwIcon className="h-4 w-4 mr-2" />
													{restoreMutation.isPending
														? "Restoring..."
														: "Restore Project"}
												</DropdownMenuItem>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													onClick={(e) => {
														e.stopPropagation();
														handlePermanentDelete();
													}}
													className="text-destructive focus:text-destructive"
													disabled={
														permanentDeleteMutation.isPending
													}
												>
													<Trash2Icon className="h-4 w-4 mr-2" />
													{permanentDeleteMutation.isPending
														? "Deleting..."
														: "Delete Permanently"}
												</DropdownMenuItem>
											</>
										)
									) : (
										<>
											<DropdownMenuItem
												onClick={(e) => {
													e.stopPropagation();
													router.push(
														`${basePath}/projects/${project.id}`,
													);
												}}
											>
												<FolderIcon className="h-4 w-4 mr-2" />
												Open Project
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											{project.status !== "ACTIVE" && (
												<DropdownMenuItem
													onClick={(e) => {
														e.stopPropagation();
														handleStatusChange(
															"ACTIVE",
														);
													}}
												>
													<PlayIcon className="h-4 w-4 mr-2" />
													Mark as Active
												</DropdownMenuItem>
											)}
											{project.status !== "COMPLETED" && (
												<DropdownMenuItem
													onClick={(e) => {
														e.stopPropagation();
														handleStatusChange(
															"COMPLETED",
														);
													}}
												>
													<CheckCircle2Icon className="h-4 w-4 mr-2" />
													Mark as Completed
												</DropdownMenuItem>
											)}
											{project.status !== "ARCHIVED" && (
												<DropdownMenuItem
													onClick={(e) => {
														e.stopPropagation();
														handleStatusChange(
															"ARCHIVED",
														);
													}}
												>
													<ArchiveIcon className="h-4 w-4 mr-2" />
													Archive
												</DropdownMenuItem>
											)}
											{canDelete && (
												<>
													<DropdownMenuSeparator />
													<DropdownMenuItem
														onClick={(e) => {
															e.stopPropagation();
															handleDelete();
														}}
														className="text-destructive focus:text-destructive"
													>
														<TrashIcon className="h-4 w-4 mr-2" />
														Delete
													</DropdownMenuItem>
												</>
											)}
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				</div>
			</div>
		</Card>
	);
}

export function ProjectsListView({
	projects,
	canDeleteProject,
	onUpdate,
	isDeleted = false,
	isSelectionMode = false,
	selectedIds,
	onSelect,
}: ProjectsListViewProps) {
	return (
		<div className="space-y-3">
			{projects.map((project) => (
				<ProjectListItem
					key={project.id}
					project={project}
					canDelete={canDeleteProject?.(project.id) ?? false}
					onUpdate={onUpdate}
					isDeleted={isDeleted}
					isSelectionMode={isSelectionMode}
					isSelected={selectedIds?.has(project.id) ?? false}
					onSelect={onSelect}
				/>
			))}
		</div>
	);
}
