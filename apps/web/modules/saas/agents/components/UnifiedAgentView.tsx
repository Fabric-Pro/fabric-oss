"use client";

import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { SparklesIcon } from "@saas/shared/components/icons/SparklesIcon";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	AlertCircle,
	BadgeCheck,
	BrainIcon,
	ChevronDown,
	CodeIcon,
	FileTextIcon,
	Flame,
	GridIcon,
	ListChecksIcon,
	ListIcon,
	Network,
	Plus,
	Search,
	SlidersHorizontal,
	Star,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentCard } from "./AgentCard";
import { AgentsHero } from "./AgentsHero";
import { FeaturedAgentCard } from "./FeaturedAgentCard";
import { InstanceAgentCard } from "./InstanceAgentCard";
import { UnifiedAgentListView } from "./UnifiedAgentListView";

/** Registry ids that the Fabric Loom row already represents. */
const LOOM_AGENT_IDS = new Set([FABRIC_AGENT_ID, "fabric-ai"]);

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

	const [viewMode, setViewMode] = useState<ViewMode>("list");
	const [certifiedOnly, setCertifiedOnly] = useState(false);
	const [popularOnly, setPopularOnly] = useState(false);
	const [favoritedOnly, setFavoritedOnly] = useState(false);

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
			const instance = instancesData?.instances.find(
				(item) => item.id === id,
			);
			deleteMutation.mutate({
				id,
				organizationId:
					(instance ? instance.organizationId : organizationId) ??
					undefined,
			});
		}
	};

	// Tag system agents and instances with scope
	const systemAgents = useMemo(() => {
		if (!registryData?.agents) {
			return [];
		}
		return (
			registryData.agents
				.filter((agent) => agent.scope === "SYSTEM")
				// The workspace assistant is the Fabric Loom row above the grid,
				// and `fabric-ai` is its compatibility alias; a tile for either
				// would be a second Fabric with nowhere useful to go.
				.filter((agent) => !LOOM_AGENT_IDS.has(agent.agentId))
				.map((agent) => ({
					...agent,
					scope: "SYSTEM" as const,
					_type: "system" as const,
					href: `${basePath}/${agent.id}/try`,
				}))
		);
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

		if (favoritedOnly) {
			filtered = filtered.filter(
				(item) =>
					Boolean(
						item.isFavorited || item.isPinned || item.isFeatured,
					) || item._type === "instance",
			);
		}

		if (certifiedOnly) {
			filtered = filtered.filter((item) => item._type === "system");
		}

		if (popularOnly) {
			filtered = [...filtered].sort(
				(a, b) => (b.runCount || 0) - (a.runCount || 0),
			);
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
	}, [
		systemAgents,
		instances,
		scopeFilter,
		searchQuery,
		favoritedOnly,
		certifiedOnly,
		popularOnly,
	]);

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

	// Build chip config — hide Organization in personal context, and only show Personal when personal items exist
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
		...(personalCount > 0
			? [
					{
						value: "PERSONAL" as const,
						label: "Personal",
						count: personalCount,
					},
				]
			: []),
	];

	return (
		<div className="space-y-4">
			<AgentsHero
				className="border-b-0 pb-1"
				actions={
					<div className="flex items-center gap-2">
						<Link
							href={`${basePath}/register`}
							className="hidden sm:block"
						>
							<Button variant="outline" size="sm">
								<Network className="mr-1.5 h-3.5 w-3.5" />
								Register External
							</Button>
						</Link>

						<Button
							asChild
							size="sm"
							data-onboarding-target="agents-new"
						>
							<Link href={`${contextBasePath}/agents/create`}>
								<Plus className="mr-1.5 h-4 w-4" />
								New
							</Link>
						</Button>
					</div>
				}
			/>

			{/* Full-width Databricks Genie search bar */}
			<div className="relative w-full">
				<Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
				<SearchInput
					placeholder="Search Genie Agents..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="h-10 w-full rounded-full border-border bg-background pl-10 pr-4 text-[13px] shadow-2xs"
				/>
			</div>

			{/* Databricks Genie pill filter row */}
			<div
				data-onboarding-target="agents-scope-filter"
				className="flex flex-wrap items-center gap-2"
			>
				<span
					aria-hidden="true"
					className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
				>
					<SlidersHorizontal className="h-3.5 w-3.5" />
				</span>

				{chips.map(({ value, label, count }) => (
					<button
						key={value}
						type="button"
						onClick={() => setScopeFilter(value)}
						aria-pressed={scopeFilter === value}
						className={cn(
							"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
							scopeFilter === value
								? "border-primary/40 bg-primary/[0.08] text-primary dark:bg-primary/[0.15]"
								: "border-border bg-background text-foreground hover:bg-muted/60",
						)}
					>
						<span>{label}</span>
						<span className="font-mono text-[11px] text-muted-foreground">
							{count}
						</span>
					</button>
				))}

				<button
					type="button"
					onClick={() => setFavoritedOnly((v) => !v)}
					aria-pressed={favoritedOnly}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						favoritedOnly
							? "border-primary/40 bg-primary/[0.08] text-primary dark:bg-primary/[0.15]"
							: "border-border bg-background text-foreground hover:bg-muted/60",
					)}
				>
					<Star className="h-3.5 w-3.5 text-amber-500" />
					<span>Favorited</span>
				</button>

				<button
					type="button"
					onClick={() => setCertifiedOnly((v) => !v)}
					aria-pressed={certifiedOnly}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						certifiedOnly
							? "border-primary/40 bg-primary/[0.08] text-primary dark:bg-primary/[0.15]"
							: "border-border bg-background text-foreground hover:bg-muted/60",
					)}
				>
					<BadgeCheck className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
					<span>Certified</span>
				</button>

				<button
					type="button"
					onClick={() => setPopularOnly((v) => !v)}
					aria-pressed={popularOnly}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						popularOnly
							? "border-primary/40 bg-primary/[0.08] text-primary dark:bg-primary/[0.15]"
							: "border-border bg-background text-foreground hover:bg-muted/60",
					)}
				>
					<Flame className="h-3.5 w-3.5 text-rose-500" />
					<span>Popular</span>
				</button>
			</div>

			{/* Fabric Loom, the orchestrator, always first and full width.
			    Product kept this card's name when the assistant became
			    Genie; the page it opens is Genie. */}
			<div data-onboarding-target="agents-featured">
				<FeaturedAgentCard
					name="Fabric Loom"
					description="Genie is the AI coworker for engineering & product teams. Start a conversation across your agents, codebases, documents, and workflows."
					href={`${basePath}/fabric-ai`}
					icon={<SparklesIcon className="h-6 w-6" />}
					badge="Orchestrator"
					badgeVariant="outline"
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
					ctaLabel="Explore Genie"
				/>
			</div>

			{/* Section header bar: All Agents + Sort & View Switcher */}
			<div className="flex items-center justify-between pt-2">
				<h2 className="text-[14px] font-semibold text-foreground">
					All Agents
				</h2>

				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => setPopularOnly((v) => !v)}
						className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span>{popularOnly ? "Popular" : "Relevance"}</span>
						<ChevronDown className="h-3.5 w-3.5" />
					</button>

					<div className="flex gap-0.5 rounded-[6px] border border-border bg-background p-0.5">
						<Button
							variant={
								viewMode === "list" ? "secondary" : "ghost"
							}
							size="sm"
							onClick={() => setViewMode("list")}
							aria-label="List view"
							aria-pressed={viewMode === "list"}
							className="h-7 gap-1.5 px-2 text-xs"
						>
							<ListIcon className="h-3.5 w-3.5" />
							<span>List</span>
						</Button>
						<Button
							variant={
								viewMode === "grid" ? "secondary" : "ghost"
							}
							size="sm"
							onClick={() => setViewMode("grid")}
							aria-label="Grid view"
							aria-pressed={viewMode === "grid"}
							className="h-7 gap-1.5 px-2 text-xs"
						>
							<GridIcon className="h-3.5 w-3.5" />
							<span>Grid</span>
						</Button>
					</div>
				</div>
			</div>

			{/* No Results */}
			{filteredItems.length === 0 && (
				<Alert>
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>No Results</AlertTitle>
					<AlertDescription>
						No agents match your current filters. Try adjusting your
						search or filter selection.
					</AlertDescription>
				</Alert>
			)}

			{/* Agent Grid / List */}
			{filteredItems.length > 0 &&
				(viewMode === "grid" ? (
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
