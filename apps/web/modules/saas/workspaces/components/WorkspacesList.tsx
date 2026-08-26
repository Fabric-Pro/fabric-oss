"use client";

import {
	useBasePath,
	useEffectiveOrganizationId,
} from "@saas/organizations/hooks";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { TooltipProvider } from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { WorkspaceCard } from "./WorkspaceCard";
import { WorkspacesHero } from "./WorkspacesHero";

interface WorkspacesListProps {
	/**
	 * Organization ID for filtering workspaces.
	 * - `string`: Show workspaces for this organization
	 * - `null`: Show personal workspaces only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
}

export function WorkspacesList({
	organizationId: propOrgId,
}: WorkspacesListProps) {
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [statusFilter, setStatusFilter] = useState<
		"all" | "ACTIVE" | "ARCHIVED"
	>("ACTIVE");
	const [showCreateDialog, setShowCreateDialog] = useState(false);

	// Use proper context-aware basePath
	const basePath = useBasePath() || "/app";

	// Fetch workspaces
	const { data, isLoading, refetch } = useQuery(
		orpc.documentWorkspaces.list.queryOptions({
			input: {
				organizationId,
				limit: 50,
				offset: 0,
				search: debouncedSearch || undefined,
				status: statusFilter === "all" ? undefined : statusFilter,
				includeShared: true,
			},
		}),
	);

	// Archive mutation
	const archiveMutation = useMutation({
		mutationFn: async (workspaceId: string) => {
			return orpc.documentWorkspaces.archive.call({ workspaceId });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["documentWorkspaces"] });
			refetch();
		},
	});

	// Reactivate mutation
	const reactivateMutation = useMutation({
		mutationFn: async (workspaceId: string) => {
			return orpc.documentWorkspaces.reactivate.call({ workspaceId });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["documentWorkspaces"] });
			refetch();
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async (workspaceId: string) => {
			return orpc.documentWorkspaces.delete.call({ workspaceId });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["documentWorkspaces"] });
			refetch();
		},
	});

	const workspaces = data?.workspaces ?? [];

	// Calculate counts
	const allCount = workspaces.length;
	const activeCount = workspaces.filter((w) => w.status === "ACTIVE").length;
	const archivedCount = workspaces.filter(
		(w) => w.status === "ARCHIVED",
	).length;

	const handleArchive = async (workspace: (typeof workspaces)[0]) => {
		if (workspace.status === "ARCHIVED") {
			await reactivateMutation.mutateAsync(workspace.id);
		} else {
			await archiveMutation.mutateAsync(workspace.id);
		}
	};

	return (
		<div className="space-y-8">
			{/* Hero Section */}
			<WorkspacesHero />

			{/* Status Filter Pills */}
			<div
				data-onboarding-target="workspaces-status-filter"
				className="flex flex-wrap justify-center gap-2"
			>
				<button
					type="button"
					onClick={() => setStatusFilter("all")}
					className={cn(
						"rounded-full px-4 py-2 font-medium text-sm transition-all",
						statusFilter === "all"
							? "bg-primary text-primary-foreground"
							: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
					)}
				>
					All ({allCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("ACTIVE")}
					className={cn(
						"rounded-full px-4 py-2 font-medium text-sm transition-all",
						statusFilter === "ACTIVE"
							? "bg-primary text-primary-foreground"
							: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
					)}
				>
					Active ({activeCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("ARCHIVED")}
					className={cn(
						"rounded-full px-4 py-2 font-medium text-sm transition-all",
						statusFilter === "ARCHIVED"
							? "bg-primary text-primary-foreground"
							: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
					)}
				>
					Archived ({archivedCount})
				</button>
			</div>

			{/* Actions Bar */}
			<div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
				{/* Search */}
				<div
					data-onboarding-target="workspaces-search"
					className="relative flex-1 max-w-md w-full"
				>
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search workspaces..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>

				<div className="flex gap-2 items-center">
					{/* Create Button */}
					<Button
						data-onboarding-target="workspaces-new"
						onClick={() => setShowCreateDialog(true)}
					>
						<PlusIcon className="h-4 w-4 mr-2" />
						New Workspace
					</Button>
				</div>
			</div>

			{/* Workspaces Display */}
			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : workspaces.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-muted-foreground mb-4">
						{searchQuery || statusFilter !== "ACTIVE"
							? "No workspaces found matching your filters"
							: "No workspaces yet. Create your first workspace to get started!"}
					</p>
					{!searchQuery && statusFilter === "ACTIVE" && (
						<Button onClick={() => setShowCreateDialog(true)}>
							<PlusIcon className="h-4 w-4 mr-2" />
							Create Your First Workspace
						</Button>
					)}
				</div>
			) : (
				<TooltipProvider>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
						{workspaces.map((workspace) => (
							<WorkspaceCard
								key={workspace.id}
								workspace={workspace}
								basePath={basePath}
								onArchive={() => handleArchive(workspace)}
								onDelete={() =>
									deleteMutation.mutate(workspace.id)
								}
							/>
						))}
					</div>
				</TooltipProvider>
			)}

			{/* Create Dialog */}
			<CreateWorkspaceDialog
				open={showCreateDialog}
				onOpenChange={setShowCreateDialog}
				organizationId={organizationId}
				onSuccess={() => {
					refetch();
					setShowCreateDialog(false);
				}}
			/>
		</div>
	);
}
