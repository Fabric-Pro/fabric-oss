"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMonitoringFeatureFlag } from "@saas/shared/lib/use-monitoring-feature-flag";
import { IntegrationBrandIcon } from "@saas/workflows/components/integrations/IntegrationBrandIcon";
import { getIntegration } from "@saas/workflows/lib/plugins";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	AlertTriangleIcon,
	ArrowLeftIcon,
	CheckCircle2Icon,
	ExternalLinkIcon,
	HistoryIcon,
	SearchIcon,
	WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useProviderHealth } from "../hooks/useProviderHealth";
import { mapDataConnectionProviderToActionProvider } from "../lib/action-provider-mapping";
import {
	type DataConnectionProvider,
	getProviderMetadata,
} from "../lib/providers";
import { ConnectionModeBadge } from "./ConnectionModeBadge";
import {
	type GitLabTransport,
	GitLabTransportBadge,
} from "./GitLabTransportBadge";
import { IntegrationIncidentDrawer } from "./IntegrationIncidentDrawer";
import { ProviderHealthBadge } from "./ProviderHealthBadge";
import { ProviderIcon } from "./ProviderIcon";

export function IntegrationProviderPageContent({
	provider,
	settingsBasePath,
}: {
	provider: DataConnectionProvider;
	settingsBasePath: string;
}) {
	const { organizationId } = useOrganizationContext();
	const metadata = getProviderMetadata(provider);
	const actionProvider = mapDataConnectionProviderToActionProvider(provider);
	const actionPlugin = actionProvider ? getIntegration(actionProvider) : null;

	const { data: actionIntegrations, isLoading: isLoadingActions } = useQuery({
		queryKey: ["workflow-integrations", organizationId],
		queryFn: async () => {
			const result = await orpcClient.workflows.integrations.list({
				organizationId: organizationId ?? null,
			});
			return result.integrations;
		},
		staleTime: 0,
		refetchOnMount: "always",
	});

	// Provider-health lookup. Same `useProviderHealth()` hook the integrations
	// listing page uses so the cache is shared across navigations — the health
	// strip on the listing card and the badge on this detail page never
	// disagree because they read from the same query.
	const healthBadgesEnabled = useMonitoringFeatureFlag(
		"feature-integration-health-badges",
	);
	const { byProviderKey } = useProviderHealth({
		enabled: healthBadgesEnabled,
	});
	const providerHealth = healthBadgesEnabled
		? (byProviderKey[provider] ?? null)
		: null;

	const [incidentDrawerOpen, setIncidentDrawerOpen] = useState(false);

	const queryClient = useQueryClient();

	// GitLab-specific: fetch transport-mode probe data (only when provider is GITLAB)
	const isGitLab = provider === "GITLAB";
	const { data: gitlabStatus } = useQuery({
		queryKey: ["gitlab-oauth-status", organizationId],
		queryFn: async () => {
			return orpcClient.integrations.gitlab.status({
				organizationId: organizationId ?? null,
			});
		},
		enabled: isGitLab,
		staleTime: 30000,
	});

	const recheckMutation = useMutation({
		mutationFn: async () => {
			// Pass organizationId explicitly so the server doesn't fall back
			// to whatever org happens to be `activeOrganizationId` on the
			// session — must match the orgId used by the `status` query above.
			return orpcClient.integrations.gitlab.recheckCapabilities({
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["gitlab-oauth-status", organizationId],
			});
		},
		onError: (error) => {
			// Failed recheck (most often UNAUTHORIZED from a dead refresh
			// token) flips `needsReauth` on the server. Refetch the status
			// query so the transport badge swaps to "Reconnect required"
			// immediately, instead of staying on the stale "Connected via …"
			// label until the next navigation.
			queryClient.invalidateQueries({
				queryKey: ["gitlab-oauth-status", organizationId],
			});
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to re-check GitLab capabilities",
			);
		},
	});

	const gitlabTransport = useMemo((): GitLabTransport => {
		if (!isGitLab || !gitlabStatus?.connected) {
			return { kind: "unknown" };
		}
		const checkedAt = gitlabStatus.mcpProbe?.checkedAt ?? null;
		// needsReauth takes precedence over the transport mode. Stored
		// credentials still exist (connected=true) but the server already
		// confirmed they no longer work — surface that distinctly instead
		// of the cached "Connected via REST" label.
		if (gitlabStatus.needsReauth === true) {
			return { kind: "reauth-required", checkedAt };
		}
		if (gitlabStatus.useOfficialMcp === true) {
			return { kind: "official-mcp", checkedAt };
		}
		if (gitlabStatus.useOfficialMcp === false) {
			return { kind: "rest", checkedAt };
		}
		return { kind: "unknown" };
	}, [isGitLab, gitlabStatus]);

	const actionIntegration = useMemo(
		() =>
			actionProvider
				? (actionIntegrations?.find(
						(integration) =>
							integration.provider === actionProvider,
					) ?? null)
				: null,
		[actionIntegrations, actionProvider],
	);

	// Stored credentials exist AND we haven't already discovered they're
	// invalid. The Capability status block, the "Set Up Actions" /
	// "Manage Actions" CTA, and the action-source picker all hang off this
	// flag, so when GitLab's stored token is dead we treat it as
	// not-connected to avoid contradicting the badge.
	const hasActionConnection =
		Boolean(actionIntegration?.hasCredentials) &&
		!(isGitLab && gitlabStatus?.needsReauth === true);
	// Distinct from "never connected" — there's a stored credential but it
	// stopped working, so the user needs to reauth, not start from scratch.
	// Surfaced as its own callout because the generic "Set up runtime
	// credentials" copy doesn't tell them what's actually wrong.
	const gitlabReauthRequired =
		isGitLab &&
		Boolean(actionIntegration?.hasCredentials) &&
		gitlabStatus?.needsReauth === true;
	const isLoading = isLoadingActions;
	const actionHref =
		actionProvider && actionPlugin
			? `${settingsBasePath}/actions/${actionProvider}`
			: null;

	// Non-OPERATIONAL providers get the timeline link beneath the badge — same
	// `IntegrationIncidentDrawer` the listing card opens, so admins land in
	// the same surface whether they came from the card or this detail page.
	// NOT_CONFIGURED is excluded too: there's no incident to time, just an
	// env-var-missing notice that the badge tooltip already explains.
	const showTimelineLink =
		Boolean(providerHealth) &&
		providerHealth?.currentHealth !== "OPERATIONAL" &&
		providerHealth?.currentHealth !== "UNKNOWN" &&
		providerHealth?.currentHealth !== "NOT_CONFIGURED";

	return (
		<div className="space-y-6 px-6 pb-6 pt-2 md:px-8">
			<div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
				<div className="flex items-start gap-4">
					{actionPlugin ? (
						<IntegrationBrandIcon
							icon={
								typeof actionPlugin.icon === "function"
									? actionPlugin.icon
									: SearchIcon
							}
							label={metadata.name}
							color={actionPlugin.color}
							brandColor={actionPlugin.brandColor}
							size={56}
							className="rounded-2xl"
						/>
					) : (
						<ProviderIcon provider={provider} size="lg" />
					)}
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="text-2xl font-semibold tracking-tight">
								{metadata.name}
							</h2>
							<ConnectionModeBadge
								mode={metadata.connectionMode}
							/>
							{isGitLab && hasActionConnection ? (
								<GitLabTransportBadge
									transport={gitlabTransport}
									onRecheck={async () => {
										await recheckMutation.mutateAsync();
									}}
									isRechecking={recheckMutation.isPending}
								/>
							) : null}
							{providerHealth ? (
								<ProviderHealthBadge
									status={providerHealth.currentHealth}
									providerName={
										providerHealth.displayName ??
										metadata.name
									}
									incidentSummary={
										providerHealth.activeIncident?.summary
									}
									startedAt={
										providerHealth.activeIncident
											?.startedAt ?? null
									}
									statusPageUrl={
										providerHealth.statusPageUrl ??
										providerHealth.activeIncident
											?.statusPageUrl ??
										null
									}
									onClickOpenDrawer={
										providerHealth.activeIncident
											? () => setIncidentDrawerOpen(true)
											: undefined
									}
									// Larger badge for the detail-page hero so
									// the colored status circle reads clearly
									// next to the 2xl provider name. Listing
									// cards keep the default compact size.
									size="lg"
								/>
							) : null}
							{hasActionConnection ? (
								<Badge
									variant="outline"
									className="gap-1 border-success/30 bg-success/10 text-success"
								>
									<CheckCircle2Icon className="h-3 w-3" />
									Configured
								</Badge>
							) : null}
						</div>
						<p className="max-w-2xl text-sm leading-6 text-muted-foreground">
							{metadata.description}
						</p>
						{showTimelineLink ? (
							<button
								type="button"
								onClick={() => setIncidentDrawerOpen(true)}
								className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
							>
								<HistoryIcon className="h-3.5 w-3.5" />
								View incident timeline
							</button>
						) : null}
						<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
							{actionPlugin ? (
								<>
									<span className="rounded-full border px-3 py-1">
										Runtime actions
									</span>
									<span className="rounded-full border px-3 py-1">
										{actionPlugin.actions.length} available
										actions
									</span>
								</>
							) : null}
						</div>
					</div>
				</div>
				<Button variant="outline" asChild>
					<Link href={settingsBasePath}>
						<ArrowLeftIcon className="mr-2 h-4 w-4" />
						Back to Integrations
					</Link>
				</Button>
			</div>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
				<div className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>Connection Setup</CardTitle>
							<CardDescription>
								Configure live runtime actions for this
								provider.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							{gitlabReauthRequired && actionHref ? (
								<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
									<div className="flex items-start justify-between gap-4">
										<div className="space-y-1">
											<div className="flex items-center gap-2">
												<AlertTriangleIcon className="h-4 w-4 text-destructive" />
												<p className="text-sm font-medium text-destructive">
													Reconnect required
												</p>
											</div>
											<p className="text-sm text-muted-foreground">
												Your stored GitLab credential
												stopped working (the refresh
												token expired or was revoked).
												Reconnect via OAuth to restore
												runtime actions.
											</p>
										</div>
										<Button variant="default" asChild>
											<Link href={actionHref}>
												Reconnect GitLab
											</Link>
										</Button>
									</div>
								</div>
							) : null}
							{actionPlugin ? (
								<div className="rounded-lg border border-border/70 bg-muted/20 p-4">
									<div className="flex items-start justify-between gap-4">
										<div className="space-y-1">
											<div className="flex items-center gap-2">
												<WrenchIcon className="h-4 w-4 text-muted-foreground" />
												<p className="text-sm font-medium">
													Runtime actions
												</p>
											</div>
											<p className="text-sm text-muted-foreground">
												{hasActionConnection
													? "This provider can already run live actions inside workflows and agent tools."
													: "Set up runtime credentials if you want Fabric to call this provider live."}
											</p>
										</div>
										{actionHref ? (
											<Button
												variant={
													hasActionConnection
														? "outline"
														: "default"
												}
												asChild
											>
												<Link href={actionHref}>
													{hasActionConnection
														? "Manage Actions"
														: "Set Up Actions"}
												</Link>
											</Button>
										) : null}
									</div>
								</div>
							) : (
								<div className="rounded-lg border border-border/70 bg-muted/20 p-4">
									<div className="flex items-center gap-2">
										<WrenchIcon className="h-4 w-4 text-muted-foreground" />
										<p className="text-sm font-medium">
											Actions setup not yet available
										</p>
									</div>
									<p className="mt-1 text-sm text-muted-foreground">
										Live runtime actions for this provider
										are coming soon. Until then, this
										provider can't be wired into workflows,
										agent tools, or PM-sync from Fabric.
									</p>
								</div>
							)}

							{isLoading ? (
								<div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
									Loading capability status...
								</div>
							) : null}
						</CardContent>
					</Card>

					{actionPlugin && actionPlugin.actions.length > 0 ? (
						<Card>
							<CardHeader>
								<CardTitle>Available actions</CardTitle>
								<CardDescription>
									These are the operations Fabric can run
									through {metadata.name}
									once runtime actions are configured.
								</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="grid gap-3 md:grid-cols-2">
									{actionPlugin.actions.map((action) => (
										<div
											key={action.slug}
											className="rounded-xl border p-4"
										>
											<div className="flex items-center gap-2">
												<p className="font-medium">
													{action.label}
												</p>
												<Badge
													variant="outline"
													className="text-[10px] uppercase tracking-[0.15em]"
												>
													{action.category}
												</Badge>
											</div>
											<p className="mt-2 text-sm leading-6 text-muted-foreground">
												{action.description}
											</p>
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					) : null}
				</div>

				<div className="space-y-4">
					{actionPlugin ? (
						<Card>
							<CardHeader>
								<CardTitle>Capability status</CardTitle>
								<CardDescription>
									Review runtime actions for this provider.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-3">
								<div className="rounded-xl border p-4">
									<div className="flex items-start justify-between gap-3">
										<div>
											<p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
												Actions
											</p>
											<p className="mt-2 whitespace-nowrap text-lg font-semibold leading-none">
												{hasActionConnection
													? "Connected"
													: "Not connected"}
											</p>
										</div>
										<Badge variant="outline">Runtime</Badge>
									</div>
									{actionHref ? (
										<Button
											className="mt-4 w-full"
											variant="outline"
											asChild
										>
											<Link href={actionHref}>
												{hasActionConnection
													? "Manage Actions"
													: "Set Up Actions"}
											</Link>
										</Button>
									) : null}
								</div>
							</CardContent>
						</Card>
					) : null}

					{metadata.docsUrl ? (
						<Card>
							<CardHeader>
								<CardTitle>Provider docs</CardTitle>
							</CardHeader>
							<CardContent>
								<a
									href={metadata.docsUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
								>
									Open setup docs
									<ExternalLinkIcon className="h-4 w-4" />
								</a>
							</CardContent>
						</Card>
					) : null}
				</div>
			</div>

			{providerHealth ? (
				<IntegrationIncidentDrawer
					providerKey={provider}
					providerName={providerHealth.displayName ?? metadata.name}
					statusPageUrl={providerHealth.statusPageUrl}
					open={incidentDrawerOpen}
					onOpenChange={setIncidentDrawerOpen}
				/>
			) : null}
		</div>
	);
}
