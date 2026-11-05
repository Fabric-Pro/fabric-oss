"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { SearchInput } from "@ui/components/search-input";
import { Switch } from "@ui/components/switch";
import { TooltipProvider } from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	GridIcon,
	ListIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ComponentProps, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { shouldShowSharedProjects } from "../lib/shared-projects-visibility";
import { DraftProjectBanner } from "./DraftProjectBanner";
import { ProjectCard } from "./ProjectCard";
import { ProjectsHero } from "./ProjectsHero";
import { ProjectsListView } from "./ProjectsListView";

type ViewMode = "grid" | "list";
type FilterMode =
	| "all"
	| "DRAFT"
	| "ACTIVE"
	| "COMPLETED"
	| "ARCHIVED"
	| "deleted";
type ProjectStatusFilter = Exclude<FilterMode, "all" | "deleted">;
type ListedProject = ComponentProps<typeof ProjectCard>["project"];

const SHOW_ALL_PROJECTS_STORAGE_KEY = "fabric-projects-show-all";

export function ProjectsList() {
	const router = useRouter();
	const { user } = useSession();
	const { organizationId, basePath } = useOrganizationContext();
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [statusFilter, setStatusFilter] = useState<FilterMode>("all");
	const [viewMode, setViewMode] = useState<ViewMode>("grid");
	const [isSelectionMode, setIsSelectionMode] = useState(false);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [isCreatingProject, setIsCreatingProject] = useState(false);

	const projectsBasePath = `${basePath}/projects`;
	const isShowingDeleted = statusFilter === "deleted";
	const handleCreateProject = () => {
		if (isCreatingProject) {
			return;
		}
		setIsCreatingProject(true);
		router.push(`${projectsBasePath}/new`);
	};

	// Admins inherit Project Editor on the reports of every live project, so they
	// may list projects they hold no row on. Off until they ask, so the list
	// stays their own. The server decides again.
	const reportSuite = useFeatureFlag("REPORT_SUITE_V2");
	const { data: reportCapabilities } = useQuery({
		...orpc.reports.capabilities.queryOptions({ input: {} }),
		enabled: reportSuite && organizationId !== null,
		retry: false,
	});
	const canListAllProjects =
		reportCapabilities?.isOrganizationAdmin === true ||
		reportCapabilities?.isPlatformAdmin === true;
	// Kept for this browser tab, so Back from a project finds the same list.
	const showAllProjectsKey = `${SHOW_ALL_PROJECTS_STORAGE_KEY}-${organizationId}`;
	const [showAllProjects, setShowAllProjects] = useState(
		() =>
			typeof window !== "undefined" &&
			sessionStorage.getItem(showAllProjectsKey) === "true",
	);
	const changeShowAllProjects = (show: boolean) => {
		setShowAllProjects(show);
		sessionStorage.setItem(showAllProjectsKey, String(show));
	};

	// Fetch projects - organizationId is null for personal context (safe)
	const { data, isLoading, refetch } = useQuery(
		orpc.projects.list.queryOptions({
			input: {
				organizationId,
				limit: 50,
				offset: 0,
				search: debouncedSearch || undefined,
				deletedOnly: isShowingDeleted,
				// Return per-status tab counts in this one call instead of
				// firing a separate list query per filter tab.
				includeStatusCounts: true,
				includeDraft:
					statusFilter === "all" || statusFilter === "deleted",
				status:
					statusFilter === "all" || statusFilter === "deleted"
						? undefined
						: (statusFilter as
								| "DRAFT"
								| "ACTIVE"
								| "COMPLETED"
								| "ARCHIVED"),
			},
		}),
	);

	const listsAllProjects =
		canListAllProjects &&
		showAllProjects &&
		!isShowingDeleted &&
		statusFilter !== "DRAFT";
	const {
		data: allProjectsData,
		isLoading: isLoadingAllProjects,
		refetch: refetchAllProjects,
	} = useQuery({
		...orpc.reports.organizationProjects.queryOptions({
			input: {
				organizationId,
				limit: 50,
				offset: 0,
				search: debouncedSearch || undefined,
				status:
					statusFilter === "all" || statusFilter === "deleted"
						? undefined
						: (statusFilter as "ACTIVE" | "COMPLETED" | "ARCHIVED"),
			},
		}),
		enabled: listsAllProjects,
	});
	const refetchProjects = () => {
		refetch();
		if (listsAllProjects) {
			refetchAllProjects();
		}
	};

	const projects: ListedProject[] =
		(listsAllProjects ? allProjectsData?.projects : data?.projects) ?? [];
	const ownerDeletedCount = data?.ownerDeletedCount ?? 0;

	// "Shared with me" — org projects where the user is a project-scoped
	// guest. Personal context only; independent of the status filter pills
	// and search above. Hidden entirely when empty.
	const tShared = useTranslations("projects.sharedWithMe");
	const isPersonalContext = organizationId === null;
	const { data: guestData, refetch: refetchGuestProjects } = useQuery({
		...orpc.projects.listGuest.queryOptions(),
		enabled: isPersonalContext,
	});
	const guestProjects = guestData?.projects ?? [];
	const showSharedProjects = shouldShowSharedProjects({
		organizationId,
		guestProjectCount: guestProjects.length,
	});

	// Per-status tab counts now come from the single list query above
	// (includeStatusCounts), instead of one extra list query per status.
	const statusCounts =
		(listsAllProjects
			? allProjectsData?.statusCounts
			: data?.statusCounts) ?? {};

	const getStatusTotal = (status: ProjectStatusFilter) =>
		statusCounts[status as string] ?? 0;
	const ownerProjectIds = new Set(
		projects
			.filter(
				(project) =>
					project.userId === user?.id ||
					project.members?.some((member) => member.role === "OWNER"),
			)
			.map((project) => project.id),
	);
	const ownerProjects = projects.filter((project) =>
		ownerProjectIds.has(project.id),
	);
	// An admin's list holds projects they reach through their organization role
	// alone: only Reports opens for them there, so nothing else is offered.
	const belongsToProject = (project: ListedProject) =>
		project.userId === user?.id || (project.members?.length ?? 0) > 0;
	const visibleProjects = isShowingDeleted ? ownerProjects : projects;

	const bulkDeleteMutation = useMutation({
		mutationFn: async (ids: string[]) => {
			return await orpcClient.projects.bulkDelete({
				ids,
				organizationId,
			});
		},
		onSuccess: (result) => {
			const msg =
				result.skippedCount > 0
					? `${result.deletedCount} project${result.deletedCount !== 1 ? "s" : ""} moved to trash (${result.skippedCount} skipped — not owner)`
					: `${result.deletedCount} project${result.deletedCount !== 1 ? "s" : ""} moved to trash`;
			toast.success(msg);
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			setSelectedIds(new Set());
			setIsSelectionMode(false);
			refetch();
		},
		onError: (error) => {
			toast.error("Failed to delete projects", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleSelect = (id: string, selected: boolean) => {
		if (selected && !ownerProjectIds.has(id)) {
			return;
		}
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (selected) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	};

	const handleSelectAll = (checked: boolean) => {
		if (checked) {
			setSelectedIds(new Set(ownerProjects.map((project) => project.id)));
		} else {
			setSelectedIds(new Set());
		}
	};

	const handleBulkDelete = () => {
		const count = selectedIds.size;
		confirm({
			title: "Delete Projects",
			message: `Are you sure you want to delete ${count} project${count !== 1 ? "s" : ""}? They will be moved to trash and automatically deleted after 7 days.`,
			confirmLabel: "Delete",
			cancelLabel: "Cancel",
			destructive: true,
			onConfirm: () => {
				bulkDeleteMutation.mutate(
					Array.from(selectedIds).filter((id) =>
						ownerProjectIds.has(id),
					),
				);
			},
		});
	};

	const exitSelectionMode = () => {
		setIsSelectionMode(false);
		setSelectedIds(new Set());
	};

	// Status tab counts should not depend on the currently selected tab.
	const draftCount = getStatusTotal("DRAFT");
	const activeCount = getStatusTotal("ACTIVE");
	const completedCount = getStatusTotal("COMPLETED");
	const archivedCount = getStatusTotal("ARCHIVED");
	const allCount = draftCount + activeCount + completedCount + archivedCount;

	return (
		<div className="space-y-8">
			{/* Draft resume banner */}
			<DraftProjectBanner />

			{/* Hero Section */}
			<ProjectsHero />

			{/* Status Filter Pills */}
			<div
				data-onboarding-target="projects-status-filter"
				className="flex flex-wrap items-center gap-2"
			>
				<button
					type="button"
					onClick={() => setStatusFilter("all")}
					aria-pressed={statusFilter === "all"}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						statusFilter === "all"
							? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
							: "border-border bg-card text-foreground hover:bg-muted/60",
					)}
				>
					All ({allCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("DRAFT")}
					aria-pressed={statusFilter === "DRAFT"}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						statusFilter === "DRAFT"
							? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
							: "border-border bg-card text-foreground hover:bg-muted/60",
					)}
				>
					Draft ({draftCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("ACTIVE")}
					aria-pressed={statusFilter === "ACTIVE"}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						statusFilter === "ACTIVE"
							? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
							: "border-border bg-card text-foreground hover:bg-muted/60",
					)}
				>
					Active ({activeCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("COMPLETED")}
					aria-pressed={statusFilter === "COMPLETED"}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						statusFilter === "COMPLETED"
							? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
							: "border-border bg-card text-foreground hover:bg-muted/60",
					)}
				>
					Completed ({completedCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("ARCHIVED")}
					aria-pressed={statusFilter === "ARCHIVED"}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						statusFilter === "ARCHIVED"
							? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
							: "border-border bg-card text-foreground hover:bg-muted/60",
					)}
				>
					Archived ({archivedCount})
				</button>
				{/* Deleted filter pill - only show if user owns deleted projects */}
				{ownerDeletedCount > 0 && (
					<button
						type="button"
						onClick={() => setStatusFilter("deleted")}
						aria-pressed={statusFilter === "deleted"}
						className={cn(
							"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
							statusFilter === "deleted"
								? "bg-destructive text-destructive-foreground border-destructive"
								: "bg-destructive/10 hover:bg-destructive/20 text-destructive border-destructive/30",
						)}
					>
						<Trash2Icon className="h-3.5 w-3.5" />
						Deleted ({ownerDeletedCount})
					</button>
				)}
			</div>

			{/* Bulk Action Toolbar */}
			{isSelectionMode && (
				<div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5">
					<Checkbox
						checked={
							selectedIds.size === ownerProjects.length &&
							ownerProjects.length > 0
						}
						onCheckedChange={handleSelectAll}
						aria-label="Select all"
					/>
					<span className="text-sm text-muted-foreground flex-1">
						{selectedIds.size > 0
							? `${selectedIds.size} selected`
							: "Select projects"}
					</span>
					<Button
						variant="destructive"
						size="sm"
						disabled={
							selectedIds.size === 0 ||
							bulkDeleteMutation.isPending
						}
						onClick={handleBulkDelete}
					>
						<Trash2Icon className="h-4 w-4 mr-2" />
						{bulkDeleteMutation.isPending
							? "Deleting..."
							: `Delete (${selectedIds.size})`}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={exitSelectionMode}
					>
						<XIcon className="h-4 w-4 mr-1" />
						Cancel
					</Button>
				</div>
			)}

			{/* Actions Bar */}
			<div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
				{/* Search */}
				<div
					data-onboarding-target="projects-search"
					className="relative flex-1 max-w-md w-full"
				>
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search projects..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{/* Under Draft the list stays the person's own, so it would do nothing. */}
					{canListAllProjects &&
						!isShowingDeleted &&
						statusFilter !== "DRAFT" && (
							<div className="flex items-center gap-2 pr-2">
								<Switch
									id="all-organization-projects"
									checked={showAllProjects}
									onCheckedChange={changeShowAllProjects}
								/>
								<Label
									htmlFor="all-organization-projects"
									className="text-muted-foreground text-sm"
								>
									All organization projects
								</Label>
							</div>
						)}

					{/* View Toggle */}
					<div className="flex gap-1 border rounded-md p-1">
						<Button
							variant={viewMode === "grid" ? "default" : "ghost"}
							size="icon-sm"
							onClick={() => setViewMode("grid")}
							aria-label="Grid view"
						>
							<GridIcon className="h-4 w-4" />
						</Button>
						<Button
							variant={viewMode === "list" ? "default" : "ghost"}
							size="icon-sm"
							onClick={() => setViewMode("list")}
							aria-label="List view"
						>
							<ListIcon className="h-4 w-4" />
						</Button>
					</div>

					{/* Select Toggle */}
					{!isShowingDeleted && visibleProjects.length > 0 && (
						<Button
							variant={isSelectionMode ? "secondary" : "outline"}
							size="sm"
							onClick={() => {
								if (isSelectionMode) {
									exitSelectionMode();
								} else {
									setIsSelectionMode(true);
								}
							}}
						>
							{isSelectionMode ? "Cancel" : "Select"}
						</Button>
					)}

					{/* Create Button */}
					<Button
						data-onboarding-target="projects-new"
						onClick={handleCreateProject}
						loading={isCreatingProject}
						disabled={isCreatingProject}
					>
						<PlusIcon className="h-4 w-4 mr-2" />
						New Project
					</Button>
				</div>
			</div>

			{/* Projects Display */}
			{isLoading || (listsAllProjects && isLoadingAllProjects) ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : visibleProjects.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-muted-foreground mb-4">
						{searchQuery || statusFilter !== "all"
							? "No projects found matching your filters"
							: "No projects yet. Create your first project to get started!"}
					</p>
					{!searchQuery && statusFilter === "all" && (
						<Button
							onClick={handleCreateProject}
							loading={isCreatingProject}
							disabled={isCreatingProject}
						>
							<PlusIcon className="h-4 w-4 mr-2" />
							Create Your First Project
						</Button>
					)}
				</div>
			) : viewMode === "grid" ? (
				<TooltipProvider>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
						{visibleProjects.map((project) => (
							<ProjectCard
								key={project.id}
								project={project}
								canDelete={ownerProjectIds.has(project.id)}
								belongsToProject={belongsToProject(project)}
								onUpdate={refetchProjects}
								isDeleted={isShowingDeleted}
								isSelectionMode={isSelectionMode}
								isSelected={selectedIds.has(project.id)}
								onSelect={handleSelect}
							/>
						))}
					</div>
				</TooltipProvider>
			) : (
				<TooltipProvider>
					<ProjectsListView
						projects={visibleProjects}
						canDeleteProject={(projectId) =>
							ownerProjectIds.has(projectId)
						}
						belongsToProject={belongsToProject}
						onUpdate={refetchProjects}
						isDeleted={isShowingDeleted}
						isSelectionMode={isSelectionMode}
						selectedIds={selectedIds}
						onSelect={handleSelect}
					/>
				</TooltipProvider>
			)}

			{/* Shared with me — guest projects in other organizations.
			    Personal context only; hidden entirely when empty. */}
			{showSharedProjects && (
				<section
					aria-labelledby="shared-projects-heading"
					className="space-y-4 border-t pt-8"
				>
					<div className="space-y-1">
						<h2
							id="shared-projects-heading"
							className="app-editorial-label"
						>
							{tShared("title")}
						</h2>
						<p className="text-muted-foreground text-sm">
							{tShared("description")}
						</p>
					</div>
					<TooltipProvider>
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
							{guestProjects.map((project) => (
								<ProjectCard
									key={project.id}
									project={project}
									onUpdate={refetchGuestProjects}
								/>
							))}
						</div>
					</TooltipProvider>
				</section>
			)}
		</div>
	);
}
