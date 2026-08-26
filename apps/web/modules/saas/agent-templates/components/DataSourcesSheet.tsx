"use client";

/**
 * Data Sources Sheet
 * Side drawer for connecting and managing data sources (knowledge)
 * Uses actual integration icons from plugins
 */

import { DatabricksIndexPicker } from "@saas/workflows/components/integrations/DatabricksIndexPicker";
import { IntegrationBrandIcon } from "@saas/workflows/components/integrations/IntegrationBrandIcon";
import {
	getAllIntegrations,
	getIntegration,
	getKnowledgeIntegrationTypes,
	type IntegrationFormField,
	type IntegrationType,
} from "@saas/workflows/lib/plugins";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ScrollArea } from "@ui/components/scroll-area";
import { SearchInput } from "@ui/components/search-input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	CloudIcon,
	DatabaseIcon,
	EyeIcon,
	EyeOffIcon,
	Loader2Icon,
	SearchIcon,
	SettingsIcon,
	XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Organization ID for tenant isolation.
	 * - `string`: Organization context
	 * - `null`: Personal context (explicit)
	 * - `undefined`: Falls back to null (personal context)
	 */
	organizationId?: string | null;
	selectedSourceIds: string[];
	onSelectionChange: (ids: string[]) => void;
	/**
	 * Per-provider resource scoping for knowledge connections that need it
	 * (currently Databricks Vector Search): the Unity Catalog schema and
	 * the vector indexes selected within it.
	 */
	knowledgeResources: Record<string, { schema: string; indexes: string[] }>;
	onKnowledgeResourcesChange: (
		next: Record<string, { schema: string; indexes: string[] }>,
	) => void;
	/**
	 * When set (edit/duplicate flows), pins Databricks Vector Search index
	 * discovery to this exact WorkflowIntegration id instead of the org-wide
	 * "first active Databricks connection" lookup — so re-running discovery
	 * can't silently resolve to a different connection than what's bound to
	 * the agent.
	 */
	databricksIntegrationId?: string;
};

