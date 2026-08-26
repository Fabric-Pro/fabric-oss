"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	AlertCircle,
	BrainIcon,
	CodeIcon,
	FileTextIcon,
	GridIcon,
	ListChecksIcon,
	ListIcon,
	Network,
	Plus,
	Search,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentCard } from "./AgentCard";
import { AgentsHero } from "./AgentsHero";
import { FeaturedAgentCard } from "./FeaturedAgentCard";
import { InstanceAgentCard } from "./InstanceAgentCard";
import { UnifiedAgentListView } from "./UnifiedAgentListView";

type ViewMode = "grid" | "list";
type AgentScope = "ALL" | "SYSTEM" | "ORGANIZATION" | "PERSONAL";

export function UnifiedAgentView() {
	const {
		organizationId,
		basePath: contextBasePath,
		isOrgContext,
	} = useOrganizationContext();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [scopeFilter, setScopeFilter] = useState<AgentScope>(
		isOrgContext ? "ORGANIZATION" : "ALL",
	);
	const hasOrgContextResolved = useRef(isOrgContext);

	// Recompute default scope when org context finishes loading.
	// useOrganizationContext() initially returns isOrgContext === false until the
	// ActiveOrganizationProvider resolves the org from the slug, so the useState
	// initializer captures the transient value. This effect corrects it once.
	useEffect(() => {
		if (isOrgContext && !hasOrgContextResolved.current) {
			hasOrgContextResolved.current = true;
			setScopeFilter("ORGANIZATION");
		}
	}, [isOrgContext]);

	const [viewMode, setViewMode] = useState<ViewMode>("grid");

	const basePath = `${contextBasePath}/agents`;

	// Fetch system agents from database-backed registry
	const { data: registryData, isLoading: loadingAvailable } = useQuery(
		orpc.agents.registry.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 100,
				offset: 0,
			},
		}),
	);

	// Fetch agent template instances (staleTime: 0 ensures fresh data after create/delete)
	const { data: instancesData, isLoading: loadingInstances } = useQuery({
		...orpc.agentTemplates.instances.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				status: "ACTIVE",
				latestVersionOnly: true,
				limit: 100,
				offset: 0,
			},
		}),
		staleTime: 0,
	});

	// Delete mutation for instances
	const deleteMutation = useMutation(
		orpc.agentTemplates.instances.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Agent deleted");
				queryClient.invalidateQueries({
					queryKey: ["agentTemplates", "instances"],
				});
			},
			onError: () => {
				toast.error("Failed to delete agent");
			},
		}),
	);

	const handleDeleteInstance = (id: string) => {
		if (window.confirm("Are you sure you want to delete this agent?")) {
			deleteMutation.mutate({ id });
		}
	};

	// Tag system agents and instances with scope
	const systemAgents = useMemo(() => {
		if (!registryData?.agents) {
			return [];
		}
		return registryData.agents
			.filter((agent) => agent.scope === "SYSTEM")
			.map((agent) => ({
				...agent,
				scope: "SYSTEM" as const,
				_type: "system" as const,
				href: `${basePath}/${agent.id}/try`,
			}));
	}, [registryData, basePath]);

	const instances = useMemo(() => {
		if (!instancesData?.instances) {
			return [];
		}
		return instancesData.instances.map((instance: any) => ({
			...instance,
			scope: instance.organizationId ? "ORGANIZATION" : "PERSONAL",
			_type: "instance" as const,
		}));
	}, [instancesData]);

	// Combined and filtered agents
	const filteredItems = useMemo(() => {
		const all = [...systemAgents, ...instances];
		let filtered = all;

		// Apply scope filter
		if (scopeFilter !== "ALL") {
			filtered = filtered.filter((item) => item.scope === scopeFilter);
		}

		// Apply search filter
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter((item) => {
				if (item._type === "system") {
					return (
						item.displayName?.toLowerCase().includes(query) ||
						item.description?.toLowerCase().includes(query) ||
						item.name?.toLowerCase().includes(query)
					);
				}
				return (
					item.name?.toLowerCase().includes(query) ||
					item.description?.toLowerCase().includes(query) ||
					item.template?.displayName?.toLowerCase().includes(query)
				);
			});
		}

		return filtered;
	}, [systemAgents, instances, scopeFilter, searchQuery]);

	const isLoading = loadingAvailable || loadingInstances;

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<Spinner className="mr-2 size-4 text-primary" />
				<span className="text-sm text-muted-foreground">
					Loading agents...
				</span>
			</div>
		);
	}

	// Counts for chips
	const totalCount = systemAgents.length + instances.length;
	const systemCount = systemAgents.length;
	const orgCount = instances.filter((i) => i.scope === "ORGANIZATION").length;
	const personalCount = instances.filter(
		(i) => i.scope === "PERSONAL",
	).length;

	// Build chip config — hide Organization in personal context
	const chips: { value: AgentScope; label: string; count: number }[] = [
		{ value: "ALL", label: "All", count: totalCount },
		{ value: "SYSTEM", label: "System", count: systemCount },
		...(isOrgContext
			? [
					{
						value: "ORGANIZATION" as const,
						label: "Organization",
						count: orgCount,
					},
				]
			: []),
		{ value: "PERSONAL", label: "Personal", count: personalCount },
	];

	return (
		<div className="space-y-8">
			<AgentsHero />

			{/* Scope Filter Pills */}
			<div
				data-onboarding-target="agents-scope-filter"
				className="flex flex-wrap justify-center gap-2"
			>
				{chips.map(({ value, label, count }) => (
					<button
						key={value}
						type="button"
						onClick={() => setScopeFilter(value)}
						className={cn(
							"rounded-full px-4 py-2.5 font-medium text-base transition-all",
							scopeFilter === value
								? "bg-primary text-primary-foreground"
								: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
						)}
					>
						{label} ({count})
					</button>
				))}
			</div>

			{/* Actions Bar */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="relative w-full sm:max-w-md">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search agents..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-10 h-11 text-base"
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

					<Link
						href={`${basePath}/register`}
						className="hidden sm:block"
					>
						<Button variant="outline">
							<Network className="h-4 w-4 mr-2" />
							Register External
						</Button>
					</Link>

					<Button
						asChild
						data-onboarding-target="agents-new"
						className="flex-1 sm:flex-none"
					>
						<Link href={`${contextBasePath}/agents/create`}>
							<Plus className="h-4 w-4 mr-2" />
							New Agent
						</Link>
					</Button>
				</div>
			</div>

			{/* Featured: Fabric Loom — always visible */}
			<div data-onboarding-target="agents-featured">
				<FeaturedAgentCard
					name="Fabric Loom"
					description="Hub-and-spoke orchestrator that routes tasks to specialized agents via A2A protocol"
					href={`${basePath}/fabric-ai`}
					icon={<FabricLogo className="h-6 w-6" size={24} />}
					badge="Smart"
					badgeVariant="default"
					capabilities={[
						{
							icon: <BrainIcon className="h-4 w-4" />,
							label: "Task Planning",
							description: "Break down complex tasks",
						},
						{
							icon: <CodeIcon className="h-4 w-4" />,
							label: "Code Execution",
							description: "Write and run code",
						},
						{
							icon: <FileTextIcon className="h-4 w-4" />,
							label: "Documentation",
							description: "Generate docs & specs",
						},
						{
							icon: <ListChecksIcon className="h-4 w-4" />,
							label: "Feature Breakdown",
							description: "Create features",
						},
					]}
					statusItems={[
						"Automatically selects the best agent for your task",
						"Supports Fast, Balanced & Thorough reasoning modes",
					]}
					isPrimary
					ctaLabel="Try Agent"
				/>
			</div>

			{/* No Results */}
			{filteredItems.length === 0 && searchQuery && (
				<Alert>
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>No Results</AlertTitle>
					<AlertDescription>
						No agents match your search query. Try different
						keywords.
					</AlertDescription>
				</Alert>
			)}

			{/* Agent Grid / List */}
			{filteredItems.length > 0 &&
				(viewMode === "grid" ? (
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
						{filteredItems.map((item: any) =>
							item._type === "instance" ? (
								<InstanceAgentCard
									key={item.id}
									instance={item}
									basePath={contextBasePath}
									onDelete={handleDeleteInstance}
								/>
							) : (
								<AgentCard key={item.id} agent={item} />
							),
						)}
					</div>
				) : (
					<UnifiedAgentListView
						items={filteredItems}
						basePath={contextBasePath}
						onDeleteInstance={handleDeleteInstance}
					/>
				))}
		</div>
	);
}
