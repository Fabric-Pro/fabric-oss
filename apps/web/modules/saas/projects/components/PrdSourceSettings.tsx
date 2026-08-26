"use client";

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import { SearchInput } from "@ui/components/search-input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	CheckCircle2Icon,
	ExternalLinkIcon,
	FileTextIcon,
	Loader2Icon,
	RefreshCwIcon,
	SearchIcon,
	SettingsIcon,
	XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Project = {
	id: string;
	name: string;
	organizationId?: string | null;
	prdSourceContextId?: string | null;
	prdSourceTitle?: string | null;
	prdSourceUrl?: string | null;
};

type Props = {
	project: Project;
};

function getResourceUrl(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}

	const record = metadata as Record<string, unknown>;
	for (const key of ["url", "sourceUrl", "webUrl"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return null;
}

export function PrdSourceSettings({ project }: Props) {
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.projectSettings");
	const clearPrdSourceCopy = t.raw("clearPrdSource") as {
		label: string;
		warning: string;
	};
	const integrationsSettingsUrlRaw = useContextPath("settings/integrations");
	const buildReturnUrl = useSettingsReturnUrl();
	const integrationsSettingsUrl = buildReturnUrl(integrationsSettingsUrlRaw);
	const [selectedConnectionId, setSelectedConnectionId] = useState<
		string | null
	>(null);
	const [showBrowser, setShowBrowser] = useState(false);
	const [pageSearch, setPageSearch] = useState("");

	const { data: prdStatus } = useQuery({
		queryKey: ["prd-source-status", project.id, project.organizationId],
		queryFn: async () =>
			orpcClient.projects.prdSource.status({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
			}),
	});

	const { data: notionConnections, isLoading: connectionsLoading } = useQuery(
		{
			queryKey: [
				"project-prd-notion-connections",
				project.organizationId,
			],
			queryFn: async () => {
				const result = await orpcClient.dataConnections.list({
					organizationId: project.organizationId ?? null,
					provider: "NOTION",
				});

				return result.connections.filter(
					(connection) =>
						connection.status === "CONNECTED" ||
						connection.status === "SYNCING",
				);
			},
		},
	);

	useEffect(() => {
		if (
			!selectedConnectionId &&
			notionConnections &&
			notionConnections.length > 0
		) {
			setSelectedConnectionId(
				prdStatus?.connectionId || notionConnections[0]?.id || null,
			);
		}
	}, [notionConnections, prdStatus?.connectionId, selectedConnectionId]);

	const { data: notionResources, isLoading: resourcesLoading } = useQuery({
		queryKey: [
			"project-prd-notion-resources",
			project.organizationId,
			selectedConnectionId,
		],
		enabled: !!selectedConnectionId,
		queryFn: async () => {
			const result = await orpcClient.dataConnections.resources.list({
				// biome-ignore lint/style/noNonNullAssertion: enabled guard ensures selectedConnectionId is defined
				id: selectedConnectionId!,
				organizationId: project.organizationId ?? null,
				limit: 100,
			});

			return result.resources.filter(
				(resource) =>
					resource.syncStatus === "SYNCED" && !!resource.document?.id,
			);
		},
	});

	const { data: notionPages, isLoading: pagesLoading } = useQuery({
		queryKey: [
			"notion-browse-pages",
			selectedConnectionId,
			project.organizationId,
			pageSearch,
		],
		enabled: showBrowser && !!selectedConnectionId,
		queryFn: async () => {
			const result = await orpcClient.dataConnections.notion.pages({
				// biome-ignore lint/style/noNonNullAssertion: enabled guard ensures selectedConnectionId is defined
				id: selectedConnectionId!,
				organizationId: project.organizationId ?? null,
				query: pageSearch,
			});
			return result.pages;
		},
	});

	const bindMutation = useMutation({
		mutationFn: async (params: {
			notionPageId: string;
			notionTitle: string;
			notionUrl: string;
		}) =>
			orpcClient.projects.prdSource.bindNotionPage({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
				// biome-ignore lint/style/noNonNullAssertion: mutation is only called when selectedConnectionId is defined
				connectionId: selectedConnectionId!,
				notionPageId: params.notionPageId,
				notionTitle: params.notionTitle,
				notionUrl: params.notionUrl,
			}),
		onSuccess: () => {
			toast.success("Project PRD source updated");
			void queryClient.invalidateQueries({
				queryKey: ["prd-source-status", project.id],
			});
			void queryClient.invalidateQueries({
				queryKey: ["project-contexts", project.id],
			});
			setShowBrowser(false);
			setShowChangeSource(false);
		},
		onError: (error: Error & { data?: unknown }) => {
			toast.error(
				error.message ||
					(error.data as { message?: string } | undefined)?.message ||
					"Failed to set the project PRD source",
			);
		},
	});

	const [showChangeSource, setShowChangeSource] = useState(false);

	const selectedConnection = notionConnections?.find(
		(connection) => connection.id === selectedConnectionId,
	);
	// Use live prdStatus for display (props don't update after binding)
	const activeResourceUrl = prdStatus?.sourceUrl ?? project.prdSourceUrl;
	const activeSourceTitle = prdStatus?.sourceTitle ?? project.prdSourceTitle;
	const currentResourceId = prdStatus?.resourceId ?? null;
	const currentNotionPageId = prdStatus?.notionPageId ?? null;
	const showPicker = !prdStatus?.hasSource || showChangeSource;

	const syncMutation = useMutation({
		mutationFn: async (params: {
			connectionId: string;
			resourceId: string;
		}) =>
			orpcClient.projects.prdSource.sync({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
				connectionId: params.connectionId,
				resourceId: params.resourceId,
			}),
		onSuccess: () => {
			toast.success("Project PRD source updated");
			void queryClient.invalidateQueries({
				queryKey: ["prd-source-status", project.id],
			});
			void queryClient.invalidateQueries({
				queryKey: ["project-contexts", project.id],
			});
		},
		onError: (error: Error & { data?: unknown }) => {
			toast.error(
				error.message ||
					(error.data as { message?: string } | undefined)?.message ||
					"Failed to set the project PRD source",
			);
		},
	});

	const clearMutation = useMutation({
		mutationFn: async () =>
			orpcClient.projects.prdSource.clear({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
			}),
		onSuccess: () => {
			toast.success("Project PRD source cleared");
			void queryClient.invalidateQueries({
				queryKey: ["prd-source-status", project.id],
			});
			void queryClient.invalidateQueries({
				queryKey: ["project-contexts", project.id],
			});
		},
		onError: (error: Error & { data?: unknown }) => {
			toast.error(
				error.message ||
					(error.data as { message?: string } | undefined)?.message ||
					"Failed to clear the project PRD source",
			);
		},
	});

	const lastSyncedText = prdStatus?.syncedAt
		? `Synced ${formatDistanceToNow(new Date(prdStatus.syncedAt), { addSuffix: true })}`
		: null;

	const resources = useMemo(
		() =>
			(notionResources || []).map((resource) => ({
				...resource,
				url: getResourceUrl(resource.metadata),
			})),
		[notionResources],
	);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<FileTextIcon className="w-5 h-5" />
					External PRD Source
				</CardTitle>
				<CardDescription>
					Pick a synced Notion page to act as the working PRD for this
					project. Fabric will use that indexed content directly in
					the pipeline and project context.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{prdStatus?.hasSource && activeSourceTitle && (
					<div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950/30">
						<div className="flex items-start justify-between gap-4">
							<div className="flex items-start gap-3">
								<CheckCircle2Icon className="mt-0.5 w-5 h-5 text-success" />
								<div>
									<p className="font-medium text-green-700 dark:text-green-300">
										Project PRD source connected
									</p>
									<p className="mt-1 text-sm text-success dark:text-green-400">
										{activeSourceTitle}
									</p>
									<div className="mt-2 flex items-center gap-3">
										{activeResourceUrl && (
											<a
												href={activeResourceUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="inline-flex items-center gap-1 text-xs text-success hover:underline dark:text-green-400"
											>
												<ExternalLinkIcon className="w-3 h-3" />
												View in Notion
											</a>
										)}
										{lastSyncedText && (
											<span className="text-xs text-success dark:text-green-400">
												{lastSyncedText}
											</span>
										)}
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={() =>
														setShowChangeSource(
															(v) => !v,
														)
													}
													className="text-xs text-green-700 hover:underline dark:text-green-300"
												>
													{showChangeSource
														? "Cancel change"
														: "Change source"}
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{t("changePrdSource")}
											</TooltipContent>
										</Tooltip>
									</div>
								</div>
							</div>
							<DestructiveTooltip copy={clearPrdSourceCopy}>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										clearMutation.mutate();
										setShowChangeSource(false);
									}}
									disabled={clearMutation.isPending}
									className="text-destructive hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
								>
									{clearMutation.isPending ? (
										<Loader2Icon className="w-4 h-4 animate-spin" />
									) : (
										<XCircleIcon className="w-4 h-4" />
									)}
									<span className="ml-1">Clear</span>
								</Button>
							</DestructiveTooltip>
						</div>
					</div>
				)}

				{showPicker && connectionsLoading ? (
					<div className="flex items-center justify-center py-8 text-muted-foreground">
						<Loader2Icon className="w-5 h-5 animate-spin mr-2" />
						Loading Notion connections...
					</div>
				) : showPicker &&
					(!notionConnections || notionConnections.length === 0) ? (
					<div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
						<p className="text-sm font-medium text-amber-700 dark:text-amber-300">
							No synced Notion connection is available yet
						</p>
						<p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
							Connect Notion in Integrations, run a sync, then
							come back here to choose the page that should act as
							this project&apos;s PRD.
						</p>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									asChild
									className="mt-3"
								>
									<Link href={integrationsSettingsUrl}>
										<SettingsIcon className="w-4 h-4 mr-2" />
										Open Integrations
									</Link>
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("openIntegrations")}
							</TooltipContent>
						</Tooltip>
					</div>
				) : showPicker ? (
					<div className="space-y-4">
						<div className="space-y-2">
							<p className="text-sm font-medium text-muted-foreground">
								Connected Notion sources
							</p>
							<div className="flex flex-wrap gap-2">
								{(notionConnections ?? []).map((connection) => (
									<Button
										key={connection.id}
										type="button"
										size="sm"
										variant={
											connection.id ===
											selectedConnectionId
												? "default"
												: "outline"
										}
										onClick={() =>
											setSelectedConnectionId(
												connection.id,
											)
										}
									>
										{connection.name}
									</Button>
								))}
							</div>
						</div>

						{resourcesLoading ? (
							<div className="flex items-center justify-center py-6 text-muted-foreground">
								<Loader2Icon className="w-4 h-4 animate-spin mr-2" />
								Loading synced Notion pages...
							</div>
						) : resources.length === 0 ? (
							<div className="rounded-lg border border-border/60 bg-card/40 p-4">
								{!showBrowser ? (
									<>
										<p className="text-sm font-medium text-foreground">
											No synced Notion pages yet for{" "}
											{selectedConnection?.name ||
												"this connection"}
										</p>
										<p className="mt-1 text-sm text-muted-foreground">
											Run sync in Integrations first, or
											browse your Notion pages directly to
											select one now.
										</p>
										<div className="mt-3 flex flex-wrap gap-2">
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="outline"
														size="sm"
														asChild
													>
														<Link
															href={buildReturnUrl(
																`${integrationsSettingsUrlRaw}/${selectedConnectionId ?? ""}`,
															)}
														>
															<RefreshCwIcon className="w-4 h-4 mr-2" />
															Manage Sync
														</Link>
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t("manageSync")}
												</TooltipContent>
											</Tooltip>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="outline"
														size="sm"
														onClick={() =>
															setShowBrowser(true)
														}
													>
														<SearchIcon className="w-4 h-4 mr-2" />
														Browse Notion pages
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t("browseNotionPages")}
												</TooltipContent>
											</Tooltip>
										</div>
									</>
								) : (
									<div className="space-y-3">
										<div className="flex items-center justify-between">
											<p className="text-sm font-medium text-foreground">
												Browse Notion pages
											</p>
											<button
												type="button"
												onClick={() =>
													setShowBrowser(false)
												}
												className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
											>
												Cancel
											</button>
										</div>
										<div className="relative">
											<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
											<SearchInput
												placeholder="Search pages..."
												value={pageSearch}
												onChange={(e) =>
													setPageSearch(
														e.target.value,
													)
												}
												className="pl-9"
											/>
										</div>
										{pagesLoading ? (
											<div className="flex items-center justify-center py-6 text-muted-foreground">
												<Loader2Icon className="w-4 h-4 animate-spin mr-2" />
												Loading Notion pages...
											</div>
										) : !notionPages ||
											notionPages.length === 0 ? (
											<p className="py-4 text-center text-sm text-muted-foreground">
												{pageSearch
													? "No pages match your search."
													: "No pages found in this Notion workspace."}
											</p>
										) : (
											<div className="space-y-2 max-h-72 overflow-y-auto">
												{notionPages.map((page) => {
													const isBinding =
														bindMutation.isPending &&
														bindMutation.variables
															?.notionPageId ===
															page.id;
													const isCurrent =
														page.id ===
														currentNotionPageId;

													return (
														<div
															key={page.id}
															className="flex items-center justify-between rounded-lg border border-border/60 p-3"
														>
															<div className="min-w-0 flex items-start gap-2">
																{page.icon && (
																	<span className="text-base leading-tight shrink-0">
																		{
																			page.icon
																		}
																	</span>
																)}
																<div className="min-w-0">
																	<p className="font-medium text-foreground text-sm truncate">
																		{
																			page.title
																		}
																	</p>
																	<p className="mt-0.5 text-xs text-muted-foreground">
																		{formatDistanceToNow(
																			new Date(
																				page.lastEdited,
																			),
																			{
																				addSuffix: true,
																			},
																		)}
																	</p>
																</div>
															</div>
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<Button
																		variant={
																			isCurrent
																				? "outline"
																				: "default"
																		}
																		size="sm"
																		disabled={
																			isBinding ||
																			bindMutation.isPending
																		}
																		onClick={() =>
																			bindMutation.mutate(
																				{
																					notionPageId:
																						page.id,
																					notionTitle:
																						page.title,
																					notionUrl:
																						page.url ??
																						"",
																				},
																			)
																		}
																		className="ml-3 shrink-0"
																	>
																		{isBinding ? (
																			<Loader2Icon className="w-4 h-4 animate-spin" />
																		) : isCurrent ? (
																			"Current PRD"
																		) : (
																			"Use as PRD"
																		)}
																	</Button>
																</TooltipTrigger>
																<TooltipContent>
																	{t(
																		"useNotionPageAsPrd",
																	)}
																</TooltipContent>
															</Tooltip>
														</div>
													);
												})}
											</div>
										)}
									</div>
								)}
							</div>
						) : (
							<div className="space-y-3">
								<p className="text-sm font-medium text-muted-foreground">
									Choose the synced Notion page that should
									drive this project
								</p>
								{resources.map((resource) => {
									const isActive =
										resource.id === currentResourceId;
									const isSaving =
										syncMutation.isPending &&
										syncMutation.variables?.resourceId ===
											resource.id;

									return (
										<div
											key={resource.id}
											className="flex items-center justify-between rounded-lg border border-border/60 p-3"
										>
											<div className="min-w-0">
												<p className="font-medium text-foreground truncate">
													{resource.title}
												</p>
												<p className="mt-1 text-xs text-muted-foreground">
													Last indexed{" "}
													{formatDistanceToNow(
														new Date(
															resource.updatedAt,
														),
														{ addSuffix: true },
													)}
												</p>
												{resource.url && (
													<a
														href={resource.url}
														target="_blank"
														rel="noopener noreferrer"
														className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
													>
														<ExternalLinkIcon className="w-3 h-3" />
														View in Notion
													</a>
												)}
											</div>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant={
															isActive
																? "outline"
																: "default"
														}
														size="sm"
														disabled={isSaving}
														onClick={() =>
															syncMutation.mutate(
																{
																	connectionId:
																		// biome-ignore lint/style/noNonNullAssertion: button only active when selectedConnectionId is defined
																		selectedConnectionId!,
																	resourceId:
																		resource.id,
																},
															)
														}
													>
														{isSaving ? (
															<Loader2Icon className="w-4 h-4 animate-spin" />
														) : isActive ? (
															"Current PRD"
														) : (
															"Use as PRD"
														)}
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t("useResourceAsPrd")}
												</TooltipContent>
											</Tooltip>
										</div>
									);
								})}
							</div>
						)}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
