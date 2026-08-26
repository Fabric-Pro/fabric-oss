"use client";

import {
	useContextPath,
	useEffectiveOrganizationId,
} from "@saas/organizations/hooks";
import {
	analyzePMToolCapabilities,
	fetchContainersWithHierarchy,
	type McpTool,
} from "@saas/projects/lib/pm-tool-analyzer";
import {
	findMatchingMcpConfigs,
	getMcpConfigDisplayName,
	type McpConfigForDisplay,
} from "@saas/reports/lib/mcp-utils";
import {
	DATA_SOURCE_PROVIDERS,
	type DataSourceDefinition,
	PROVIDER_CONTEXT_FIELDS,
} from "@saas/shared/components/DataSourceDefinitionBuilder";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	FolderOpenIcon,
	Loader2Icon,
	PlusIcon,
	ServerIcon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

// Template definition containing data sources
type TemplateDefinition = {
	dataSources?: DataSourceDefinition[];
	userPrompt?: string;
	// Other fields like aiAgents, sections, etc.
};

type TemplateRequirements = {
	integrations?: { key: string; name: string; required: boolean }[];
	mcpServers?: { key: string; name: string; required: boolean }[];
	workflows?: { key: string; name: string; required: boolean }[];
	agents?: { key: string; name: string; required: boolean }[];
	workspaces?: { enabled: boolean; description?: string };
};

type ReportTemplate = {
	id: string;
	name: string;
	description: string | null;
	heroEmojis?: string[];
	templateType: string;
	outputFormat: string;
	// Template definition contains data sources with operations
	definition?: TemplateDefinition;
	// Connection requirements (legacy, derived from definition)
	connections?: TemplateRequirements;
};

// Data source binding - MCP config + parameter values
type DataSourceBinding = {
	mcpConfigId: string;
	mcpConfigName: string;
	parameters: Record<string, string>;
};

