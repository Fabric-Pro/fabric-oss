"use client";

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks";
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
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
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
	ArrowLeftIcon,
	CheckCircle2Icon,
	FolderOpenIcon,
	Loader2Icon,
	PlusIcon,
	ServerIcon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

// Data source binding - MCP config + parameter values
type DataSourceBinding = {
	mcpConfigId: string;
	mcpConfigName: string;
	parameters: Record<string, string>;
};

type Props = {
	templateId: string;
	organizationId?: string | null;
	basePath?: string;
};

export function CreateInstanceForm({
	templateId,
	organizationId: propOrgId,
	basePath = "/app/report-templates",
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { organizationId: contextOrgId, loaded: orgContextLoaded } =
		useOrganizationContext();
	const _mcpServersPath = useContextPath("mcp-servers");

	// Use prop if explicitly provided, otherwise fall back to context
	// IMPORTANT: Must be string | null, never undefined (undefined causes session fallback)
	const organizationId: string | null =
		propOrgId !== undefined ? propOrgId : contextOrgId;

	// Fetch template data - wait for organization context to load first
	const { data: template, isLoading: templateLoading } = useQuery({
		...orpc.reports.templates.get.queryOptions({
			input: { id: templateId, organizationId },
		}),
		// Only fetch when org context is loaded to avoid race condition
		enabled: orgContextLoaded,
	});

	const [name, setName] = useState("");
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
	// Optional prompt override - pre-populated from template
	const [promptOverride, setPromptOverride] = useState("");
	// Max iterations for agentic data gathering
	const [maxIterations, setMaxIterations] = useState<number | undefined>(
		undefined,
	);

	// Initialize form when template loads
	useEffect(() => {
		if (template) {
			setName(`My ${template.name}`);
			const userPrompt = (template.definition as any)?.userPrompt;
			if (userPrompt) {
				setPromptOverride(userPrompt);
			}
		}
	}, [template]);

	// Get data sources from template definition
	const dataSources: DataSourceDefinition[] =
		(template?.definition as any)?.dataSources || [];
	const requirements = (template as any)?.connections || {};
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
				if (!seenKeys.has(field.key)) {
					seenKeys.add(field.key);
					fields.push({ ...field, provider });
				}
			}
		}
		return fields;
	}, [uniqueProviders]);

	// Fetch user's connected MCP configs - wait for org context
	const { data: mcpConfigsData } = useQuery({
		...orpc.mcp.configs.list.queryOptions({
			input: { organizationId, limit: 100 },
		}),
		enabled: orgContextLoaded,
	});

	// Fetch user's workspaces
	const { data: workspacesData } = useQuery({
		...orpc.documentWorkspaces.list.queryOptions({
			input: { organizationId, limit: 50, status: "ACTIVE" },
		}),
		enabled: orgContextLoaded,
	});

	// MCP configs API may return array directly or { configs: [] }
	const userMcpConfigs: McpConfigForDisplay[] = Array.isArray(mcpConfigsData)
		? mcpConfigsData
		: (mcpConfigsData?.configs ?? []);
	const userWorkspaces = workspacesData?.workspaces ?? [];

	// Check if all data sources have valid bindings
	const allDataSourcesConfigured = useMemo(() => {
		if (dataSources.length === 0) {
			return true;
		}

		const hasMcpConfigs = dataSources.every((ds) => {
			const binding = dataSourceBindings[ds.id];
			return binding?.mcpConfigId;
		});

		if (!hasMcpConfigs) {
			return false;
		}

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
				router.push(`${basePath}/instances/${data.id}`);
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
		// Use provider key (e.g., "azure_devops") as the binding key, not data source ID
		const mcpConfigs: string[] = [];
		const mcpBindings: Record<string, string> = {};

		for (const [dsId, binding] of Object.entries(dataSourceBindings)) {
			if (binding.mcpConfigId) {
				if (!mcpConfigs.includes(binding.mcpConfigId)) {
					mcpConfigs.push(binding.mcpConfigId);
				}
				// Find the data source to get its provider key
				const ds = dataSources.find((d) => d.id === dsId);
				const bindingKey = ds?.provider || dsId;
				mcpBindings[bindingKey] = binding.mcpConfigId;
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
			templateId,
			name: name.trim(),
			description: description.trim() || undefined,
			organizationId,
			connections: {
				mcpConfigs,
				mcpBindings,
				context: filteredContext,
				promptOverride: promptOverride.trim() || undefined,
				maxIterations: maxIterations || undefined,
				workflows: [],
				agents: [],
				workspaces: selectedWorkspaces,
				integrations: [],
				integrationBindings: {},
			},
		});
	};

	// Find matching MCP configs for a provider (using shared utility)
	const getMatchingMcpConfigs = (provider: string) => {
		if (!provider) {
			return [];
		}
		return findMatchingMcpConfigs(userMcpConfigs, provider);
	};

	// Handle MCP config selection for a data source
	const handleMcpConfigChange = (dataSourceId: string, configId: string) => {
		const config = userMcpConfigs.find(
			(c: { id: string }) => c.id === configId,
		) as
			| {
					id: string;
					displayName?: string | null;
					commandArgs?: string[];
					mcpServer?: { key?: string; name?: string };
			  }
			| undefined;

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
	};

	if (!orgContextLoaded || templateLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!template) {
		return (
			<div className="text-center py-12">
				<p className="text-muted-foreground">Template not found</p>
				<Button asChild variant="outline" className="mt-4">
					<Link href={basePath}>
						<ArrowLeftIcon className="mr-2 h-4 w-4" />
						Back to Templates
					</Link>
				</Button>
			</div>
		);
	}

	const emoji = template.heroEmojis?.[0] || "📊";

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-4">
				<span className="text-3xl">{emoji}</span>
				<div>
					<h1 className="text-2xl font-bold">
						Create Instance: {template.name}
					</h1>
					<p className="text-muted-foreground">
						Configure your data sources and parameters for this
						report instance.
					</p>
				</div>
			</div>

			<div className="grid gap-6 lg:grid-cols-3">
				{/* Main Form */}
				<div className="lg:col-span-2 space-y-6">
					{/* Instance Name */}
					<Card>
						<CardContent className="pt-6 space-y-4">
							<div className="space-y-2">
								<Label htmlFor="instance-name">
									Instance Name *
								</Label>
								<Input
									id="instance-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="e.g., My Weekly Sprint Report"
								/>
								<p className="text-xs text-muted-foreground">
									Give this instance a name to identify it in
									your reports list
								</p>
							</div>

							<div className="space-y-2">
								<Label htmlFor="instance-description">
									Description
								</Label>
								<Textarea
									id="instance-description"
									value={description}
									onChange={(e) =>
										setDescription(e.target.value)
									}
									placeholder="Optional description..."
									rows={2}
								/>
							</div>
						</CardContent>
					</Card>

					{/* Data Source Configuration */}
					{dataSources.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
								<div>
									<h3 className="font-medium flex items-center gap-2">
										<ServerIcon className="h-4 w-4" />
										Data Source Configuration
									</h3>
									<p className="text-sm text-muted-foreground">
										Select your MCP server for each data
										source.
									</p>
								</div>

								<div className="space-y-3">
									{dataSources.map((ds) => {
										const provider =
											DATA_SOURCE_PROVIDERS[ds.provider];
										const binding =
											dataSourceBindings[ds.id];
										const isConfigured =
											!!binding?.mcpConfigId;
										const matchingConfigs =
											getMatchingMcpConfigs(ds.provider);

										return (
											<div
												key={ds.id}
												className={cn(
													"p-4 rounded-lg border transition-all",
													isConfigured
														? "border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20"
														: "border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20",
												)}
											>
												<div className="flex items-center gap-3 mb-3">
													<div className="p-2 rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-400">
														<ServerIcon className="h-4 w-4" />
													</div>
													<div className="flex-1">
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

												{userMcpConfigs.length > 0 ? (
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
														<SelectTrigger>
															<SelectValue placeholder="Select MCP server..." />
														</SelectTrigger>
														<SelectContent>
															{/* Show matching configs first (recommended) */}
															{matchingConfigs.length >
																0 &&
																matchingConfigs.map(
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
													<div className="p-3 border border-dashed rounded-lg text-center">
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
										);
									})}
								</div>
							</CardContent>
						</Card>
					)}

					{/* Context Fields */}
					{requiredContextFields.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
								<div>
									<h3 className="font-medium flex items-center gap-2">
										<SettingsIcon className="h-4 w-4" />
										Report Context
									</h3>
									<p className="text-sm text-muted-foreground">
										Provide context for the AI to find the
										right data.
									</p>
								</div>

								<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
									{requiredContextFields.map((field) => (
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
									))}
								</div>
							</CardContent>
						</Card>
					)}

					{/* Prompt Override & Advanced Settings */}
					{dataSources.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
								<div className="space-y-2">
									<Label className="text-sm">
										Custom Instructions (Optional)
									</Label>
									<Textarea
										value={promptOverride}
										onChange={(e) =>
											setPromptOverride(e.target.value)
										}
										placeholder="Add specific instructions to customize how data is gathered and analyzed..."
										rows={4}
									/>
									<p className="text-xs text-muted-foreground">
										Override or add to the default data
										gathering instructions
									</p>
								</div>

								<div className="space-y-2">
									<Label
										htmlFor="max-iterations"
										className="text-sm"
									>
										Max Iterations
									</Label>
									<Input
										id="max-iterations"
										type="number"
										min={1}
										max={50}
										value={maxIterations ?? ""}
										onChange={(e) => {
											const parsed = Number.parseInt(
												e.target.value,
												10,
											);
											setMaxIterations(
												Number.isFinite(parsed)
													? parsed
													: undefined,
											);
										}}
										placeholder="15 (default)"
										className="w-32"
									/>
									<p className="text-xs text-muted-foreground">
										Maximum number of AI reasoning
										iterations for data gathering. Each
										iteration can call multiple tools
										(1-50).
									</p>
								</div>
							</CardContent>
						</Card>
					)}

					{/* Workspaces */}
					{workspacesEnabled && userWorkspaces.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
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
										setSelectedWorkspaces(
											value ? [value] : [],
										)
									}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select a workspace (optional)..." />
									</SelectTrigger>
									<SelectContent>
										{userWorkspaces.map((ws) => (
											<SelectItem
												key={ws.id}
												value={ws.id}
											>
												{ws.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</CardContent>
						</Card>
					)}
				</div>

				{/* Sidebar */}
				<div className="space-y-4">
					<Card>
						<CardContent className="pt-6 space-y-4">
							<h3 className="font-medium">Actions</h3>
							<div className="space-y-2">
								<Button
									onClick={handleCreate}
									disabled={
										createMutation.isPending ||
										!allDataSourcesConfigured ||
										!name.trim()
									}
									className="w-full"
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
								<Button
									variant="outline"
									className="w-full"
									asChild
								>
									<Link href={`${basePath}/${templateId}`}>
										<ArrowLeftIcon className="mr-2 h-4 w-4" />
										Back to Template
									</Link>
								</Button>
							</div>
						</CardContent>
					</Card>

					{/* Status Card */}
					<Card>
						<CardContent className="pt-6 space-y-3">
							<h3 className="font-medium">
								Configuration Status
							</h3>
							<div className="space-y-2 text-sm">
								<div className="flex items-center gap-2">
									{name.trim() ? (
										<CheckCircle2Icon className="h-4 w-4 text-success" />
									) : (
										<AlertCircleIcon className="h-4 w-4 text-highlight" />
									)}
									<span>Instance name</span>
								</div>
								{dataSources.length > 0 && (
									<div className="flex items-center gap-2">
										{allDataSourcesConfigured ? (
											<CheckCircle2Icon className="h-4 w-4 text-success" />
										) : (
											<AlertCircleIcon className="h-4 w-4 text-highlight" />
										)}
										<span>Data sources configured</span>
									</div>
								)}
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
