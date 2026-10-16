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
import { CreateLibraryDialog } from "./CreateLibraryDialog";
import { LibrariesHero } from "./LibrariesHero";
import { LibraryCard } from "./LibraryCard";

interface LibrariesListProps {
	/**
	 * Organization ID for filtering libraries.
	 * - `string`: Show libraries for this organization
	 * - `null`: Show personal libraries only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
}

export function LibrariesList({
	organizationId: propOrgId,
}: LibrariesListProps) {
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

	// Fetch libraries
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
		mutationFn: async (libraryId: string) => {
			return orpc.documentWorkspaces.archive.call({
				workspaceId: libraryId,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["documentWorkspaces"] });
			refetch();
		},
	});

	// Reactivate mutation
	const reactivateMutation = useMutation({
		mutationFn: async (libraryId: string) => {
			return orpc.documentWorkspaces.reactivate.call({
				workspaceId: libraryId,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["documentWorkspaces"] });
			refetch();
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async (libraryId: string) => {
			return orpc.documentWorkspaces.delete.call({
				workspaceId: libraryId,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["documentWorkspaces"] });
			refetch();
		},
	});

	const libraries = data?.workspaces ?? [];

	// Calculate counts
	const allCount = libraries.length;
	const activeCount = libraries.filter((w) => w.status === "ACTIVE").length;
	const archivedCount = libraries.filter(
		(w) => w.status === "ARCHIVED",
	).length;

	const handleArchive = async (library: (typeof libraries)[0]) => {
		if (library.status === "ARCHIVED") {
			await reactivateMutation.mutateAsync(library.id);
		} else {
			await archiveMutation.mutateAsync(library.id);
		}
	};

	return (
		<div className="space-y-8">
			{/* Hero Section */}
			<LibrariesHero />

			{/* Status Filter Pills */}
			<div
				data-onboarding-target="libraries-status-filter"
				className="flex flex-wrap justify-center gap-2"
			>
				<button
					type="button"
					onClick={() => setStatusFilter("all")}
					className={cn(
						"rounded-[6px] px-3.5 py-1.5 text-sm transition-colors",
						statusFilter === "all"
							? "border border-border bg-accent text-foreground"
							: "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
					)}
				>
					All ({allCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("ACTIVE")}
					className={cn(
						"rounded-[6px] px-3.5 py-1.5 text-sm transition-colors",
						statusFilter === "ACTIVE"
							? "border border-border bg-accent text-foreground"
							: "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
					)}
				>
					Active ({activeCount})
				</button>
				<button
					type="button"
					onClick={() => setStatusFilter("ARCHIVED")}
					className={cn(
						"rounded-[6px] px-3.5 py-1.5 text-sm transition-colors",
						statusFilter === "ARCHIVED"
							? "border border-border bg-accent text-foreground"
							: "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
					)}
				>
					Archived ({archivedCount})
				</button>
			</div>

			{/* Actions Bar */}
			<div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
				{/* Search */}
				<div
					data-onboarding-target="libraries-search"
					className="relative flex-1 max-w-md w-full"
				>
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search libraries..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>

				<div className="flex gap-2 items-center">
					{/* Create Button */}
					<Button
						data-onboarding-target="libraries-new"
						onClick={() => setShowCreateDialog(true)}
					>
						<PlusIcon className="h-4 w-4 mr-2" />
						New Library
					</Button>
				</div>
			</div>

			{/* Libraries Display */}
			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : libraries.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-muted-foreground mb-4">
						{searchQuery || statusFilter !== "ACTIVE"
							? "No libraries found matching your filters"
							: "No libraries yet. Create your first library to get started!"}
					</p>
					{!searchQuery && statusFilter === "ACTIVE" && (
						<Button onClick={() => setShowCreateDialog(true)}>
							<PlusIcon className="h-4 w-4 mr-2" />
							Create Your First Library
						</Button>
					)}
				</div>
			) : (
				<TooltipProvider>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
						{libraries.map((library) => (
							<LibraryCard
								key={library.id}
								library={library}
								basePath={basePath}
								onArchive={() => handleArchive(library)}
								onDelete={() =>
									deleteMutation.mutate(library.id)
								}
							/>
						))}
					</div>
				</TooltipProvider>
			)}

			{/* Create Dialog */}
			<CreateLibraryDialog
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
