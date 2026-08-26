"use client";

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Progress } from "@ui/components/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
	ArrowLeft,
	ArrowUpRight,
	Check,
	Clock,
	FileText,
	LinkIcon,
	Pause,
	Pencil,
	Play,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "../hooks/useConnection";
import {
	useDeleteConnection,
	useUpdateConnection,
} from "../hooks/useConnections";
import { useSyncProgress } from "../hooks/useSyncProgress";
import { mapDataConnectionProviderToActionProvider } from "../lib/action-provider-mapping";
import { getProviderMetadata, isConnectionStale } from "../lib/providers";
import { ConnectionModeBadge } from "./ConnectionModeBadge";
import { ProviderIcon } from "./ProviderIcon";
import { ResourceManagementPanel } from "./ResourceManagementPanel";
import { SyncStatusBadge } from "./SyncStatusBadge";

const SYNC_DISABLED_TOOLTIP =
	"Background sync is being retired and is disabled for new operations.";

const JOB_STATUS_STYLES: Record<string, { label: string; className: string }> =
	{
		PENDING: {
			label: "Pending",
			className: "text-highlight border-highlight/30 bg-highlight/10",
		},
		RUNNING: {
			label: "Running",
			className: "text-primary border-primary/30 bg-primary/10",
		},
		COMPLETED: {
			label: "Completed",
			className: "text-success border-success/30 bg-success/10",
		},
		FAILED: {
			label: "Failed",
			className:
				"text-destructive border-destructive/30 bg-destructive/10",
		},
		CANCELLED: {
			label: "Cancelled",
			className: "text-muted-foreground border-border bg-muted",
		},
	};

