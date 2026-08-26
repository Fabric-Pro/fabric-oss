"use client";

import {
	useOrganizationId,
	useOrganizationSlug,
} from "@saas/organizations/hooks/use-organization-context";
import { ProjectFavoriteToggle } from "@saas/projects/components/ProjectFavoriteToggle";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArchiveIcon,
	ArrowRightIcon,
	CheckCircle2Icon,
	FileTextIcon,
	FolderIcon,
	Loader2Icon,
	MoreHorizontalIcon,
	PlayIcon,
	RotateCcwIcon,
	Trash2Icon,
	TrashIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface ProjectCardProps {
	project: {
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
		heroEmojis?: string[];
		heroImageUrl?: string | null;
		createdAt: Date | string;
		updatedAt: Date | string;
		deletedAt?: Date | string | null;
		scheduledPermanentDeleteAt?: Date | string | null;
		organization?: {
			id: string;
			slug: string | null;
			name: string;
		} | null;
		_count?: {
			documents: number;
			contexts: number;
		};
		members?: Array<{
			role: string;
		}>;
	};
	canDelete?: boolean;
	onUpdate: () => void;
	isDeleted?: boolean;
	isSelectionMode?: boolean;
	isSelected?: boolean;
	onSelect?: (id: string, selected: boolean) => void;
}