type Props = {
	template: ReportTemplate;
	/**
	 * Organization ID for filtering data.
	 * - `string`: Show data for this organization
	 * - `null`: Show personal data only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
	onClose: () => void;
	onSuccess?: (instanceId: string) => void;
	basePath?: string;
};

export function CreateInstanceDialog({
	template,
	organizationId: propOrgId,
	onClose,
	onSuccess,
	basePath = "/app/report-templates",
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const _mcpServersPath = useContextPath("mcp-servers");
	const [name, setName] = useState(`My ${template.name}`);
	const [description, setDescription] = useState("");

	// Data source bindings - maps dataSource.id to MCP config + parameters
	const [dataSourceBindings, setDataSourceBindings] = useState<
		Record<string, DataSourceBinding>
	>({});
	const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);

	// Context values for AI-driven data gathering (project, team, etc.)
	const [contextValues, setContextValues] = useState<Record<string, string>>(
		{},
	);
	// Board selection state for providers that support it (e.g. fizzy)
	const [boards, setBoards] = useState<Array<{ id: string; name: string }>>(
		[],
	);
	const [isLoadingBoards, setIsLoadingBoards] = useState(false);
	const [boardsError, setBoardsError] = useState<string | null>(null);
	const [boardsMcpConfigId, setBoardsMcpConfigId] = useState<string | null>(
		null,
	);

	// Optional prompt override - pre-populated from template
	const [promptOverride, setPromptOverride] = useState("");

	// Pre-populate prompt from template on mount
	const templateUserPrompt = template.definition?.userPrompt;
	useEffect(() => {
		if (templateUserPrompt) {
			setPromptOverride(templateUserPrompt);
		}
	}, [templateUserPrompt]);

	// Get data sources from template definition
	const dataSources = (template.definition?.dataSources || []).filter(
		(ds) => ds.provider,
	);
	const requirements = template.connections || {};
	const workspacesEnabled = requirements.workspaces?.enabled ?? false;

	// Get unique providers from data sources for context fields
	const uniqueProviders = useMemo(() => {
		const providers = new Set<string>();
		for (const ds of dataSources) {
			providers.add(ds.provider);
		}
		return Array.from(providers);
	}, [dataSources]);

	// Get all context fields needed based on providers
	const requiredContextFields = useMemo(() => {
		const fields: Array<{
			key: string;
			label: string;
			placeholder: string;
			required: boolean;
			helpText: string;
			provider: string;
		}> = [];
		const seenKeys = new Set<string>();

		for (const provider of uniqueProviders) {
			const providerFields = PROVIDER_CONTEXT_FIELDS[provider] || [];
			for (const field of providerFields) {
				// Avoid duplicate keys across providers
				if (!seenKeys.has(field.key)) {
					seenKeys.add(field.key);
					fields.push({ ...field, provider });
				}
			}
		}
		return fields;
	}, [uniqueProviders]);

	// Fetch user's connected MCP configs
	const { data: mcpConfigsData } = useQuery(
		orpc.mcp.configs.list.queryOptions({
			input: { organizationId, limit: 100 },
		}),
	);

	// Fetch user's workflow integrations (OAuth + API key based)
	const { data: integrationsData } = useQuery(
		orpc.workflows.integrations.list.queryOptions({
			input: { organizationId },
		}),
	);

	// Fetch user's workspaces
	const { data: workspacesData } = useQuery(
		orpc.documentWorkspaces.list.queryOptions({
			input: { organizationId, limit: 50, status: "ACTIVE" },
		}),
	);

	const userMcpConfigs: McpConfigForDisplay[] = Array.isArray(mcpConfigsData)
		? mcpConfigsData
		: (mcpConfigsData?.configs ?? []);
	const _userIntegrations = integrationsData?.integrations ?? [];
	const userWorkspaces = workspacesData?.workspaces ?? [];

	// Check if all data sources have valid bindings
	const allDataSourcesConfigured = useMemo(() => {
		if (dataSources.length === 0) {
			return true;
		}

		// Check that each data source has an MCP config selected
		const hasMcpConfigs = dataSources.every((ds) => {
			const binding = dataSourceBindings[ds.id];
			return binding?.mcpConfigId;
		});

		if (!hasMcpConfigs) {
			return false;
		}

		// Check required context fields are filled
		const missingRequired = requiredContextFields.filter(
			(f) => f.required && !contextValues[f.key]?.trim(),
		);

		return missingRequired.length === 0;
	}, [dataSources, dataSourceBindings, requiredContextFields, contextValues]);

	const createMutation = useMutation(
		orpc.reports.instances.create.mutationOptions({
			onSuccess: (data) => {
				toast.success("Instance created successfully");
				queryClient.invalidateQueries({
					queryKey: ["reports", "instances"],
				});
				onClose();
				if (onSuccess) {
					onSuccess(data.id);
				} else {
					router.push(`${basePath}/instances/${data.id}`);
				}
			},
			onError: (error) => {
				toast.error(error.message || "Failed to create instance");
			},
		}),
	);

	const handleCreate = () => {
		if (!name.trim()) {
			toast.error("Please enter a name for the instance");
			return;
		}

		if (!allDataSourcesConfigured) {
			toast.error(
				"Please configure MCP servers and fill required context fields",
			);
			return;
		}

		// Build connections from data source bindings
		const mcpConfigs: string[] = [];
		const mcpBindings: Record<string, string> = {};

		for (const [dsId, binding] of Object.entries(dataSourceBindings)) {
			if (binding.mcpConfigId) {
				if (!mcpConfigs.includes(binding.mcpConfigId)) {
					mcpConfigs.push(binding.mcpConfigId);
				}
				mcpBindings[dsId] = binding.mcpConfigId;
				// Also key by provider so the binding is found by provider too —
				// matches CreateInstanceForm and the runtime MCP handler, which look
				// up `mcpBindings[dataSource.provider]`. Keeps create paths
				// consistent and avoids ds-id-vs-provider key drift.
				const ds = dataSources.find((d) => d.id === dsId);
				if (ds?.provider && ds.provider !== dsId) {
					mcpBindings[ds.provider] = binding.mcpConfigId;
				}
			}
		}

		// Filter out empty context values
		const filteredContext: Record<string, string> = {};
		for (const [key, value] of Object.entries(contextValues)) {
			if (value?.trim()) {
				filteredContext[key] = value.trim();
			}
		}

		createMutation.mutate({
			templateId: template.id,
			name: name.trim(),
			description: description.trim() || undefined,
			organizationId,
			connections: {
				mcpConfigs,
				mcpBindings,
				context: filteredContext, // Human-readable context for AI
				promptOverride: promptOverride.trim() || undefined,
				workflows: [],
				agents: [],
				workspaces: selectedWorkspaces,
				integrations: [],
				integrationBindings: {},
			},
		});
	};

	const emoji = template.heroEmojis?.[0] || "📊";

	// Providers that support dynamic board/container selection
	const BOARD_SELECTABLE_PROVIDERS = useMemo(() => new Set(["fizzy"]), []);
	const isBoardSelectableProvider = useCallback(
		(provider: string) => BOARD_SELECTABLE_PROVIDERS.has(provider),
		[BOARD_SELECTABLE_PROVIDERS],
	);

	// Fetch boards/containers and identity from an MCP server
	const fetchBoards = useCallback(
		async (mcpConfigId: string) => {
			setIsLoadingBoards(true);
			setBoardsError(null);
			setBoards([]);
			setBoardsMcpConfigId(mcpConfigId);
			try {
				const { tools: toolsList } = await orpcClient.mcp.tools.list({
					serverIds: [mcpConfigId],
					organizationId: organizationId ?? null,
				});
				if (!toolsList || toolsList.length === 0) {
					setBoardsError("No tools available from this MCP server");
					return;
				}
				const tools: McpTool[] = toolsList.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema as McpTool["inputSchema"],
					parameters: t.parameters,
				}));

				// Auto-fill account slug by calling identity tool (e.g. fizzy_get_identity)
				const identityToolName = toolsList.find((t) => {
					const lower = t.name.toLowerCase();
					return (
						lower.endsWith("_get_identity") ||
						lower.endsWith("_whoami")
					);
				})?.name;

				if (identityToolName) {
					try {
						const identityRes = await fetch(
							"/api/pipeline/mcp-tool",
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									mcpConfigId,
									toolName: identityToolName,
									params: {},
									organizationId: organizationId ?? undefined,
								}),
							},
						);
						const identityData = await identityRes.json();
						if (identityRes.ok && !identityData.error) {
							const result = identityData.result;
							// fizzy_get_identity returns { accounts: [{ slug, name }] }
							const accounts = Array.isArray(result?.accounts)
								? result.accounts
								: Array.isArray(result)
									? result
									: [];
							if (accounts.length > 0) {
								const account = accounts[0];
								const slug = (
									account.slug ||
									account.id ||
									""
								).replace(/^\/+/, "");
								if (slug) {
									setContextValues((prev) => ({
										...prev,
										accountSlug: prev.accountSlug || slug,
									}));
								}
							}
						}
					} catch {
						// Identity fetch is best-effort, don't block board loading
					}
				}

				const capabilities = analyzePMToolCapabilities(tools);
				if (
					!capabilities.hasPMCapabilities ||
					capabilities.containerHierarchy.length === 0
				) {
					return;
				}
				const { containers, additionalContext } =
					await fetchContainersWithHierarchy(
						mcpConfigId,
						capabilities.containerHierarchy,
						organizationId ?? undefined,
					);
				setBoards(containers);

				// Also try to fill accountSlug from hierarchy context
				// (e.g. if accounts were an intermediate level)
				const slugFromContext = (
					additionalContext.account_slug ||
					additionalContext.accountSlug ||
					additionalContext.slug ||
					""
				).replace(/^\/+/, "");
				if (slugFromContext) {
					setContextValues((prev) => ({
						...prev,
						accountSlug: prev.accountSlug || slugFromContext,
					}));
				}
			} catch (err) {
				setBoardsError(
					err instanceof Error
						? err.message
						: "Failed to load boards",
				);
			} finally {
				setIsLoadingBoards(false);
			}
		},
		[organizationId],
	);

	// Handle MCP config selection for a data source
	const handleMcpConfigChange = (dataSourceId: string, configId: string) => {
		const config = userMcpConfigs.find((c) => c.id === configId);

		setDataSourceBindings((prev) => ({
			...prev,
			[dataSourceId]: {
				mcpConfigId: configId,
				mcpConfigName: config
					? getMcpConfigDisplayName(config)
					: configId,
				parameters: prev[dataSourceId]?.parameters || {},
			},
		}));

		// Fetch boards when a board-selectable provider's MCP config is selected
		const ds = dataSources.find((d) => d.id === dataSourceId);
		if (
			ds &&
			isBoardSelectableProvider(ds.provider) &&
			configId !== boardsMcpConfigId
		) {
			fetchBoards(configId);
		}
	};

	return (
		<Dialog open onOpenChange={onClose}>
			<DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<span className="text-xl">{emoji}</span>
						Use Template: {template.name}
					</DialogTitle>
					<DialogDescription>
						Configure your data sources with connection and
						parameters for this report instance.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-6 py-4">
					{/* Instance Name */}
					<div className="space-y-2">
						<Label htmlFor="instance-name">Instance Name *</Label>
						<Input
							id="instance-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g., My Weekly Sprint Report"
						/>
						<p className="text-xs text-muted-foreground">
							Give this instance a name to identify it in your
							reports list
						</p>
					</div>

					{/* Description */}
					<div className="space-y-2">
						<Label htmlFor="instance-description">
							Description
						</Label>
						<Textarea
							id="instance-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Optional description..."
							rows={2}
						/>
					</div>

					{/* Data Source Configuration */}
					{dataSources.length > 0 && (
						<div className="space-y-4">
							<div>
								<h3 className="font-medium flex items-center gap-2">
									<SettingsIcon className="h-4 w-4" />
									Data Source Configuration
								</h3>
								<p className="text-sm text-muted-foreground">
									Select your MCP server and configure
									parameters for each data source.
								</p>
							</div>

							<div className="space-y-3">
								{dataSources.map((ds) => {
									const provider =
										DATA_SOURCE_PROVIDERS[ds.provider];
									const binding = dataSourceBindings[ds.id];
									const isConfigured = !!binding?.mcpConfigId;
									const matchingConfigs =
										findMatchingMcpConfigs(
											userMcpConfigs,
											ds.provider,
										);

									return (
										<Card
											key={ds.id}
											className={cn(
												"border transition-all",
												isConfigured
													? "border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20"
													: "border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20",
											)}
										>
											<CardContent className="p-4">
												{/* Header */}
												<div className="flex items-center gap-3">
													<div className="p-2 rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-400">
														<ServerIcon className="h-4 w-4" />
													</div>

													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2">
															<span className="font-medium text-sm">
																{provider?.label ||
																	ds.provider}
															</span>
															{isConfigured ? (
																<CheckCircle2Icon className="h-4 w-4 text-success" />
															) : (
																<AlertCircleIcon className="h-4 w-4 text-highlight" />
															)}
														</div>
														<p className="text-xs text-muted-foreground">
															AI will use
															read-only tools to
															gather data
														</p>
													</div>
												</div>

												{/* MCP Config Selector */}
												<div className="mt-3">
													<Label className="text-xs text-muted-foreground">
														MCP Server *
													</Label>
													{userMcpConfigs.length >
													0 ? (
														<Select
															value={
																binding?.mcpConfigId ||
																""
															}
															onValueChange={(
																value,
															) =>
																handleMcpConfigChange(
																	ds.id,
																	value,
																)
															}
														>
															<SelectTrigger className="mt-1">
																<SelectValue placeholder="Select MCP server..." />
															</SelectTrigger>
															<SelectContent>
																{/* Show matching configs first (recommended) */}
																{matchingConfigs.map(
																	(
																		config,
																	) => (
																		<SelectItem
																			key={
																				config.id
																			}
																			value={
																				config.id
																			}
																		>
																			{getMcpConfigDisplayName(
																				config,
																			)}{" "}
																			(Recommended)
																		</SelectItem>
																	),
																)}
																{/* Show other configs */}
																{userMcpConfigs
																	.filter(
																		(c) =>
																			!matchingConfigs.some(
																				(
																					m,
																				) =>
																					m.id ===
																					c.id,
																			),
																	)
																	.map(
																		(
																			config,
																		) => (
																			<SelectItem
																				key={
																					config.id
																				}
																				value={
																					config.id
																				}
																			>
																				{getMcpConfigDisplayName(
																					config,
																				)}
																			</SelectItem>
																		),
																	)}
															</SelectContent>
														</Select>
													) : (
														<div className="mt-1 p-3 border border-dashed rounded-lg text-center">
															<p className="text-sm text-muted-foreground">
																No MCP servers
																configured
															</p>
															<Button
																variant="outline"
																size="sm"
																className="mt-2"
																asChild
															>
																<Link
																	href={`/app/mcp-servers?connect=${ds.provider}`}
																>
																	<ServerIcon className="mr-1 h-3 w-3" />
																	Connect MCP
																	Server
																</Link>
															</Button>
														</div>
													)}
												</div>
											</CardContent>
										</Card>
									);
								})}
							</div>
						</div>
					)}

					{/* Context Fields - Human-readable values for AI */}
					{requiredContextFields.length > 0 && (
						<div className="space-y-4">
							<div>
								<h3 className="font-medium flex items-center gap-2">
									<SettingsIcon className="h-4 w-4" />
									Report Context
								</h3>
								<p className="text-sm text-muted-foreground">
									Provide context for the AI to find the right
									data.
								</p>
							</div>

							<div className="grid grid-cols-2 gap-4">
								{requiredContextFields.map((field) => {
									// Auto-filled accountSlug for board-selectable providers
									if (
										field.key === "accountSlug" &&
										isBoardSelectableProvider(
											field.provider,
										) &&
										boardsMcpConfigId
									) {
										return (
											<div
												key={field.key}
												className="space-y-1"
											>
												<Label className="text-sm">
													{field.label}
													{field.required && (
														<span className="text-destructive">
															{" "}
															*
														</span>
													)}
												</Label>
												<div className="flex items-center gap-2">
													<Input
														value={
															contextValues.accountSlug ||
															""
														}
														onChange={(e) =>
															setContextValues(
																(prev) => ({
																	...prev,
																	accountSlug:
																		e.target
																			.value,
																}),
															)
														}
														placeholder={
															isLoadingBoards
																? "Detecting..."
																: field.placeholder
														}
														disabled={
															isLoadingBoards
														}
													/>
													{contextValues.accountSlug &&
														!isLoadingBoards && (
															<CheckCircle2Icon className="h-4 w-4 text-success shrink-0" />
														)}
												</div>
												<p className="text-[10px] text-muted-foreground">
													{contextValues.accountSlug
														? "Auto-detected from your MCP server"
														: field.helpText}
												</p>
											</div>
										);
									}

									// For boardId/boardName with a board-selectable provider, show dropdown
									if (
										(field.key === "boardId" ||
											field.key === "boardName") &&
										isBoardSelectableProvider(
											field.provider,
										)
									) {
										// Only render dropdown once (for boardId), skip boardName
										if (field.key === "boardName") {
											return null;
										}

										return (
											<div
												key="board-selector"
												className="col-span-2 space-y-1"
											>
												<Label className="text-sm">
													Board
												</Label>
												{isLoadingBoards ? (
													<div className="flex items-center gap-2 text-sm text-muted-foreground p-2">
														<Loader2Icon className="h-4 w-4 animate-spin" />
														Loading boards...
													</div>
												) : boards.length > 0 ? (
													<Select
														value={
															contextValues.boardId ||
															""
														}
														onValueChange={(
															value,
														) => {
															const board =
																boards.find(
																	(b) =>
																		b.id ===
																		value,
																);
															setContextValues(
																(prev) => ({
																	...prev,
																	boardId:
																		value,
																	boardName:
																		board?.name ||
																		"",
																}),
															);
														}}
													>
														<SelectTrigger>
															<SelectValue placeholder="Select a board..." />
														</SelectTrigger>
														<SelectContent>
															{boards.map(
																(board) => (
																	<SelectItem
																		key={
																			board.id
																		}
																		value={
																			board.id
																		}
																	>
																		{
																			board.name
																		}
																	</SelectItem>
																),
															)}
														</SelectContent>
													</Select>
												) : boardsError ? (
													<>
														<Input
															value={
																contextValues.boardId ||
																""
															}
															onChange={(e) =>
																setContextValues(
																	(prev) => ({
																		...prev,
																		boardId:
																			e
																				.target
																				.value,
																	}),
																)
															}
															placeholder="12345"
														/>
														<p className="text-[10px] text-amber-600">
															{boardsError}
														</p>
													</>
												) : boardsMcpConfigId ? (
													<p className="text-[10px] text-muted-foreground">
														No boards found from
														this server.
													</p>
												) : (
													<Input
														disabled
														placeholder="Select an MCP server first..."
													/>
												)}
											</div>
										);
									}

									// Default: render as text input
									return (
										<div
											key={field.key}
											className="space-y-1"
										>
											<Label className="text-sm">
												{field.label}
												{field.required && (
													<span className="text-destructive">
														{" "}
														*
													</span>
												)}
											</Label>
											<Input
												value={
													contextValues[field.key] ||
													""
												}
												onChange={(e) =>
													setContextValues(
														(prev) => ({
															...prev,
															[field.key]:
																e.target.value,
														}),
													)
												}
												placeholder={field.placeholder}
											/>
											<p className="text-[10px] text-muted-foreground">
												{field.helpText}
											</p>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* Prompt Override */}
					{dataSources.length > 0 && (
						<div className="space-y-2">
							<Label className="text-sm">
								Custom Instructions (Optional)
							</Label>
							<Textarea
								value={promptOverride}
								onChange={(e) =>
									setPromptOverride(e.target.value)
								}
								placeholder="Add specific instructions to customize how data is gathered..."
								rows={2}
							/>
							<p className="text-xs text-muted-foreground">
								Override or add to the default data gathering
								instructions
							</p>
						</div>
					)}

					{/* Optional: Workspaces for RAG context */}
					{workspacesEnabled && userWorkspaces.length > 0 && (
						<div className="space-y-3">
							<div>
								<h3 className="font-medium flex items-center gap-2">
									<FolderOpenIcon className="h-4 w-4" />
									Document Workspaces
								</h3>
								<p className="text-sm text-muted-foreground">
									{requirements.workspaces?.description ||
										"Optionally select workspaces to provide additional context via RAG."}
								</p>
							</div>

							<Select
								value={selectedWorkspaces[0] || ""}
								onValueChange={(value) =>
									setSelectedWorkspaces(value ? [value] : [])
								}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a workspace (optional)..." />
								</SelectTrigger>
								<SelectContent>
									{userWorkspaces.map((ws) => (
										<SelectItem key={ws.id} value={ws.id}>
											{ws.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* No data sources message */}
					{dataSources.length === 0 && !workspacesEnabled && (
						<div className="text-center py-4 text-muted-foreground">
							<p>
								This template doesn't require any data source
								configuration.
							</p>
							<p className="text-sm">
								You can create your instance right away.
							</p>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={handleCreate}
						disabled={
							createMutation.isPending ||
							!allDataSourcesConfigured
						}
					>
						{createMutation.isPending ? (
							<>
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
								Creating...
							</>
						) : (
							<>
								<PlusIcon className="mr-2 h-4 w-4" />
								Create Instance
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
