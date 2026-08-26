"use client";

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { SearchInput } from "@ui/components/search-input";
import {
	GridIcon,
	ListIcon,
	LockIcon,
	PlusIcon,
	SearchIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { AgentCard } from "./AgentCard";
import { AgentsListView } from "./AgentsListView";
import { CreateAgentDialog } from "./CreateAgentDialog";

/**
 * Organization Agent Registry View Component
 *
 * Displays agents scoped to the organization only (ORGANIZATION + SYSTEM scope).
 * Does NOT show USER scope agents - maintains strict tenant isolation.
 */
export function OrgAgentRegistryView({
	readOnly = false,
}: {
	readOnly?: boolean;
}) {
	const qc = useQueryClient();
	const createAgentPath = useContextPath("agents/create");
	const { organizationId, isOrgContext } = useOrganizationContext();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [openCreateDialog, setOpenCreateDialog] = useState(false);
	const [editingAgent, setEditingAgent] = useState<any>(null);
	const [deletingAgent, setDeletingAgent] = useState<any>(null);
	const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

	// Fetch registered agents - ONLY organization and system scope
	// TENANT ISOLATION: Uses organizationId to filter to org agents only
	const { data: agents = [], isLoading } = useQuery({
		queryKey: ["agents", "registry", "org", organizationId],
		queryFn: async () => {
			if (!organizationId) {
				return [];
			}
			const result = await orpcClient.agents.registry.list({
				organizationId,
				limit: 100,
				offset: 0,
			});
			// Filter to show only ORGANIZATION and SYSTEM scope agents
			// Never show USER scope agents in org context
			return result.agents.filter(
				(agent: any) =>
					agent.scope === "ORGANIZATION" || agent.scope === "SYSTEM",
			);
		},
		enabled: !!organizationId,
	});

	// Filter agents by search query
	const filteredAgents = agents.filter((agent: any) => {
		if (!debouncedSearch) {
			return true;
		}
		const query = debouncedSearch.toLowerCase();
		return (
			agent.name.toLowerCase().includes(query) ||
			agent.displayName.toLowerCase().includes(query) ||
			agent.description?.toLowerCase().includes(query) ||
			agent.framework.toLowerCase().includes(query)
		);
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async (id: string) =>
			await orpcClient.agents.registry.delete({ id }),
		onSuccess: () => {
			toast.success("Agent deleted successfully");
			setDeletingAgent(null);
			qc.invalidateQueries({
				queryKey: ["agents", "registry", "org", organizationId],
			});
		},
		onError: (e: any) =>
			toast.error("Failed to delete agent", {
				description: e?.message || String(e),
			}),
	});

	// Health check mutation
	const healthCheckMutation = useMutation({
		mutationFn: async (id: string) =>
			await orpcClient.agents.registry.healthCheck({ id }),
		onSuccess: (data) => {
			if (data.healthy) {
				toast.success("Agent is healthy");
			} else {
				toast.error("Agent health check failed", {
					description: data.error,
				});
			}
			qc.invalidateQueries({
				queryKey: ["agents", "registry", "org", organizationId],
			});
		},
		onError: (e: any) =>
			toast.error("Failed to check agent health", {
				description: e?.message || String(e),
			}),
	});

	const handleEdit = (agent: any) => {
		if (readOnly) {
			return;
		}
		// Can only edit ORGANIZATION scope agents, not SYSTEM
		if (agent.scope === "SYSTEM") {
			toast.error("Cannot edit system agents");
			return;
		}
		setEditingAgent(agent);
		setOpenCreateDialog(true);
	};

	const handleCreate = () => {
		if (readOnly) {
			return;
		}
		setEditingAgent(null);
		setOpenCreateDialog(true);
	};

	const handleDelete = (agent: any) => {
		if (readOnly) {
			return;
		}
		// Can only delete ORGANIZATION scope agents, not SYSTEM
		if (agent.scope === "SYSTEM") {
			toast.error("Cannot delete system agents");
			return;
		}
		setDeletingAgent(agent);
	};

	if (!isOrgContext) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Read-Only Banner */}
			{readOnly && (
				<div className="rounded-md border border-highlight/20 bg-highlight/5 p-4">
					<div className="flex gap-3">
						<LockIcon className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
						<div className="space-y-1 text-sm">
							<p className="font-medium text-foreground">
								View Only
							</p>
							<p className="text-highlight/80">
								Only organization administrators can register or
								modify agents.
							</p>
						</div>
					</div>
				</div>
			)}

			{/* Header with Search and Add Button */}
			<div className="flex items-center justify-between gap-4">
				<div className="relative flex-1 max-w-md">
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search organization agents..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>
				<div className="flex items-center gap-2">
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
					{!readOnly && (
						<>
							<Button variant="outline" onClick={handleCreate}>
								Register External Agent
							</Button>
							<Link href={createAgentPath}>
								<Button>
									<PlusIcon className="mr-2 size-4" />
									Create New Agent
								</Button>
							</Link>
						</>
					)}
				</div>
			</div>

			{/* Agents Grid/List */}
			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : filteredAgents.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-muted-foreground mb-4">
						{searchQuery
							? "No agents found matching your search"
							: "No organization agents yet. Create a custom agent in the full-page builder or register an external runtime for the organization."}
					</p>
					{!searchQuery && !readOnly && (
						<div className="flex items-center justify-center gap-2">
							<Button variant="outline" onClick={handleCreate}>
								Register External Agent
							</Button>
							<Link href={createAgentPath}>
								<Button>
									<PlusIcon className="mr-2 size-4" />
									Create New Agent
								</Button>
							</Link>
						</div>
					)}
				</div>
			) : viewMode === "grid" ? (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
					{filteredAgents.map((agent: any) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							onEdit={
								!readOnly && agent.scope !== "SYSTEM"
									? handleEdit
									: undefined
							}
							onDelete={
								!readOnly && agent.scope !== "SYSTEM"
									? handleDelete
									: undefined
							}
							onHealthCheck={(a) =>
								healthCheckMutation.mutate(a.id)
							}
							loadingHealthCheck={healthCheckMutation.isPending}
						/>
					))}
				</div>
			) : (
				<AgentsListView
					agents={filteredAgents}
					onEdit={!readOnly ? handleEdit : () => {}}
					onDelete={!readOnly ? handleDelete : () => {}}
					onHealthCheck={(a) => healthCheckMutation.mutate(a.id)}
					loadingHealthCheck={healthCheckMutation.isPending}
				/>
			)}

			{/* Create/Edit Dialog - defaults to ORGANIZATION scope */}
			{!readOnly && (
				<CreateAgentDialog
					open={openCreateDialog}
					onOpenChange={(nextOpen) => {
						setOpenCreateDialog(nextOpen);
						if (!nextOpen) {
							setEditingAgent(null);
						}
					}}
					editingAgent={editingAgent}
				/>
			)}

			{/* Delete Confirmation Dialog */}
			<Dialog
				open={!!deletingAgent}
				onOpenChange={() => setDeletingAgent(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete Agent</DialogTitle>
					</DialogHeader>
					<p className="text-sm text-muted-foreground">
						Are you sure you want to delete{" "}
						<strong>{deletingAgent?.displayName}</strong>? This
						action cannot be undone. This agent will no longer be
						available to organization members.
					</p>
					<div className="flex justify-end gap-2 mt-4">
						<Button
							variant="outline"
							onClick={() => setDeletingAgent(null)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() =>
								deleteMutation.mutate(deletingAgent.id)
							}
							disabled={deleteMutation.isPending}
						>
							{deleteMutation.isPending
								? "Deleting..."
								: "Delete"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