const statusConfig = {
	DRAFT: {
		label: "Draft",
		className: "bg-muted text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
	ACTIVE: {
		label: "Active",
		className: "bg-success/10 text-success",
		dot: "bg-success",
	},
	COMPLETED: {
		label: "Completed",
		className: "bg-primary/10 text-primary",
		dot: "bg-primary",
	},
	ARCHIVED: {
		label: "Archived",
		className: "bg-highlight/10 text-highlight",
		dot: "bg-highlight",
	},
};

export function ProjectCard({
	project,
	canDelete = false,
	onUpdate,
	isDeleted = false,
	isSelectionMode = false,
	isSelected = false,
	onSelect,
}: ProjectCardProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();
	const organizationSlug = useOrganizationSlug();
	const organizationId = useOrganizationId();
	const [isOpening, setIsOpening] = useState(false);

	const basePath = project.organization?.slug
		? `/app/${project.organization.slug}/projects`
		: organizationSlug
			? `/app/${organizationSlug}/projects`
			: "/app/projects";

	const deleteMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.delete({
				id: project.id,
				organizationId: project.organization?.id ?? organizationId,
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

	const updateStatusMutation = useMutation({
		mutationFn: async (
			status: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
		) => {
			return await orpcClient.projects.update({ id: project.id, status });
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

	const handleDelete = () => {
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
	};

	const handleRestore = () => {
		restoreMutation.mutate();
	};

	const handlePermanentDelete = () => {
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
	};

	const getDaysUntilDeletion = () => {
		if (!project.scheduledPermanentDeleteAt) {
			return null;
		}
		const deleteDate = new Date(project.scheduledPermanentDeleteAt);
		const diffMs = deleteDate.getTime() - Date.now();
		return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
	};

	const daysUntilDeletion = isDeleted ? getDaysUntilDeletion() : null;
	const statusInfo =
		statusConfig[project.status as keyof typeof statusConfig] ??
		statusConfig.DRAFT;
	const tags = project.tags ?? [];
	const docCount = project._count?.documents ?? 0;
	const isCardInteractive = isSelectionMode ? canDelete : !isDeleted;
	const hasMenuActions = !isDeleted || canDelete;

	const navigateToProject = () => {
		if (isOpening) {
			return;
		}
		if (isSelectionMode) {
			if (!canDelete) {
				return;
			}
			onSelect?.(project.id, !isSelected);
			return;
		}
		if (!isDeleted) {
			setIsOpening(true);
			router.push(`${basePath}/${project.id}`);
		}
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: card contains nested interactive elements (Checkbox, buttons); cannot use <button>
		<div
			className={cn(
				"group relative flex flex-col rounded-xl border bg-card transition-colors hover:border-primary/30 hover:bg-muted/20",
				isDeleted && "opacity-70",
				isCardInteractive && "cursor-pointer",
				isSelected && "border-primary ring-2 ring-primary/20",
				isOpening && "pointer-events-none opacity-80",
			)}
			onClick={isCardInteractive ? navigateToProject : undefined}
			onKeyDown={(e) => {
				if (!isCardInteractive) {
					return;
				}
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					navigateToProject();
				}
			}}
			role="button"
			tabIndex={isCardInteractive ? 0 : -1}
		>
			{/* Selection checkbox - absolute top-left */}
			{isSelectionMode && (
				<div className="absolute top-3 left-3 z-10">
					<Checkbox
						checked={isSelected}
						disabled={!canDelete}
						onCheckedChange={(checked) =>
							onSelect?.(project.id, !!checked)
						}
						onClick={(e) => e.stopPropagation()}
						className="bg-background shadow-sm"
					/>
				</div>
			)}

			{/* Header */}
			<div
				className={cn(
					"flex gap-3 p-4 pb-3",
					isSelectionMode && "pl-10",
				)}
			>
				{/* Icon */}
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
					<FolderIcon className="h-4.5 w-4.5 text-primary" />
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-start gap-2">
						<div className="w-0 grow">
							<h3 className="font-semibold text-sm leading-snug group-hover:text-primary transition-colors break-words">
								{project.name}
							</h3>
						</div>
						{/* Status badge + dropdown - inline with title */}
						<div className="flex shrink-0 items-center gap-1 mt-0.5">
							<span
								className={cn(
									"text-[10px] px-1.5 py-0.5 rounded font-medium leading-tight flex items-center gap-1 whitespace-nowrap",
									statusInfo.className,
								)}
							>
								<span
									className={cn(
										"h-1.5 w-1.5 rounded-full shrink-0",
										statusInfo.dot,
									)}
								/>
								{statusInfo.label}
							</span>

							{/* Quick-access favorite (#1694). Hidden in the trash
							    view — a star on a deleted project is nonsense
							    when shortcuts filter deleted projects out — and
							    during selection mode, where the card's click
							    behaviour is replaced. */}
							{!isDeleted && !isSelectionMode && (
								<ProjectFavoriteToggle
									projectId={project.id}
									projectName={project.name}
									isFavorite={project.isFavorite ?? false}
								/>
							)}

							{hasMenuActions && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onClick={(e) => e.stopPropagation()}
										>
											<MoreHorizontalIcon className="h-3.5 w-3.5" />
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
													onClick={() =>
														router.push(
															`${basePath}/${project.id}`,
														)
													}
												>
													<FolderIcon className="h-4 w-4 mr-2" />
													Open Project
												</DropdownMenuItem>
												<DropdownMenuSeparator />
												{project.status !==
													"ACTIVE" && (
													<DropdownMenuItem
														onClick={(e) => {
															e.stopPropagation();
															updateStatusMutation.mutate(
																"ACTIVE",
															);
														}}
													>
														<PlayIcon className="h-4 w-4 mr-2" />
														Mark as Active
													</DropdownMenuItem>
												)}
												{project.status !==
													"COMPLETED" && (
													<DropdownMenuItem
														onClick={(e) => {
															e.stopPropagation();
															updateStatusMutation.mutate(
																"COMPLETED",
															);
														}}
													>
														<CheckCircle2Icon className="h-4 w-4 mr-2" />
														Mark as Completed
													</DropdownMenuItem>
												)}
												{project.status !==
													"ARCHIVED" && (
													<DropdownMenuItem
														onClick={(e) => {
															e.stopPropagation();
															updateStatusMutation.mutate(
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
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{project.description || "No description provided"}
					</p>
				</div>
			</div>

			{/* Tags */}
			{tags.length > 0 && (
				<div className="px-4 pb-3 flex flex-wrap gap-1">
					{tags.slice(0, 3).map((tag) => (
						<Badge
							key={tag}
							variant="secondary"
							className="text-[10px] px-1.5 py-0 font-normal h-4"
						>
							{tag}
						</Badge>
					))}
					{tags.length > 3 && (
						<span className="text-[10px] text-muted-foreground">
							+{tags.length - 3}
						</span>
					)}
				</div>
			)}

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
					{isDeleted && canDelete && daysUntilDeletion !== null ? (
						<span className="text-destructive font-medium">
							{daysUntilDeletion <= 0
								? "Deletes soon"
								: `${daysUntilDeletion}d until permanent deletion`}
						</span>
					) : (
						<>
							<span className="flex items-center gap-1">
								<FileTextIcon className="h-3 w-3" />
								{docCount} docs
							</span>
							{project.updatedAt && (
								<span>
									{formatDistanceToNow(
										typeof project.updatedAt === "string"
											? new Date(project.updatedAt)
											: project.updatedAt,
										{ addSuffix: true },
									)}
								</span>
							)}
						</>
					)}
				</div>

				{isDeleted ? (
					canDelete && (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
							onClick={(e) => {
								e.stopPropagation();
								handleRestore();
							}}
							disabled={restoreMutation.isPending}
						>
							<RotateCcwIcon className="h-3 w-3 mr-1" />
							Restore
						</Button>
					)
				) : isOpening ? (
					<Loader2Icon className="h-3.5 w-3.5 text-primary animate-spin" />
				) : (
					<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
				)}
			</div>
		</div>
	);
}
