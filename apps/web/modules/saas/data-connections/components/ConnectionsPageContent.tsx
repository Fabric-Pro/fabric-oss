"use client";

import { McpServerIcon } from "@saas/mcp/components/McpServerIcon";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMonitoringFeatureFlag } from "@saas/shared/lib/use-monitoring-feature-flag";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import { ChevronDown, Search } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { useConnections } from "../hooks/useConnections";
import { useProviderHealth } from "../hooks/useProviderHealth";
import {
	ACTION_ONLY_PROVIDERS,
	getActionOnlyProviderPlugin,
} from "../lib/action-only-providers";
import {
	matchesStatusFilter,
	resolveProviderHealth,
	type StatusFilterValue,
} from "../lib/provider-health-filter";
import {
	type DataConnectionProvider,
	getProviderMetadata,
	PROVIDER_CATEGORIES,
} from "../lib/providers";
import { ActionOnlyProviderCard } from "./ActionOnlyProviderCard";
import { IntegrationTile, ProviderCard } from "./ProviderCard";

type McpRegistryServer = {
	id: string;
	key?: string | null;
	name?: string | null;
	description?: string | null;
	category?: string | null;
	iconUrl?: string | null;
	docsUrl?: string | null;
	repositoryUrl?: string | null;
	defaultUrl?: string | null;
};

function mapActionProviderToDataConnectionProvider(
	provider: string,
): DataConnectionProvider | null {
	switch (provider) {
		case "ASANA":
			return "ASANA";
		case "BITBUCKET":
			return "BITBUCKET";
		case "CLICKUP":
			return "CLICKUP";
		case "CONFLUENCE":
			return "CONFLUENCE";
		case "GITHUB":
			return "GITHUB";
		case "GITLAB":
			return "GITLAB";
		case "GMAIL":
			return "GMAIL";
		case "GOOGLE_DRIVE":
			return "GOOGLE_DRIVE";
		case "HUBSPOT":
			return "HUBSPOT";
		case "INTERCOM":
			return "INTERCOM";
		case "JIRA":
			return "JIRA";
		case "LINEAR":
			return "LINEAR";
		case "MICROSOFT_GRAPH":
			return "TEAMS";
		case "NOTION":
			return "NOTION";
		case "SALESFORCE":
			return "SALESFORCE";
		case "SLACK":
			return "SLACK";
		case "ZENDESK":
			return "ZENDESK";
		default:
			return null;
	}
}

function _mapDataConnectionProviderToActionProvider(
	provider: DataConnectionProvider,
): string | null {
	switch (provider) {
		case "ASANA":
			return "ASANA";
		case "BITBUCKET":
			return "BITBUCKET";
		case "CLICKUP":
			return "CLICKUP";
		case "CONFLUENCE":
			return "CONFLUENCE";
		case "GITHUB":
			return "GITHUB";
		case "GMAIL":
			return "GMAIL";
		case "GITLAB":
			return "GITLAB";
		case "GOOGLE_DRIVE":
			return "GOOGLE_DRIVE";
		case "HUBSPOT":
			return "HUBSPOT";
		case "INTERCOM":
			return "INTERCOM";
		case "JIRA":
			return "JIRA";
		case "LINEAR":
			return "LINEAR";
		case "SALESFORCE":
			return "SALESFORCE";
		case "TEAMS":
			return "MICROSOFT_GRAPH";
		case "NOTION":
			return "NOTION";
		case "SLACK":
			return "SLACK";
		case "ZENDESK":
			return "ZENDESK";
		default:
			return null;
	}
}

type CapabilityFilter = "all" | "search" | "actions" | "hybrid";

const STATUS_FILTER_OPTIONS: ReadonlyArray<{
	value: StatusFilterValue;
	label: string;
}> = [
	{ value: "all", label: "Any status" },
	{ value: "operational", label: "Operational" },
	{ value: "degraded", label: "Degraded" },
	{ value: "outage", label: "Outage" },
	{ value: "unknown", label: "Unknown" },
];

interface ConnectionsPageContentProps {
	/** Kept for callers; the add menu now lives on the page itself. */
	addHref?: string;
	/** Which tiles to show: everything, integrations only, or MCP servers only. */
	view?: "all" | "integrations" | "mcp";
	/**
	 * Where provider and action detail pages live. They stay under Settings;
	 * only the catalogue itself moved to its own page.
	 */
	settingsBasePath: string;
	/**
	 * The catalogue page's own path, for links that change its tab. Defaults
	 * to `settingsBasePath` for callers that still render it there.
	 */
	basePath?: string;
	/**
	 * Rendered at the start of the toolbar row, opposite the Add connection
	 * menu — the page's type tabs, so the two controls that decide what is on
	 * screen share one line.
	 */
	toolbarStart?: ReactNode;
}

