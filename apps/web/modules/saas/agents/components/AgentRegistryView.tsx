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
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { GridIcon, ListIcon, PlusIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import {
	type AgentManagementTab,
	computeAgentManagementView,
} from "../lib/registry-management";
import { AgentCard } from "./AgentCard";
import { AgentInsightsSheet } from "./AgentInsightsSheet";
import { AgentsListView } from "./AgentsListView";
import { CreateAgentDialog } from "./CreateAgentDialog";

/**
 * Agent Registry View Component
 *
 * Admin interface for managing registered agents in the database.
 * Similar to MCP servers management pattern.
 */
export function AgentRegistryView() {
	const qc = useQueryClient();
	const { organizationId } = useOrganizationContext();
	const createAgentPath = useContextPath("agents/create");
	const registerAgentPath = useContextPath("agents/register");
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [openCreateDialog, setOpenCreateDialog] = useState(false);
	const [editingAgent, setEditingAgent] = useState<any>(null);
	const [deletingAgent, setDeletingAgent] = useState<any>(null);
	const [inspectingAgent, setInspectingAgent] = useState<any>(null);
	const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
	const [activeTab, setActiveTab] =
		useState<Exclude<AgentManagementTab, "search">>("all");

	// Fetch registered agents. organizationId scopes both the server query and
	// the cache key so a workspace switch doesn't surface the previous org's
	// agents (the registry returns org-scoped + SYSTEM agents).
	const { data: agents = [], isLoading } = useQuery({
		queryKey: ["agents", "registry", "list", organizationId],
		queryFn: async () => {
			const result = await orpcClient.agents.registry.list({
				organizationId,
				limit: 100,
				offset: 0,
			});
			return result.agents;
		},
	});

	const managementView = computeAgentManagementView(
		agents,
		debouncedSearch,
		activeTab,
	);
	const filteredAgents = managementView.items;

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async (id: string) =>
			await orpcClient.agents.registry.delete({ id }),
		onSuccess: () => {
			toast.success("Agent deleted successfully");
			setDeletingAgent(null);
			qc.invalidateQueries({ queryKey: ["agents", "registry", "list"] });
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
			qc.invalidateQueries({ queryKey: ["agents", "registry", "list"] });
		},
		onError: (e: any) =>
			toast.error("Failed to check agent health", {
				description: e?.message || String(e),
			}),
	});

	const handleEdit = (agent: any) => {
		setEditingAgent(agent);
		setOpenCreateDialog(true);
	};

	return (
		<div className="space-y-6">
			{/* Header with Search and Add Button */}
			<div className="flex items-center justify-between gap-4">
				<div className="relative flex-1 max-w-md">
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search agents..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>
				<div className="hidden text-sm text-muted-foreground md:block">
					{managementView.counts.all} total agents
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
					<Link href={registerAgentPath}>
						<Button variant="outline">
							Register External Agent
						</Button>
					</Link>
					<Link href={createAgentPath}>
						<Button>
							<PlusIcon className="mr-2 size-4" />
							Create New Agent
						</Button>
					</Link>
				</div>
			</div>

			<div className="grid gap-3 md:grid-cols-4">
				<div className="rounded-lg border p-3">
					<p className="text-xs text-muted-foreground">System</p>
					<p className="text-xl font-semibold">
						{managementView.counts.system}
					</p>
				</div>
				<div className="rounded-lg border p-3">
					<p className="text-xs text-muted-foreground">Personal</p>
					<p className="text-xl font-semibold">
						{managementView.counts.personal}
					</p>
				</div>
				<div className="rounded-lg border p-3">
					<p className="text-xs text-muted-foreground">
						Organization
					</p>
					<p className="text-xl font-semibold">
						{managementView.counts.organization}
					</p>
				</div>
				<div className="rounded-lg border p-3">
					<p className="text-xs text-muted-foreground">
						Needs attention
					</p>
					<p className="text-xl font-semibold">
						{managementView.counts.attention}
					</p>
				</div>
			</div>

			<Tabs
				value={managementView.resolvedTab}
				onValueChange={(value) =>
					setActiveTab(value as Exclude<AgentManagementTab, "search">)
				}
			>
				<TabsList className="flex h-auto flex-wrap justify-start gap-2 bg-transparent p-0">
					<TabsTrigger value="all">All</TabsTrigger>
					<TabsTrigger value="system">System</TabsTrigger>
					<TabsTrigger value="personal">Personal</TabsTrigger>
					<TabsTrigger value="organization">Organization</TabsTrigger>
					<TabsTrigger value="attention">Needs Attention</TabsTrigger>
				</TabsList>
			</Tabs>

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
							: "No agents yet. Create a custom agent in the full-page builder or register an external runtime."}
					</p>
					{!searchQuery && (
						<div className="flex items-center justify-center gap-2">
							<Link href={registerAgentPath}>
								<Button variant="outline">
									Register External Agent
								</Button>
							</Link>
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
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
					{filteredAgents.map((agent: any) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							onEdit={handleEdit}
							onDelete={(a) => setDeletingAgent(a)}
							onHealthCheck={(a) =>
								healthCheckMutation.mutate(a.id)
							}
							onViewInsights={(a) => setInspectingAgent(a)}
							loadingHealthCheck={healthCheckMutation.isPending}
						/>
					))}
				</div>
			) : (
				<AgentsListView
					agents={filteredAgents}
					onEdit={handleEdit}
					onDelete={(a) => setDeletingAgent(a)}
					onHealthCheck={(a) => healthCheckMutation.mutate(a.id)}
					loadingHealthCheck={healthCheckMutation.isPending}
				/>
			)}

			{/* Create/Edit Dialog */}
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
						action cannot be undone.
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

			{inspectingAgent && (
				<AgentInsightsSheet
					open={!!inspectingAgent}
					onOpenChange={(nextOpen) => {
						if (!nextOpen) {
							setInspectingAgent(null);
						}
					}}
					agent={inspectingAgent}
					organizationId={inspectingAgent.organizationId ?? null}
				/>
			)}
		</div>
	);
}
