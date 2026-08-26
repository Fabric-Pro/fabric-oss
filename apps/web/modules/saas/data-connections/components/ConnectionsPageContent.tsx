"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMonitoringFeatureFlag } from "@saas/shared/lib/use-monitoring-feature-flag";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
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
import { ProviderCard } from "./ProviderCard";

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
	addHref: string;
	settingsBasePath: string;
}

export function ConnectionsPageContent({
	addHref,
	settingsBasePath,
}: ConnectionsPageContentProps) {
	const { organizationId } = useOrganizationContext();
	const { data: connections, isLoading, error } = useConnections();
	const [query, setQuery] = useState("");
	const [capabilityFilter, setCapabilityFilter] =
		useState<CapabilityFilter>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");

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
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-1">
					<h2 className="text-lg font-semibold">Integrations</h2>
					<p className="text-sm text-muted-foreground">
						Each system appears once. Search and action capabilities
						are shown on the same card.
					</p>
				</div>
				<Button asChild data-onboarding-target="integrations-add">
					<Link href={addHref}>
						<Plus className="mr-2 h-4 w-4" />
						Add Integration
					</Link>
				</Button>
			</div>

			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div
					data-onboarding-target="integrations-search"
					className="relative w-full max-w-md"
				>
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search integrations"
						className="pl-10"
					/>
				</div>
				<div
					data-onboarding-target="integrations-capability-filter"
					className="flex flex-wrap gap-2"
				>
					{(["all", "search", "actions", "hybrid"] as const).map(
						(filter) => (
							<Button
								key={filter}
								variant={
									capabilityFilter === filter
										? "default"
										: "outline"
								}
								size="sm"
								onClick={() => setCapabilityFilter(filter)}
							>
								{filter === "all"
									? "All"
									: filter === "search"
										? "Search"
										: filter === "actions"
											? "Actions"
											: "Hybrid"}
							</Button>
						),
					)}
				</div>
			</div>

			{healthBadgesEnabled ? (
				<div
					className="flex flex-wrap items-center gap-2"
					data-testid="provider-status-filter"
				>
					<span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						Provider status
					</span>
					{STATUS_FILTER_OPTIONS.map((option) => (
						<Button
							key={option.value}
							variant={
								statusFilter === option.value
									? "default"
									: "outline"
							}
							size="sm"
							onClick={() => setStatusFilter(option.value)}
							aria-pressed={statusFilter === option.value}
						>
							{option.label}
						</Button>
					))}
				</div>
			) : null}

			<div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
				<Badge variant="outline">
					{filteredProviders.length + filteredActionOnly.length} shown
				</Badge>
				<Badge variant="outline">
					{connections?.length ?? 0} search connected
				</Badge>
				<Badge variant="outline">
					{actionConnectedProviders.size +
						connectedActionOnlyTypes.size}{" "}
					actions connected
				</Badge>
			</div>

			{filteredProviders.length + filteredActionOnly.length > 0 ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{filteredProviders.map((provider) => {
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
								hasSearchConnection={hasSearchConnection}
								hasActionConnection={hasActionConnection}
								health={health}
							/>
						);
					})}
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
				</div>
			) : (
				<div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
					No integrations match your current filters.
				</div>
			)}
		</div>
	);
}