export function ConnectionsPageContent({
	settingsBasePath,
	basePath = settingsBasePath,
	toolbarStart,
	view = "all",
}: ConnectionsPageContentProps) {
	const { organizationId } = useOrganizationContext();
	const { data: connections, isLoading, error } = useConnections();
	const [query, setQuery] = useState("");
	const [capabilityFilter, setCapabilityFilter] =
		useState<CapabilityFilter>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");
	const searchRef = useRef<HTMLInputElement>(null);

	const healthBadgesEnabled = useMonitoringFeatureFlag(
		"feature-integration-health-badges",
	);
	const { byProviderKey: healthByProviderKey } = useProviderHealth({
		enabled: healthBadgesEnabled,
	});

	const { data: actionIntegrations } = useQuery({
		queryKey: ["workflow-integration-status", organizationId],
		queryFn: async () => {
			const result = await orpcClient.workflows.integrations.listStatus({
				organizationId: organizationId ?? null,
			});
			return result.integrations;
		},
	});

	const searchConnectedProviders = useMemo(
		() =>
			new Set(
				(connections ?? []).map((connection) => connection.provider),
			),
		[connections],
	);

	const actionConnectedProviders = useMemo(() => {
		const providers = new Set<DataConnectionProvider>();
		for (const integration of actionIntegrations ?? []) {
			if (!integration.hasCredentials) {
				continue;
			}
			const mappedProvider = mapActionProviderToDataConnectionProvider(
				integration.provider,
			);
			if (mappedProvider) {
				providers.add(mappedProvider);
			}
		}
		return providers;
	}, [actionIntegrations]);

	const connectedActionOnlyTypes = useMemo(() => {
		const types = new Set<(typeof ACTION_ONLY_PROVIDERS)[number]["type"]>();
		for (const integration of actionIntegrations ?? []) {
			if (!integration.hasCredentials) {
				continue;
			}
			const entry = ACTION_ONLY_PROVIDERS.find(
				(candidate) => candidate.type === integration.provider,
			);
			if (entry) {
				types.add(entry.type);
			}
		}
		return types;
	}, [actionIntegrations]);

	const allProviders = useMemo(
		() => PROVIDER_CATEGORIES.flatMap((category) => category.providers),
		[],
	);

	const filteredProviders = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();

		return allProviders.filter((provider) => {
			const metadata = getProviderMetadata(provider);
			const matchesQuery =
				!normalizedQuery ||
				metadata.name.toLowerCase().includes(normalizedQuery) ||
				metadata.description.toLowerCase().includes(normalizedQuery) ||
				metadata.dataTypes.some((type) =>
					type.toLowerCase().includes(normalizedQuery),
				);

			if (!matchesQuery) {
				return false;
			}

			const hasSearch = searchConnectedProviders.has(provider);
			const hasAction = actionConnectedProviders.has(provider);

			if (capabilityFilter === "search" && !hasSearch) {
				return false;
			}
			if (capabilityFilter === "actions" && !hasAction) {
				return false;
			}
			if (capabilityFilter === "hybrid" && !(hasSearch && hasAction)) {
				return false;
			}

			// Status filter -- only applies when the badges feature is on
			// AND the user has narrowed past "all". With the flag off, the
			// filter chips are never rendered, so this branch only runs
			// when the user actively picked a non-`all` status.
			if (
				healthBadgesEnabled &&
				!matchesStatusFilter(
					provider,
					statusFilter,
					healthByProviderKey,
				)
			) {
				return false;
			}

			return true;
		});
	}, [
		allProviders,
		capabilityFilter,
		query,
		searchConnectedProviders,
		actionConnectedProviders,
		statusFilter,
		healthBadgesEnabled,
		healthByProviderKey,
	]);

	/*
	 * The status filter only earns its row once the registry knows
	 * something. On a fresh workspace every provider is "unknown", and a
	 * filter whose only populated bucket is Unknown is noise.
	 */
	const hasKnownHealth = useMemo(
		() =>
			healthBadgesEnabled &&
			allProviders.some((provider) => {
				const health = resolveProviderHealth(
					provider,
					healthByProviderKey,
				);
				return health !== "UNKNOWN" && health !== "NOT_CONFIGURED";
			}),
		[healthBadgesEnabled, allProviders, healthByProviderKey],
	);

	/*
	 * MCP servers from the registry, as tiles beside the integrations, so
	 * the page is one catalogue the way cosmos.augmentcode.com/connector is.
	 * A tile links to the MCP tab with the search prefilled to that server.
	 */
	const { data: mcpServers = [] } = useQuery({
		queryKey: ["connections", "mcp-registry", organizationId ?? "user"],
		queryFn: () =>
			orpcClient.mcp.registry.list({ organizationId, includeAll: true }),
		enabled: view !== "integrations",
		staleTime: 5 * 60 * 1000,
	});
	const filteredMcpServers = useMemo(() => {
		if (view === "integrations") {
			return [];
		}
		const normalizedQuery = query.trim().toLowerCase();
		return (mcpServers as McpRegistryServer[]).filter(
			(server) =>
				!normalizedQuery ||
				(server.name ?? "").toLowerCase().includes(normalizedQuery) ||
				(server.description ?? "")
					.toLowerCase()
					.includes(normalizedQuery),
		);
	}, [mcpServers, query, view]);

	/* MCP servers under their registry category, as Cosmos groups its connectors. */
	const mcpGroups = useMemo(() => {
		const groups = new Map<string, McpRegistryServer[]>();
		for (const server of filteredMcpServers) {
			const category = server.category?.trim() || "Other MCP servers";
			groups.set(category, [...(groups.get(category) ?? []), server]);
		}
		return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	}, [filteredMcpServers]);

	const filteredActionOnly = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();

		return ACTION_ONLY_PROVIDERS.filter((entry) => {
			const plugin = getActionOnlyProviderPlugin(entry.type);
			if (!plugin) {
				return false;
			}

			const matchesQuery =
				!normalizedQuery ||
				plugin.label.toLowerCase().includes(normalizedQuery) ||
				plugin.description.toLowerCase().includes(normalizedQuery) ||
				entry.keywords.some((keyword) =>
					keyword.toLowerCase().includes(normalizedQuery),
				);

			if (!matchesQuery) {
				return false;
			}

			const isConnected = connectedActionOnlyTypes.has(entry.type);

			// Action-only providers have no search/sync capability and no
			// health-registry row: "search"/"hybrid" never match, and any
			// non-"all" status filter hides them (they only surface under
			// "Any status").
			if (
				capabilityFilter === "search" ||
				capabilityFilter === "hybrid"
			) {
				return false;
			}
			if (capabilityFilter === "actions" && !isConnected) {
				return false;
			}
			if (healthBadgesEnabled && statusFilter !== "all") {
				return false;
			}

			return true;
		});
	}, [
		query,
		capabilityFilter,
		connectedActionOnlyTypes,
		healthBadgesEnabled,
		statusFilter,
	]);

	if (isLoading) {
		return (
			<div className="py-12 text-sm text-muted-foreground">
				Loading integrations...
			</div>
		);
	}

	if (error) {
		return (
			<div className="py-12 text-sm text-destructive">
				Failed to load integrations.
			</div>
		);
	}

	return (
		<div className="space-y-5">
			{/* Toolbar: what to show on the left, how to add more on the right. */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				{toolbarStart ?? <span aria-hidden="true" />}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button data-onboarding-target="integrations-add">
							Add connection
							<ChevronDown
								className="ml-1 size-4"
								aria-hidden="true"
							/>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							onSelect={() => {
								searchRef.current?.focus();
								searchRef.current?.scrollIntoView({
									block: "center",
									behavior: "smooth",
								});
							}}
						>
							Browse integrations
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link href={`${basePath}?tab=mcp`}>
								Add MCP server
							</Link>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Filters: one row. Search grows; the capability and status
			    switches sit beside it and wrap under it on narrow screens. */}
			<div className="flex flex-wrap items-center gap-3">
				<div
					data-onboarding-target="integrations-search"
					className="relative w-full min-w-[220px] max-w-sm flex-1"
				>
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						ref={searchRef}
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search integrations"
						className="pl-10"
					/>
				</div>
				<fieldset
					data-onboarding-target="integrations-capability-filter"
					className="inline-flex rounded-[8px] border border-border bg-background p-0.5"
				>
					<legend className="sr-only">Capability</legend>
					{(["all", "search", "actions", "hybrid"] as const).map(
						(filter) => (
							<button
								key={filter}
								type="button"
								aria-pressed={capabilityFilter === filter}
								onClick={() => setCapabilityFilter(filter)}
								className={cn(
									"rounded-[6px] px-3 py-1 text-sm transition-colors",
									capabilityFilter === filter
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{filter === "all"
									? "All"
									: filter === "search"
										? "Search"
										: filter === "actions"
											? "Actions"
											: "Hybrid"}
							</button>
						),
					)}
				</fieldset>
				{healthBadgesEnabled && hasKnownHealth ? (
					<fieldset
						className="inline-flex rounded-[8px] border border-border bg-background p-0.5"
						data-testid="provider-status-filter"
					>
						<legend className="sr-only">Provider status</legend>
						{STATUS_FILTER_OPTIONS.map((option) => (
							<button
								key={option.value}
								type="button"
								onClick={() => setStatusFilter(option.value)}
								aria-pressed={statusFilter === option.value}
								className={cn(
									"rounded-[6px] px-3 py-1 text-sm transition-colors",
									statusFilter === option.value
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{option.label}
							</button>
						))}
					</fieldset>
				) : null}
			</div>

			{/* Counts as one quiet line, not three badges. */}
			<p className="fab-label flex flex-wrap items-center gap-x-2">
				<span>
					{filteredProviders.length + filteredActionOnly.length} shown
				</span>
				<span aria-hidden="true">·</span>
				<span>{connections?.length ?? 0} search connected</span>
				<span aria-hidden="true">·</span>
				<span>
					{actionConnectedProviders.size +
						connectedActionOnlyTypes.size}{" "}
					actions connected
				</span>
			</p>

			{filteredProviders.length +
				filteredActionOnly.length +
				filteredMcpServers.length >
			0 ? (
				<div className="space-y-8">
					{PROVIDER_CATEGORIES.map((category) => {
						if (view === "mcp") {
							return null;
						}
						const providers = category.providers.filter(
							(provider) => filteredProviders.includes(provider),
						);
						if (providers.length === 0) {
							return null;
						}
						return (
							<IntegrationGroup
								key={category.id}
								title={category.name}
							>
								{providers.map((provider) => {
									const hasSearchConnection =
										searchConnectedProviders.has(provider);
									const hasActionConnection =
										actionConnectedProviders.has(provider);
									const href = `${settingsBasePath}/providers/${provider}`;
									const health = healthBadgesEnabled
										? resolveProviderHealth(
												provider,
												healthByProviderKey,
											)
										: null;
									return (
										<ProviderCard
											key={provider}
											provider={provider}
											href={href}
											hasSearchConnection={
												hasSearchConnection
											}
											hasActionConnection={
												hasActionConnection
											}
											health={health}
										/>
									);
								})}
							</IntegrationGroup>
						);
					})}
					{view !== "mcp" && filteredActionOnly.length > 0 ? (
						<IntegrationGroup title="Action integrations">
							{filteredActionOnly.map((entry) => (
								<ActionOnlyProviderCard
									key={entry.type}
									type={entry.type}
									href={`${settingsBasePath}/actions/${entry.type}`}
									hasConnection={connectedActionOnlyTypes.has(
										entry.type,
									)}
								/>
							))}
						</IntegrationGroup>
					) : null}
					{mcpGroups.map(([category, servers]) => (
						<IntegrationGroup
							key={`mcp-${category}`}
							title={category}
						>
							{servers.map((server) => (
								<IntegrationTile
									key={server.id}
									href={`${basePath}?tab=mcp&server=${encodeURIComponent(server.name ?? "")}`}
									icon={
										<McpServerIcon
											name={server.name}
											iconUrl={server.iconUrl}
											docsUrl={server.docsUrl}
											repositoryUrl={server.repositoryUrl}
											defaultUrl={server.defaultUrl}
											size={28}
											imageClassName="rounded-[6px] border-0 bg-transparent p-0 shadow-none"
											fallbackClassName="rounded-[6px] border-0 shadow-none"
										/>
									}
									name={
										server.name ??
										server.key ??
										"MCP server"
									}
									description={
										server.description ??
										"Model Context Protocol server"
									}
									connected={false}
								/>
							))}
						</IntegrationGroup>
					))}
				</div>
			) : (
				<div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
					No integrations match your current filters.
				</div>
			)}
		</div>
	);
}

/**
 * A category of tiles under a collapsible heading, as on
 * cosmos.augmentcode.com/connector: the name, a chevron, a two-column grid.
 */
function IntegrationGroup({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<Collapsible defaultOpen>
			<CollapsibleTrigger className="group/heading mb-3 inline-flex items-center gap-1.5 text-[15px] font-medium text-foreground">
				{title}
				<ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=closed]/heading:-rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="grid gap-3 sm:grid-cols-2">{children}</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