export function DataSourcesSheet({
	open,
	onOpenChange,
	organizationId,
	selectedSourceIds,
	onSelectionChange,
	knowledgeResources,
	onKnowledgeResourcesChange,
	databricksIntegrationId,
}: Props) {
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [configuring, setConfiguring] = useState<IntegrationType | null>(
		null,
	);
	const [credentials, setCredentials] = useState<Record<string, string>>({});
	const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>(
		{},
	);

	// Get all integration plugins
	const allIntegrations = useMemo(() => getAllIntegrations(), []);

	// Get knowledge source plugins
	const knowledgePlugins = useMemo(() => {
		return getKnowledgeIntegrationTypes()
			.map((type) => allIntegrations.find((p) => p.type === type))
			.filter(Boolean);
	}, [allIntegrations]);

	// Normalize organizationId: undefined -> null for explicit personal context
	const effectiveOrgId = organizationId ?? null;

	// Fetch configured integrations (API key based)
	// staleTime: 0 ensures fresh data — status may change via settings page
	const { data: integrationsData } = useQuery({
		queryKey: ["workflow-integrations", effectiveOrgId],
		queryFn: async () => {
			return await orpcClient.workflows.integrations.list({
				organizationId: effectiveOrgId,
			});
		},
		staleTime: 0,
	});

	const configuredIntegrations = integrationsData?.integrations ?? [];

	// OAuth providers need separate status checks
	// IMPORTANT: Keep in sync with OAUTH_PROVIDERS in validate-connections.ts
	const oauthProviders = [
		"GITHUB",
		"GOOGLE_DRIVE",
		"MICROSOFT_GRAPH",
		"SLACK",
		"NOTION",
	] as const;

	// Fetch OAuth status for all OAuth providers
	const { data: oauthStatuses } = useQuery({
		queryKey: ["oauth-statuses", effectiveOrgId],
		queryFn: async () => {
			const statuses: Record<string, boolean> = {};
			await Promise.all(
				oauthProviders.map(async (provider) => {
					try {
						const result =
							await orpcClient.integrations.oauth.status({
								provider,
								organizationId: effectiveOrgId,
							});
						statuses[provider] = result.connected;
					} catch {
						statuses[provider] = false;
					}
				}),
			);
			return statuses;
		},
	});

	// Check if a source is configured (API key or OAuth)
	const isSourceConfigured = (type: IntegrationType): boolean => {
		// Check OAuth status for OAuth providers
		if (oauthProviders.includes(type as (typeof oauthProviders)[number])) {
			return oauthStatuses?.[type] ?? false;
		}
		// Check workflow integrations for API key based providers
		return configuredIntegrations.some(
			(i) => i.provider === type && i.hasCredentials,
		);
	};

	// Databricks Vector Search: once connected, discover the available
	// Unity Catalog schemas + indexes so the user can scope this agent to
	// specific ones (persisted separately as knowledgeResources).
	//
	// The discovery call is authorized at the tenant level (org-shared), not
	// the owner level, so it can return isConnected: true even when the
	// creator-only integration list (`isSourceConfigured`) doesn't know about
	// it — e.g. an org member who didn't personally save the credentials.
	// Run it whenever the sheet is open (it's cheap: { isConnected: false }
	// when nothing is connected) rather than gating on the creator-only
	// signal, so org-shared connections are still discovered.
	const { data: databricksIndexData } = useQuery({
		queryKey: [
			"databricks-vector-indexes",
			effectiveOrgId,
			databricksIntegrationId ?? null,
		],
		queryFn: async () =>
			await orpcClient.workflows.integrations.listDatabricksIndexes({
				organizationId: effectiveOrgId,
				integrationId: databricksIntegrationId,
			}),
		enabled: open,
		staleTime: 5 * 60 * 1000,
	});
	const databricksConfigured =
		isSourceConfigured("DATABRICKS_VECTOR_SEARCH") ||
		databricksIndexData?.isConnected === true;

	// Wraps isSourceConfigured, folding in the org-shared discovery signal for
	// Databricks specifically. All other providers are unaffected.
	const isSourceAvailable = (type: IntegrationType): boolean =>
		type === "DATABRICKS_VECTOR_SEARCH"
			? databricksConfigured
			: isSourceConfigured(type);

	const databricksSelection = knowledgeResources.DATABRICKS_VECTOR_SEARCH;
	const setDatabricksSelection = (
		next: { schema: string; indexes: string[] } | undefined,
	) => {
		const copy = { ...knowledgeResources };
		if (next) {
			copy.DATABRICKS_VECTOR_SEARCH = next;
		} else {
			delete copy.DATABRICKS_VECTOR_SEARCH;
		}
		onKnowledgeResourcesChange(copy);
	};

	// Save integration mutation
	const saveMutation = useMutation({
		mutationFn: async ({
			type,
			creds,
		}: {
			type: IntegrationType;
			creds: Record<string, string>;
		}) => {
			return await orpcClient.workflows.integrations.save({
				type,
				credentials: creds,
				organizationId: effectiveOrgId,
			});
		},
		onSuccess: () => {
			toast.success("Data source connected successfully!");
			queryClient.invalidateQueries({
				queryKey: ["workflow-integrations"],
			});
			if (configuring === "DATABRICKS_VECTOR_SEARCH") {
				// A pre-connection open caches { isConnected: false } for 5
				// minutes; refetch so the schema/index picker appears now.
				queryClient.invalidateQueries({
					queryKey: ["databricks-vector-indexes"],
				});
			}
			if (configuring) {
				// Auto-add the source after successful configuration
				if (!selectedSourceIds.includes(configuring)) {
					onSelectionChange([...selectedSourceIds, configuring]);
				}
			}
			setConfiguring(null);
			setCredentials({});
		},
		onError: (error) => {
			toast.error(error.message || "Failed to connect data source");
		},
	});

	// Test connection mutation
	const testMutation = useMutation({
		mutationFn: async ({
			type,
			creds,
		}: {
			type: IntegrationType;
			creds: Record<string, string>;
		}) => {
			return await orpcClient.workflows.integrations.testConnection({
				type,
				credentials: creds,
			});
		},
	});

	const handleAddSource = (type: IntegrationType) => {
		// If source isn't configured, show config form
		if (!isSourceAvailable(type)) {
			setConfiguring(type);
			setCredentials({});
			return;
		}

		// Toggle source selection
		if (selectedSourceIds.includes(type)) {
			onSelectionChange(selectedSourceIds.filter((id) => id !== type));
		} else {
			onSelectionChange([...selectedSourceIds, type]);
		}
	};

	const handleSaveConfig = () => {
		if (!configuring) {
			return;
		}
		saveMutation.mutate({ type: configuring, creds: credentials });
	};

	const handleTestConfig = async () => {
		if (!configuring) {
			return;
		}
		const result = await testMutation.mutateAsync({
			type: configuring,
			creds: credentials,
		});
		if (result.success) {
			toast.success(result.message || "Connection successful!");
		} else {
			toast.error(result.error || "Connection failed");
		}
	};

	// Filter sources by search
	const filteredPlugins = knowledgePlugins.filter((plugin) => {
		if (!plugin) {
			return false;
		}
		return (
			plugin.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
			plugin.description.toLowerCase().includes(searchQuery.toLowerCase())
		);
	});

	// Separate connected vs available
	const connectedPlugins = filteredPlugins.filter(
		(p) => p && isSourceAvailable(p.type),
	);
	const availablePlugins = filteredPlugins.filter(
		(p) => p && !isSourceAvailable(p.type),
	);

	const configuringPlugin = configuring ? getIntegration(configuring) : null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full sm:max-w-xl flex flex-col p-0">
				<SheetHeader className="px-6 pt-6 pb-4 border-b">
					<SheetTitle className="text-xl">Add knowledge</SheetTitle>
					<SheetDescription>
						Connect data sources to give your agent access to your
						knowledge
					</SheetDescription>
				</SheetHeader>

				{/* Search */}
				<div className="px-6 py-4 border-b bg-muted/30">
					<div className="relative">
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<SearchInput
							placeholder="Search data sources..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-10 bg-background"
						/>
					</div>
				</div>

				<ScrollArea className="flex-1">
					<div className="p-6">
						{/* Configuration form */}
						{configuring && configuringPlugin && (
							<div className="mb-6 p-5 border rounded-xl bg-muted/30">
								<div className="flex items-center justify-between mb-5">
									<div className="flex items-center gap-4">
										<IntegrationBrandIcon
											icon={configuringPlugin.icon}
											label={configuringPlugin.label}
											color={configuringPlugin.color}
											brandColor={
												configuringPlugin.brandColor
											}
											size={56}
											className="rounded-xl shadow-lg"
										/>
										<div>
											<h4 className="font-semibold text-lg">
												Connect{" "}
												{configuringPlugin.label}
											</h4>
											<p className="text-sm text-muted-foreground">
												{configuringPlugin.description}
											</p>
										</div>
									</div>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => setConfiguring(null)}
									>
										<XIcon className="h-4 w-4" />
									</Button>
								</div>

								<div className="space-y-4">
									{/* OAuth integrations - render SettingsComponent */}
									{(configuringPlugin.SettingsComponent ||
										configuringPlugin.settingsComponent) && (
										<div className="space-y-4">
											{configuringPlugin.SettingsComponent ? (
												<configuringPlugin.SettingsComponent
													apiKey=""
													hasKey={false}
													onApiKeyChange={() => {}}
													organizationId={
														effectiveOrgId
													}
												/>
											) : configuringPlugin.settingsComponent ? (
												<configuringPlugin.settingsComponent
													apiKey=""
													hasKey={false}
													onApiKeyChange={() => {}}
													organizationId={
														effectiveOrgId
													}
												/>
											) : null}
											<p className="text-sm text-muted-foreground">
												After connecting, click "Done"
												to add this source.
											</p>
											<Button
												onClick={() => {
													if (!configuring) {
														return;
													}
													// Refresh both workflow integrations AND OAuth statuses
													queryClient.invalidateQueries(
														{
															queryKey: [
																"workflow-integrations",
															],
														},
													);
													queryClient.invalidateQueries(
														{
															queryKey: [
																"oauth-statuses",
															],
														},
													);
													if (
														!selectedSourceIds.includes(
															configuring,
														)
													) {
														onSelectionChange([
															...selectedSourceIds,
															configuring,
														]);
													}
													setConfiguring(null);
												}}
												className="bg-emerald-500 hover:bg-emerald-600"
											>
												Done
											</Button>
										</div>
									)}

									{/* API Key integrations - render form fields */}
									{!configuringPlugin.SettingsComponent &&
										!configuringPlugin.settingsComponent &&
										configuringPlugin.formFields.length >
											0 && (
											<>
												{configuringPlugin.formFields.map(
													(
														field: IntegrationFormField,
													) => (
														<div
															key={field.id}
															className="space-y-2"
														>
															<Label
																htmlFor={
																	field.id
																}
																className="text-sm font-medium"
															>
																{field.label}
																{field.required && (
																	<span className="text-destructive ml-1">
																		*
																	</span>
																)}
															</Label>
															<div className="relative">
																<Input
																	id={
																		field.id
																	}
																	type={
																		field.type ===
																			"password" &&
																		!showPasswords[
																			field
																				.id
																		]
																			? "password"
																			: "text"
																	}
																	placeholder={
																		field.placeholder
																	}
																	value={
																		credentials[
																			field
																				.configKey
																		] || ""
																	}
																	onChange={(
																		e,
																	) =>
																		setCredentials(
																			{
																				...credentials,
																				[field.configKey]:
																					e
																						.target
																						.value,
																			},
																		)
																	}
																	className="bg-background"
																/>
																{field.type ===
																	"password" && (
																	<button
																		type="button"
																		className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
																		onClick={() =>
																			setShowPasswords(
																				{
																					...showPasswords,
																					[field.id]:
																						!showPasswords[
																							field
																								.id
																						],
																				},
																			)
																		}
																	>
																		{showPasswords[
																			field
																				.id
																		] ? (
																			<EyeOffIcon className="h-4 w-4" />
																		) : (
																			<EyeIcon className="h-4 w-4" />
																		)}
																	</button>
																)}
															</div>
															{field.helpText && (
																<p className="text-xs text-muted-foreground">
																	{
																		field.helpText
																	}
																</p>
															)}
														</div>
													),
												)}

												<div className="flex gap-3 pt-3">
													<Button
														variant="outline"
														onClick={
															handleTestConfig
														}
														disabled={
															testMutation.isPending
														}
													>
														{testMutation.isPending && (
															<Loader2Icon className="h-4 w-4 animate-spin mr-2" />
														)}
														Test Connection
													</Button>
													<Button
														onClick={
															handleSaveConfig
														}
														disabled={
															saveMutation.isPending
														}
														className="bg-emerald-500 hover:bg-emerald-600"
													>
														{saveMutation.isPending && (
															<Loader2Icon className="h-4 w-4 animate-spin mr-2" />
														)}
														Connect & Add
													</Button>
												</div>
											</>
										)}
								</div>
							</div>
						)}

						{/* Data sources list */}
						{!configuring && (
							<div className="space-y-8">
								{/* Empty state */}
								{filteredPlugins.length === 0 && (
									<div className="text-center py-12">
										<CloudIcon className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
										<p className="text-muted-foreground">
											No data sources match your search
										</p>
									</div>
								)}

								{/* Connected sources */}
								{connectedPlugins.length > 0 && (
									<div>
										<h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
											Connected
										</h4>
										<div className="space-y-3">
											{connectedPlugins.map((plugin) => {
												if (!plugin) {
													return null;
												}
												const isSelected =
													selectedSourceIds.includes(
														plugin.type,
													);
												const isDatabricks =
													plugin.type ===
													"DATABRICKS_VECTOR_SEARCH";

												return (
													<div key={plugin.type}>
														<Card
															className={cn(
																"p-3 cursor-pointer hover:border-primary/50 transition-colors",
																isSelected &&
																	"border-emerald-500/50 bg-emerald-50/50 dark:bg-emerald-950/20",
																!isSelected &&
																	"border-green-500/30 bg-green-50/50 dark:bg-green-950/20",
															)}
															onClick={() =>
																handleAddSource(
																	plugin.type,
																)
															}
														>
															<div className="flex items-center gap-3">
																<IntegrationBrandIcon
																	icon={
																		plugin.icon
																	}
																	label={
																		plugin.label
																	}
																	color={
																		plugin.color
																	}
																	brandColor={
																		plugin.brandColor
																	}
																	size={40}
																/>
																<div className="flex-1 min-w-0">
																	<div className="flex items-center gap-2">
																		<p className="font-medium">
																			{
																				plugin.label
																			}
																		</p>
																		{isSelected && (
																			<CheckCircle2Icon className="h-4 w-4 text-emerald-500 shrink-0" />
																		)}
																		{!isSelected && (
																			<Badge
																				variant="outline"
																				className="text-xs text-success border-green-500/50 bg-green-50 dark:bg-green-950/50"
																			>
																				Connected
																			</Badge>
																		)}
																	</div>
																	<p className="text-sm text-muted-foreground">
																		{
																			plugin.description
																		}
																	</p>
																</div>
															</div>
														</Card>

														{isDatabricks &&
															isSelected &&
															databricksIndexData?.isConnected && (
																<div className="mt-3 rounded-md border bg-muted/50 p-3">
																	<DatabricksIndexPicker
																		schemas={
																			databricksIndexData.schemas
																		}
																		selection={
																			databricksSelection
																		}
																		onSelectionChange={
																			setDatabricksSelection
																		}
																		limitScopeLabel="per agent"
																	/>
																</div>
															)}
														{isDatabricks &&
															isSelected &&
															databricksIndexData &&
															!databricksIndexData.isConnected && (
																<p className="mt-2 text-xs text-muted-foreground">
																	{databricksIndexData.error ??
																		"Databricks Vector Search is not connected."}
																</p>
															)}
													</div>
												);
											})}
										</div>
									</div>
								)}

								{/* Available sources (not connected) */}
								{availablePlugins.length > 0 && (
									<div>
										<h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
											Available to connect
										</h4>
										<div className="space-y-3">
											{availablePlugins.map((plugin) => {
												if (!plugin) {
													return null;
												}

												return (
													<Card
														key={plugin.type}
														className="p-3 cursor-pointer hover:border-primary/50 transition-colors"
														onClick={() =>
															handleAddSource(
																plugin.type,
															)
														}
													>
														<div className="flex items-center gap-3">
															<IntegrationBrandIcon
																icon={
																	plugin.icon
																}
																label={
																	plugin.label
																}
																color={
																	plugin.color
																}
																brandColor={
																	plugin.brandColor
																}
																size={40}
															/>
															<div className="flex-1 min-w-0">
																<div className="flex items-center gap-2">
																	<p className="font-medium">
																		{
																			plugin.label
																		}
																	</p>
																</div>
																<p className="text-sm text-muted-foreground">
																	{
																		plugin.description
																	}
																</p>
																<p className="text-xs text-amber-600 dark:text-amber-400 mt-1 font-medium flex items-center gap-1">
																	<SettingsIcon className="h-3 w-3" />
																	Click to
																	configure
																</p>
															</div>
														</div>
													</Card>
												);
											})}
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				</ScrollArea>

				<SheetFooter className="border-t px-6 py-4 bg-muted/30">
					<div className="flex items-center justify-between w-full">
						<div className="flex items-center gap-2">
							<DatabaseIcon className="h-4 w-4 text-primary" />
							<span className="text-sm font-medium">
								{selectedSourceIds.length} source
								{selectedSourceIds.length !== 1 ? "s" : ""}{" "}
								selected
							</span>
						</div>
						<div className="flex gap-3">
							<Button
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button
								onClick={() => onOpenChange(false)}
								className="bg-emerald-500 hover:bg-emerald-600"
							>
								Add sources
							</Button>
						</div>
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