export function ConnectionDetailPageContent({
	connectionId,
}: {
	connectionId: string;
}) {
	const integrationsPath = useContextPath("settings/integrations");
	const { organizationId } = useOrganizationContext();
	const { data: syncJobs } = useSyncProgress(connectionId);

	const latestJob = syncJobs?.[0] ?? null;
	const isJobRunning = latestJob?.status === "RUNNING";
	const prevRunningRef = useRef(false);

	const {
		data: connection,
		isLoading,
		refetch,
	} = useConnection(connectionId, {
		refetchInterval: isJobRunning ? 3000 : false,
	});

	// Final refetch when job transitions from RUNNING → terminal
	useEffect(() => {
		if (prevRunningRef.current && !isJobRunning) {
			refetch();
		}
		prevRunningRef.current = isJobRunning;
	}, [isJobRunning, refetch]);

	const deleteConnection = useDeleteConnection();
	const updateConnection = useUpdateConnection();

	const [editingName, setEditingName] = useState(false);
	const [nameInput, setNameInput] = useState("");
	const [resourcePage, setResourcePage] = useState(0);
	const RESOURCES_PER_PAGE = 10;

	const queryClient = useQueryClient();

	const { data: resourcesData } = useQuery({
		queryKey: ["synced-resources", connectionId, resourcePage],
		queryFn: async () => {
			const result = await orpcClient.dataConnections.resources.list({
				id: connectionId,
				organizationId: organizationId ?? null,
				limit: RESOURCES_PER_PAGE,
				offset: resourcePage * RESOURCES_PER_PAGE,
			});
			return result;
		},
		enabled: Boolean(connectionId),
	});

	const relinkFromActions = useMutation({
		mutationFn: async () => {
			if (!connection) {
				throw new Error("No connection");
			}
			return orpcClient.dataConnections.linkWorkflow({
				provider: connection.provider,
				name: connection.name,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["data-connections"] });
			refetch();
		},
	});

	if (isLoading) {
		return (
			<div className="py-10 text-sm text-muted-foreground">
				Loading integration...
			</div>
		);
	}

	if (!connection) {
		return (
			<Card>
				<CardContent className="py-10">
					<p className="text-sm text-muted-foreground">
						Integration not found.
					</p>
					<Button className="mt-4" asChild>
						<Link href={integrationsPath}>
							Back to Integrations
						</Link>
					</Button>
				</CardContent>
			</Card>
		);
	}

	const metadata = getProviderMetadata(connection.provider);
	const providerPath = `${integrationsPath}/providers/${connection.provider}`;
	const actionProvider = mapDataConnectionProviderToActionProvider(
		connection.provider,
	);
	const actionsSetupHref = actionProvider
		? `${integrationsPath}/actions/${actionProvider}`
		: null;
	const isSyncing = connection.status === "SYNCING";
	const stale = isConnectionStale(connection.lastSyncAt, connection.provider);
	const lastSyncTime = connection.lastSyncAt
		? new Date(connection.lastSyncAt).getTime()
		: null;

	// Prefer live sync job list over the embedded snapshot
	const displayJobs = syncJobs ?? connection.syncJobs;

	// Progress indicator for running job
	const runningProgress =
		latestJob?.status === "RUNNING" && latestJob.totalItems
			? Math.round(
					(latestJob.processedItems / latestJob.totalItems) * 100,
				)
			: null;

	return (
		<div className="space-y-6">
			<Button variant="ghost" asChild>
				<Link href={providerPath}>
					<ArrowLeft className="mr-2 h-4 w-4" />
					Back to Provider
				</Link>
			</Button>

			<DeprecatedConnectionBanner actionsSetupHref={actionsSetupHref} />

			{/*
			 * Renders only when status === "EXPIRED". After the one-shot pause
			 * script runs every connection becomes PAUSED, so this branch
			 * stops rendering and no extra disable code is required.
			 */}
			{connection.status === "EXPIRED" ? (
				<div className="flex items-start gap-3 rounded-lg border border-highlight/30 bg-highlight/10 px-4 py-3">
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-highlight" />
					<div className="flex-1 text-sm">
						<p className="font-medium text-highlight">
							Credential expired
						</p>
						<p className="mt-0.5 text-muted-foreground">
							The access token for this connection has expired.
							Reconnect via{" "}
							<Link
								href={`${integrationsPath}/actions/${connection.provider}`}
								className="underline underline-offset-2"
							>
								{metadata.name} Actions
							</Link>{" "}
							to restore search sync.
						</p>
					</div>
					<Button
						size="sm"
						variant="outline"
						className="shrink-0 border-highlight/30 text-highlight hover:bg-highlight/10"
						disabled={relinkFromActions.isPending}
						onClick={() => relinkFromActions.mutate()}
					>
						<LinkIcon className="mr-2 h-3.5 w-3.5" />
						Re-link from Actions
					</Button>
				</div>
			) : null}

			<Card>
				<CardHeader>
					<div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
						<div className="flex items-start gap-4">
							<ProviderIcon
								provider={connection.provider}
								size="md"
							/>
							<div className="space-y-2">
								<div className="flex flex-wrap items-center gap-2">
									{editingName ? (
										<div className="flex items-center gap-2">
											<Input
												value={nameInput}
												onChange={(e) =>
													setNameInput(e.target.value)
												}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														updateConnection.mutate(
															{
																id: connection.id,
																name:
																	nameInput.trim() ||
																	connection.name,
															},
															{
																onSuccess:
																	() => {
																		setEditingName(
																			false,
																		);
																		refetch();
																	},
															},
														);
													} else if (
														e.key === "Escape"
													) {
														setEditingName(false);
													}
												}}
												className="h-8 w-48 text-sm font-semibold"
												autoFocus
											/>
											<Button
												size="icon"
												variant="ghost"
												className="h-7 w-7"
												onClick={() =>
													updateConnection.mutate(
														{
															id: connection.id,
															name:
																nameInput.trim() ||
																connection.name,
														},
														{
															onSuccess: () => {
																setEditingName(
																	false,
																);
																refetch();
															},
														},
													)
												}
											>
												<Check className="h-3.5 w-3.5 text-success" />
											</Button>
											<Button
												size="icon"
												variant="ghost"
												className="h-7 w-7"
												onClick={() =>
													setEditingName(false)
												}
											>
												<X className="h-3.5 w-3.5 text-muted-foreground" />
											</Button>
										</div>
									) : (
										<div className="flex items-center gap-1.5">
											<CardTitle>
												{connection.name}
											</CardTitle>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														size="icon"
														variant="ghost"
														className="h-6 w-6 opacity-50 aria-disabled:cursor-not-allowed"
														aria-disabled="true"
														aria-label="Rename connection (disabled — background sync is being retired)"
													>
														<Pencil className="h-3 w-3" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{SYNC_DISABLED_TOOLTIP}
												</TooltipContent>
											</Tooltip>
										</div>
									)}
									<ConnectionModeBadge
										mode={metadata.connectionMode}
									/>
									<SyncStatusBadge
										status={connection.status}
									/>
									{stale ? (
										<Badge variant="outline">Stale</Badge>
									) : null}
								</div>
								<CardDescription>
									{metadata.description}
								</CardDescription>
								<p className="text-sm text-muted-foreground">
									{metadata.searchFirstPrompt}
								</p>
							</div>
						</div>

						<div className="flex flex-wrap gap-2">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										className="opacity-50 aria-disabled:cursor-not-allowed"
										aria-disabled="true"
										aria-label={
											isSyncing
												? "Cancel Sync (disabled — background sync is being retired)"
												: "Sync Now (disabled — background sync is being retired)"
										}
									>
										{isSyncing ? (
											<>
												<Pause className="mr-2 h-4 w-4" />
												Cancel Sync
											</>
										) : (
											<>
												<RefreshCw className="mr-2 h-4 w-4" />
												Sync Now
											</>
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{SYNC_DISABLED_TOOLTIP}
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										className="opacity-50 aria-disabled:cursor-not-allowed"
										aria-disabled="true"
										aria-label="Full Reindex (disabled — background sync is being retired)"
									>
										<Play className="mr-2 h-4 w-4" />
										Full Reindex
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{SYNC_DISABLED_TOOLTIP}
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										className="text-muted-foreground opacity-50 aria-disabled:cursor-not-allowed"
										aria-disabled="true"
										aria-label="Remove Duplicates (disabled — background sync is being retired)"
									>
										<Trash2 className="mr-2 h-4 w-4" />
										Remove Duplicates
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{SYNC_DISABLED_TOOLTIP}
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										className="text-muted-foreground opacity-50 aria-disabled:cursor-not-allowed"
										aria-disabled="true"
										aria-label="Clear Data (disabled — background sync is being retired)"
									>
										<Trash2 className="mr-2 h-4 w-4" />
										Clear Data
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{SYNC_DISABLED_TOOLTIP}
								</TooltipContent>
							</Tooltip>
							<Button
								variant="outline"
								className="text-destructive"
								onClick={() =>
									deleteConnection.mutate(connection.id, {
										onSuccess: () => {
											window.location.href =
												integrationsPath;
										},
									})
								}
							>
								<Trash2 className="mr-2 h-4 w-4" />
								Delete
							</Button>
						</div>
					</div>

					{/* Live progress bar */}
					{isJobRunning && (
						<div className="mt-4 space-y-1">
							<div className="flex items-center justify-between text-xs text-muted-foreground">
								<span>Syncing…</span>
								{runningProgress !== null ? (
									<span>{runningProgress}%</span>
								) : (
									<span>
										{latestJob.processedItems} items
										processed
									</span>
								)}
							</div>
							<Progress
								value={runningProgress ?? undefined}
								className="h-1.5"
							/>
						</div>
					)}
				</CardHeader>

				<CardContent className="grid gap-4 md:grid-cols-3">
					<div className="rounded-lg border p-4">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<FileText className="h-4 w-4" />
							Indexed Documents
						</div>
						<p className="mt-2 text-2xl font-semibold">
							{connection._count.syncedResources.toLocaleString()}
						</p>
					</div>
					<div className="rounded-lg border p-4">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Clock className="h-4 w-4" />
							Last Sync
						</div>
						<p className="mt-2 text-sm font-medium">
							{connection.lastSyncAt
								? formatDistanceToNow(
										new Date(connection.lastSyncAt),
										{
											addSuffix: true,
										},
									)
								: "Never synced"}
						</p>
					</div>
					<div className="rounded-lg border p-4">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<RefreshCw className="h-4 w-4" />
							Sync Jobs
						</div>
						<p className="mt-2 text-2xl font-semibold">
							{connection._count.syncJobs.toLocaleString()}
						</p>
					</div>
				</CardContent>
			</Card>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Recent Sync Jobs</CardTitle>
						<CardDescription>
							Latest indexing and refresh activity for this
							integration.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						{displayJobs.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No sync jobs yet.
							</p>
						) : (
							displayJobs.map((job) => {
								const createdAt = new Date(
									job.createdAt,
								).getTime();
								const inferredStatus =
									job.status === "PENDING" &&
									connection.status === "CONNECTED" &&
									lastSyncTime !== null &&
									lastSyncTime >= createdAt
										? "COMPLETED"
										: job.status;

								const style =
									JOB_STATUS_STYLES[inferredStatus] ??
									JOB_STATUS_STYLES.PENDING;

								const isRunning = job.status === "RUNNING";
								const progress =
									isRunning && job.totalItems
										? Math.round(
												(job.processedItems /
													job.totalItems) *
													100,
											)
										: null;

								return (
									<div
										key={job.id}
										className="rounded-lg border p-3"
									>
										<div className="flex items-center justify-between gap-3">
											<div>
												<p className="text-sm font-medium">
													{job.type.replaceAll(
														"_",
														" ",
													)}
												</p>
												<p className="text-xs text-muted-foreground">
													{formatDistanceToNow(
														new Date(job.createdAt),
														{ addSuffix: true },
													)}
												</p>
											</div>
											<Badge
												variant="outline"
												className={cn(
													"text-[11px]",
													style.className,
												)}
											>
												{style.label}
											</Badge>
										</div>
										{isRunning && (
											<div className="mt-2 space-y-1">
												<Progress
													value={
														progress ?? undefined
													}
													className="h-1"
												/>
												{progress !== null && (
													<p className="text-right text-[10px] text-muted-foreground">
														{progress}%
													</p>
												)}
											</div>
										)}
									</div>
								);
							})
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Recently Synced Resources</CardTitle>
						<CardDescription>
							The latest documents and records indexed from this
							integration.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						{!resourcesData ||
						resourcesData.resources.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No resources indexed yet.
							</p>
						) : (
							<>
								{resourcesData.resources.map((resource) => (
									<div
										key={resource.id}
										className="rounded-lg border p-3"
									>
										<p className="text-sm font-medium">
											{resource.title ??
												resource.externalId}
										</p>
										<div className="mt-1 flex items-center gap-2">
											<p className="text-xs text-muted-foreground">
												Updated{" "}
												{formatDistanceToNow(
													new Date(
														resource.updatedAt,
													),
													{ addSuffix: true },
												)}
											</p>
											{resource.syncStatus ===
											"EXCLUDED" ? (
												<Badge
													variant="outline"
													className="text-[10px] text-muted-foreground"
												>
													Excluded
												</Badge>
											) : null}
										</div>
									</div>
								))}
								<div className="flex items-center justify-between border-t pt-3">
									<p className="text-xs text-muted-foreground">
										{connection._count.syncedResources}{" "}
										total
									</p>
									<div className="flex gap-2">
										<Button
											variant="outline"
											size="sm"
											disabled={resourcePage === 0}
											onClick={() =>
												setResourcePage((p) =>
													Math.max(0, p - 1),
												)
											}
										>
											Previous
										</Button>
										<span className="flex items-center px-2 text-xs text-muted-foreground">
											Page {resourcePage + 1}
										</span>
										<Button
											variant="outline"
											size="sm"
											disabled={
												(resourcePage + 1) *
													RESOURCES_PER_PAGE >=
												connection._count
													.syncedResources
											}
											onClick={() =>
												setResourcePage((p) => p + 1)
											}
										>
											Next
										</Button>
									</div>
								</div>
							</>
						)}
					</CardContent>
				</Card>
			</div>

			{connection.provider === "GITHUB" ? (
				<GitHubConfigCard connection={connection} onUpdated={refetch} />
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Manage Content</CardTitle>
					<CardDescription>
						Control which content is included in your knowledge
						base. Exclude items to prevent them from being indexed,
						or browse available content to queue new items for sync.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ResourceManagementPanel
						connectionId={connection.id}
						provider={connection.provider}
						isSyncing={isSyncing}
						mutationsDisabled
					/>
				</CardContent>
			</Card>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Deprecated connection banner
// ---------------------------------------------------------------------------

function DeprecatedConnectionBanner({
	actionsSetupHref,
}: {
	actionsSetupHref: string | null;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: <aside> provides the landmark; role="status" adds the polite live-region announcement on initial render. <output> is for form-derived values, not contextual page banners.
		<aside
			role="status"
			className="flex flex-col gap-3 rounded-lg border border-border bg-muted px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
		>
			<div className="flex-1 text-sm text-muted-foreground">
				<p>
					<span className="font-medium text-foreground">
						This view is being retired.
					</span>{" "}
					Background sync of indexed knowledge is no longer used by
					Fabric features.
					{actionsSetupHref ? (
						<>
							{" "}
							To set up live actions for this provider, open
							Actions setup instead. Existing data will remain
							visible here for now.
						</>
					) : (
						<> Existing data will remain visible here for now.</>
					)}
				</p>
			</div>
			{actionsSetupHref ? (
				<Button
					variant="outline"
					size="sm"
					asChild
					className="shrink-0 self-start"
				>
					<Link href={actionsSetupHref}>
						Open Actions setup
						<ArrowUpRight className="ml-1 h-3.5 w-3.5" />
					</Link>
				</Button>
			) : null}
		</aside>
	);
}

// ---------------------------------------------------------------------------
// GitHub-specific configuration card
// ---------------------------------------------------------------------------

function GitHubConfigCard({
	connection,
	onUpdated,
}: {
	connection: { id: string; config: unknown };
	onUpdated: () => void;
}) {
	const updateConnection = useUpdateConnection();
	const cfg = (
		connection.config && typeof connection.config === "object"
			? connection.config
			: {}
	) as Record<string, unknown>;

	const [editing, setEditing] = useState(false);
	const [repos, setRepos] = useState(
		Array.isArray(cfg.repos) ? (cfg.repos as string[]).join(", ") : "",
	);
	const [includeIssues, setIncludeIssues] = useState(
		cfg.includeIssues !== false,
	);
	const [includePRs, setIncludePRs] = useState(
		cfg.includePullRequests !== false,
	);
	const [includeDiscussions, setIncludeDiscussions] = useState(
		Boolean(cfg.includeDiscussions),
	);
	const [includeCode, setIncludeCode] = useState(Boolean(cfg.includeCode));

	function handleSave() {
		const repoList = repos
			.split(",")
			.map((r) => r.trim())
			.filter(Boolean);
		updateConnection.mutate(
			{
				id: connection.id,
				config: {
					...cfg,
					repos: repoList.length > 0 ? repoList : undefined,
					includeIssues,
					includePullRequests: includePRs,
					includeDiscussions,
					includeCode,
				},
			},
			{
				onSuccess: () => {
					setEditing(false);
					onUpdated();
				},
			},
		);
	}

	const rows: { label: string; value: string; positive: boolean }[] = [
		{
			label: "Repositories",
			value: repos.trim() || "All accessible repos",
			positive: true,
		},
		{
			label: "Issues",
			value: includeIssues ? "Synced" : "Excluded",
			positive: includeIssues,
		},
		{
			label: "Pull requests",
			value: includePRs ? "Synced" : "Excluded",
			positive: includePRs,
		},
		{
			label: "Discussions",
			value: includeDiscussions ? "Synced" : "Excluded",
			positive: includeDiscussions,
		},
		{
			label: "Code",
			value: includeCode ? "Synced" : "Excluded",
			positive: includeCode,
		},
	];

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Connector Settings</CardTitle>
						<CardDescription>
							Which repositories and content types are indexed
							from GitHub.
						</CardDescription>
					</div>
					{!editing ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setEditing(true)}
						>
							<Pencil className="mr-2 h-3.5 w-3.5" />
							Edit
						</Button>
					) : (
						<div className="flex gap-2">
							<Button
								size="sm"
								onClick={handleSave}
								disabled={updateConnection.isPending}
							>
								<Check className="mr-2 h-3.5 w-3.5" />
								Save
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setEditing(false)}
							>
								Cancel
							</Button>
						</div>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{editing ? (
					<div className="space-y-4">
						<div className="space-y-1.5">
							<label className="text-sm font-medium text-foreground">
								Repositories
							</label>
							<Input
								value={repos}
								onChange={(e) => setRepos(e.target.value)}
								placeholder="owner/repo1, owner/repo2 (leave blank for all)"
								className="text-sm"
							/>
							<p className="text-xs text-muted-foreground">
								Comma-separated list. Leave blank to sync all
								accessible repositories.
							</p>
						</div>
						<div className="space-y-2">
							<p className="text-sm font-medium text-foreground">
								Sync content types
							</p>
							{(
								[
									[
										"includeIssues",
										"Issues",
										includeIssues,
										setIncludeIssues,
									],
									[
										"includePRs",
										"Pull requests",
										includePRs,
										setIncludePRs,
									],
									[
										"includeDiscussions",
										"Discussions",
										includeDiscussions,
										setIncludeDiscussions,
									],
									[
										"includeCode",
										"Code files",
										includeCode,
										setIncludeCode,
									],
								] as [
									string,
									string,
									boolean,
									(v: boolean) => void,
								][]
							).map(([id, label, value, setter]) => (
								<label
									key={id}
									className="flex cursor-pointer items-center gap-2.5 text-sm"
								>
									<input
										type="checkbox"
										checked={value}
										onChange={(e) =>
											setter(e.target.checked)
										}
										className="h-4 w-4 rounded border-border"
									/>
									<span className="text-muted-foreground">
										{label}
									</span>
								</label>
							))}
						</div>
					</div>
				) : (
					<dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
						{rows.map((row) => (
							<div
								key={row.label}
								className="flex flex-col gap-0.5"
							>
								<dt className="text-xs text-muted-foreground">
									{row.label}
								</dt>
								<dd
									className={cn(
										"font-medium",
										row.positive
											? "text-foreground"
											: "text-muted-foreground",
									)}
								>
									{row.value}
								</dd>
							</div>
						))}
					</dl>
				)}
			</CardContent>
		</Card>
	);
}
