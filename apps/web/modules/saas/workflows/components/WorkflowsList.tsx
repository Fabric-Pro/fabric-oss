"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import { GridIcon, ListIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { WorkflowCard } from "./WorkflowCard";
import { WorkflowsHero } from "./WorkflowsHero";

type ViewMode = "grid" | "list";

export function WorkflowsList() {
	const router = useRouter();
	const { organizationId, basePath } = useOrganizationContext();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [viewMode, setViewMode] = useState<ViewMode>("grid");

	const workflowsBasePath = `${basePath}/workflows`;

	// Create workflow mutation
	const createMutation = useMutation(
		orpc.workflows.create.mutationOptions({
			onSuccess: (data) => {
				router.push(`${workflowsBasePath}/${data.workflow.id}`);
			},
			onError: (_error) => {
				toast.error("Failed to create workflow");
			},
		}),
	);

	const handleCreateWorkflow = () => {
		createMutation.mutate({
			name: "Untitled Workflow",
			triggerType: "MANUAL",
			organizationId,
		});
	};

	// Fetch workflows - organizationId is null for personal context (safe)
	const { data, isLoading, refetch } = useQuery(
		orpc.workflows.list.queryOptions({
			input: {
				organizationId,
				limit: 50,
				offset: 0,
				search: debouncedSearch || undefined,
				status:
					statusFilter === "all"
						? undefined
						: (statusFilter as
								| "DRAFT"
								| "ACTIVE"
								| "PAUSED"
								| "ARCHIVED"),
			},
		}),
	);

	const workflows = data?.workflows ?? [];

	// Calculate counts for each status
	const allCount = workflows.length;
	const draftCount = workflows.filter((w) => w.status === "DRAFT").length;
	const activeCount = workflows.filter((w) => w.status === "ACTIVE").length;
	const pausedCount = workflows.filter((w) => w.status === "PAUSED").length;
	const archivedCount = workflows.filter(
		(w) => w.status === "ARCHIVED",
	).length;

	return (
		<div className="space-y-8">
			{/* Hero Section */}
			<WorkflowsHero />

			{/* Status Filter Pills */}
			<div
				data-onboarding-target="workflows-status-filter"
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
					onClick={() => setStatusFilter("DRAFT")}
					className={cn(
						"rounded-full px-4 py-2 font-medium text-sm transition-all",
						statusFilter === "DRAFT"
							? "bg-primary text-primary-foreground"
							: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
					)}
				>
					Draft ({draftCount})
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
					onClick={() => setStatusFilter("PAUSED")}
					className={cn(
						"rounded-full px-4 py-2 font-medium text-sm transition-all",
						statusFilter === "PAUSED"
							? "bg-primary text-primary-foreground"
							: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
					)}
				>
					Paused ({pausedCount})
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
					data-onboarding-target="workflows-search"
					className="relative flex-1 max-w-md w-full"
				>
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search workflows..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>

				<div className="flex gap-2 items-center">
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

					{/* Create Button */}
					<Button
						data-onboarding-target="workflows-new"
						onClick={handleCreateWorkflow}
					>
						<PlusIcon className="h-4 w-4 mr-2" />
						New Workflow
					</Button>
				</div>
			</div>

			{/* Workflows Display */}
			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : workflows.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-muted-foreground mb-4">
						{searchQuery || statusFilter !== "all"
							? "No workflows found matching your filters"
							: "No workflows yet. Create your first workflow to get started!"}
					</p>
					{!searchQuery && statusFilter === "all" && (
						<Button onClick={handleCreateWorkflow}>
							<PlusIcon className="h-4 w-4 mr-2" />
							Create Your First Workflow
						</Button>
					)}
				</div>
			) : (
				<div
					className={
						viewMode === "grid"
							? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
							: "space-y-3"
					}
				>
					{workflows.map((workflow) => (
						<WorkflowCard
							key={workflow.id}
							workflow={workflow}
							variant={viewMode}
							onRefresh={refetch}
						/>
					))}
				</div>
			)}
		</div>
	);
}
