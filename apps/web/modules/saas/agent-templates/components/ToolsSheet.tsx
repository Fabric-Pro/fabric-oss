"use client";

/**
 * Tools Sheet
 * Side drawer for adding and managing agent tools
 * Uses Card-based tiles matching integrations page style
 */

import {
	type CapabilitySubTool,
	getBuiltInCapabilitiesByType,
} from "@saas/agents/lib/builtin-capabilities";
import { McpServerIcon } from "@saas/mcp/components/McpServerIcon";
import { IntegrationBrandIcon } from "@saas/workflows/components/integrations/IntegrationBrandIcon";
import {
	getAllIntegrations,
	getIntegration,
	getToolIntegrationTypes,
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
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
	ArrowLeftIcon,
	CheckCircle2Icon,
	EyeIcon,
	EyeOffIcon,
	InfoIcon,
	Loader2Icon,
	SearchIcon,
	ServerIcon,
	SettingsIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import type { ElementType, ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type ToolDefinition = {
	id: string;
	name: string;
	description: string;
	icon?: ElementType | ((className?: string) => ReactNode);
	category: "top" | "integrations" | "other";
	integrationType?: IntegrationType;
	isBuiltIn?: boolean;
	iconBgClassName?: string;
	subTools?: CapabilitySubTool[];
};

type DetailView =
	| { type: "builtin"; id: string }
	| { type: "skill"; id: string }
	| { type: "integration"; integrationType: IntegrationType }
	| { type: "mcp"; configId: string };

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
	selectedTools: string[];
	onSelectionChange: (tools: string[]) => void;
	selectedSkillIds?: string[];
	onSkillSelectionChange?: (skillIds: string[]) => void;
	availableSkills?: Array<{
		id: string;
		name: string;
		description: string;
		category?: string | null;
	}>;
	suggestedTools?: string[];
	/**
	 * Per-tool configuration overlay (e.g., the bound project for
	 * `project-context`). Merged into toolConnections by the parent at
	 * save time.
	 */
	toolConfigs?: Record<string, Record<string, unknown>>;
	onToolConfigsChange?: (
		configs: Record<string, Record<string, unknown>>,
	) => void;
};

export function ToolsSheet({
	open,
	onOpenChange,
	organizationId,
	selectedTools,
	onSelectionChange,
	selectedSkillIds = [],
	onSkillSelectionChange,
	availableSkills = [],
	suggestedTools = [],
	toolConfigs = {},
	onToolConfigsChange,
}: Props) {
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [filter, setFilter] = useState<"all" | "skills" | "tools">("all");
	const [detailView, setDetailView] = useState<DetailView | null>(null);
	const [configuring, setConfiguring] = useState<IntegrationType | null>(
		null,
	);
	const [credentials, setCredentials] = useState<Record<string, string>>({});
	const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>(
		{},
	);

	// Normalize organizationId: undefined -> null for explicit personal context
	const effectiveOrgId = organizationId ?? null;
	const builtInTools = useMemo(
		() =>
			getBuiltInCapabilitiesByType("tool").map((capability) => ({
				id: capability.id,
				name: capability.name,
				description: capability.description,
				icon: capability.icon,
				category: "top" as const,
				isBuiltIn: true,
				iconBgClassName: capability.iconBgClassName,
				subTools: capability.subTools,
			})),
		[],
	);

	// Get all integration plugins
	const allIntegrations = useMemo(() => getAllIntegrations(), []);

	// Get integration tool plugins (exclude MCP - handled in its own section)
	const integrationPlugins = useMemo(() => {
		return getToolIntegrationTypes()
			.filter((type) => type !== "MCP")
			.map((type) => allIntegrations.find((p) => p.type === type))
			.filter(Boolean);
	}, [allIntegrations]);

	// Fetch configured integrations
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

	// Fetch MCP configs
	const { data: mcpData } = useQuery({
		queryKey: ["mcp-configs", effectiveOrgId],
		queryFn: async () => {
			return await orpcClient.mcp.configs.list({
				organizationId: effectiveOrgId,
			});
		},
	});

	// Normalize MCP data (handle both array and {configs: []} response shapes)
	const mcpConfigs: any[] = Array.isArray(mcpData)
		? mcpData
		: (mcpData?.configs ?? []);

	// Projects for the Project Context tool's project picker.
	const { data: projectsResponse } = useQuery({
		queryKey: ["projects-list-tools-sheet", effectiveOrgId],
		queryFn: async () => {
			return await orpcClient.projects.list({
				organizationId: effectiveOrgId,
				limit: 100,
			});
		},
		staleTime: 5 * 60 * 1000,
		enabled: open,
	});
	const projects: Array<{ id: string; name: string }> =
		projectsResponse?.projects ?? [];

	const updateToolConfig = (
		toolId: string,
		patch: Record<string, unknown>,
	) => {
		if (!onToolConfigsChange) {
			return;
		}
		const current = toolConfigs[toolId] ?? {};
		onToolConfigsChange({
			...toolConfigs,
			[toolId]: { ...current, ...patch },
		});
	};

	const isIntegrationConfigured = (type: IntegrationType): boolean => {
		return configuredIntegrations.some(
			(i) => i.provider === type && i.hasCredentials,
		);
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
			toast.success("Tool configured successfully!");
			queryClient.invalidateQueries({
				queryKey: ["workflow-integrations"],
			});
			if (configuring) {
				// Auto-add the tool after successful configuration
				if (!selectedTools.includes(configuring)) {
					onSelectionChange([...selectedTools, configuring]);
				}
			}
			setConfiguring(null);
			setCredentials({});
		},
		onError: (error) => {
			toast.error(error.message || "Failed to configure tool");
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

	const handleAddBuiltInTool = (tool: ToolDefinition) => {
		if (selectedTools.includes(tool.id)) {
			onSelectionChange(selectedTools.filter((t) => t !== tool.id));
		} else {
			onSelectionChange([...selectedTools, tool.id]);
		}
	};

	const handleAddIntegrationTool = (type: IntegrationType) => {
		// If tool needs configuration and isn't configured, show config form
		if (!isIntegrationConfigured(type)) {
			setConfiguring(type);
			setCredentials({});
			return;
		}

		// Toggle tool selection
		if (selectedTools.includes(type)) {
			onSelectionChange(selectedTools.filter((t) => t !== type));
		} else {
			onSelectionChange([...selectedTools, type]);
		}
	};

	const handleToggleMcpServer = (configId: string) => {
		const toolId = `mcp:${configId}`;
		if (selectedTools.includes(toolId)) {
			onSelectionChange(selectedTools.filter((t) => t !== toolId));
		} else {
			onSelectionChange([...selectedTools, toolId]);
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

	// Filter tools by search
	const filteredBuiltInTools = builtInTools.filter(
		(tool) =>
			tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			tool.description.toLowerCase().includes(searchQuery.toLowerCase()),
	);
	const filteredSkills = availableSkills.filter(
		(skill) =>
			skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			skill.description
				.toLowerCase()
				.includes(searchQuery.toLowerCase()) ||
			(skill.category
				?.toLowerCase()
				.includes(searchQuery.toLowerCase()) ??
				false),
	);

	const filteredMcpConfigs = mcpConfigs.filter((config: any) => {
		const name =
			config.displayName || config.mcpServer?.name || "MCP Server";
		const description =
			config.mcpServer?.description || config.description || "";
		return (
			name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			description.toLowerCase().includes(searchQuery.toLowerCase())
		);
	});

	const filteredIntegrationPlugins = integrationPlugins.filter((plugin) => {
		if (!plugin) {
			return false;
		}
		return (
			plugin.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
			plugin.description.toLowerCase().includes(searchQuery.toLowerCase())
		);
	});

	const configuringPlugin = configuring ? getIntegration(configuring) : null;

	// Check if a tool is suggested
	const isSuggested = (toolId: string) => {
		return suggestedTools.some(
			(s) => s.toLowerCase() === toolId.toLowerCase(),
		);
	};

	// Resolve what to show in the detail view
	const resolvedDetail = useMemo(() => {
		if (!detailView) {
			return null;
		}
		if (detailView.type === "builtin") {
			const cap = builtInTools.find((t) => t.id === detailView.id);
			if (!cap) {
				return null;
			}
			return {
				title: cap.name,
				description: cap.description,
				icon:
					typeof cap.icon === "function" ? (
						<div
							className={cn(
								"flex h-12 w-12 items-center justify-center rounded-xl",
								cap.iconBgClassName ?? "bg-muted",
							)}
						>
							{cap.icon("size-6 text-foreground")}
						</div>
					) : (
						(null as ReactNode)
					),
				subTools: cap.subTools ?? [],
			};
		}
		if (detailView.type === "skill") {
			const skill = availableSkills.find((s) => s.id === detailView.id);
			if (!skill) {
				return null;
			}
			return {
				title: skill.name,
				description: skill.description,
				icon: null as ReactNode,
				subTools: [] as CapabilitySubTool[],
			};
		}
		if (detailView.type === "integration") {
			const plugin = getIntegration(detailView.integrationType);
			if (!plugin) {
				return null;
			}
			const Icon = plugin.icon;
			return {
				title: plugin.label,
				description: plugin.description,
				icon: (
					<IntegrationBrandIcon
						icon={Icon}
						label={plugin.label}
						color={plugin.color}
						brandColor={plugin.brandColor}
						size={48}
					/>
				) as ReactNode,
				subTools: plugin.actions.map((a) => ({
					name: a.label,
					description: a.description,
					stake: "never" as const,
				})),
			};
		}
		if (detailView.type === "mcp") {
			const config = mcpConfigs.find(
				(c: any) => c.id === detailView.configId,
			);
			if (!config) {
				return null;
			}
			const name =
				config.displayName || config.mcpServer?.name || "MCP Server";
			const description =
				config.mcpServer?.description ||
				config.description ||
				"MCP server connection";
			return {
				title: name,
				description,
				icon: (
					<McpServerIcon
						name={name}
						iconUrl={config.mcpServer?.iconUrl}
						docsUrl={config.mcpServer?.docsUrl}
						repositoryUrl={config.mcpServer?.repositoryUrl}
						defaultUrl={
							config.baseUrl || config.mcpServer?.defaultUrl
						}
						size={48}
						className="h-12 w-12 rounded-lg"
					/>
				) as ReactNode,
				subTools: [] as CapabilitySubTool[],
			};
		}
		return null;
	}, [detailView, builtInTools, availableSkills, mcpConfigs]);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="!w-[min(1280px,56vw)] !max-w-none flex flex-col p-0">
				<SheetHeader className="px-6 pt-6 pb-4 border-b">
					<SheetTitle className="text-xl">
						Add capabilities
					</SheetTitle>
					<SheetDescription>
						Select skills and tools to enhance your agent's
						capabilities
					</SheetDescription>
				</SheetHeader>

				{/* Search — hidden in detail view */}
				{!detailView && (
					<div className="px-6 py-4 border-b bg-muted/30">
						<div className="relative">
							<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
							<SearchInput
								placeholder="Search capabilities..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="pl-10 bg-background"
							/>
						</div>
						<div className="mt-3 flex items-center gap-2">
							{(["all", "skills", "tools"] as const).map(
								(value) => (
									<Button
										key={value}
										type="button"
										size="sm"
										variant={
											filter === value
												? "default"
												: "outline"
										}
										onClick={() => setFilter(value)}
										className="capitalize"
									>
										{value}
									</Button>
								),
							)}
						</div>
					</div>
				)}

				<ScrollArea className="flex-1">
					<div className="p-6">
						{/* Detail view */}
						{detailView && resolvedDetail && (
							<CapabilityDetailView
								icon={resolvedDetail.icon}
								title={resolvedDetail.title}
								description={resolvedDetail.description}
								subTools={resolvedDetail.subTools}
								onBack={() => setDetailView(null)}
							/>
						)}

						{/* Configuration form */}
						{!detailView && configuring && configuringPlugin && (
							<div className="mb-6 p-5 border rounded-xl bg-muted/30">
								<div className="flex items-center justify-between mb-5">
									<div className="flex items-center gap-4">
										<div className="w-14 h-14 rounded-xl bg-white dark:bg-slate-800 flex items-center justify-center shadow-lg border">
											<configuringPlugin.icon className="h-8 w-8" />
										</div>
										<div>
											<h4 className="font-semibold text-lg">
												Configure{" "}
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
									{configuringPlugin.formFields.map(
										(field: IntegrationFormField) => (
											<div
												key={field.id}
												className="space-y-2"
											>
												<Label
													htmlFor={field.id}
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
														id={field.id}
														type={
															field.type ===
																"password" &&
															!showPasswords[
																field.id
															]
																? "password"
																: "text"
														}
														placeholder={
															field.placeholder
														}
														value={
															credentials[
																field.configKey
															] || ""
														}
														onChange={(e) =>
															setCredentials({
																...credentials,
																[field.configKey]:
																	e.target
																		.value,
															})
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
																field.id
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
														{field.helpText}
													</p>
												)}
											</div>
										),
									)}

									<div className="flex gap-3 pt-3">
										<Button
											variant="outline"
											onClick={handleTestConfig}
											disabled={testMutation.isPending}
										>
											{testMutation.isPending && (
												<Loader2Icon className="h-4 w-4 animate-spin mr-2" />
											)}
											Test Connection
										</Button>
										<Button
											onClick={handleSaveConfig}
											disabled={saveMutation.isPending}
											className="bg-emerald-500 hover:bg-emerald-600"
										>
											{saveMutation.isPending && (
												<Loader2Icon className="h-4 w-4 animate-spin mr-2" />
											)}
											Connect & Add
										</Button>
									</div>
								</div>
							</div>
						)}

						{/* Tools list */}
						{!detailView && !configuring && (
							<div className="space-y-8">
								{/* Skills */}
								{(filter === "all" || filter === "skills") && (
									<div>
										<h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
											Skills
										</h4>
										<p className="mb-4 text-sm text-muted-foreground">
											Reusable behavior modules that help
											the agent do specialized work.
										</p>
										{filteredSkills.length > 0 ? (
											<div className="grid gap-4 md:grid-cols-2">
												{filteredSkills.map((skill) => {
													const isSelected =
														selectedSkillIds.includes(
															skill.id,
														);
													return (
														<CapabilityCard
															key={skill.id}
															title={skill.name}
															description={
																skill.description
															}
															selected={
																isSelected
															}
															badge={
																skill.category ??
																"Skill"
															}
															onClick={() => {
																if (
																	!onSkillSelectionChange
																) {
																	return;
																}
																onSkillSelectionChange(
																	isSelected
																		? selectedSkillIds.filter(
																				(
																					id,
																				) =>
																					id !==
																					skill.id,
																			)
																		: [
																				...selectedSkillIds,
																				skill.id,
																			],
																);
															}}
															onDetailsClick={() =>
																setDetailView({
																	type: "skill",
																	id: skill.id,
																})
															}
															detailsLabel="Skill details"
														/>
													);
												})}
											</div>
										) : (
											<div className="text-center py-6 text-muted-foreground border border-dashed rounded-lg">
												<p className="text-sm">
													No skills match your search
												</p>
											</div>
										)}
									</div>
								)}

								{/* Built-in tools */}
								{(filter === "all" || filter === "tools") &&
									filteredBuiltInTools.length > 0 && (
										<div>
											<h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
												Tools
											</h4>
											<p className="mb-4 text-sm text-muted-foreground">
												Tools that allow agents to
												retrieve data and take actions.
											</p>
											<div className="grid gap-4 md:grid-cols-2">
												{filteredBuiltInTools.map(
													(tool) => {
														const isSelected =
															selectedTools.includes(
																tool.id,
															);
														const suggested =
															isSuggested(
																tool.id,
															) ||
															isSuggested(
																tool.name,
															);

														const extraContent =
															tool.id ===
																"project-context" &&
															isSelected
																? renderProjectPicker(
																		toolConfigs[
																			"project-context"
																		]
																			?.projectId as
																			| string
																			| undefined,
																		(
																			value,
																		) =>
																			updateToolConfig(
																				"project-context",
																				{
																					projectId:
																						value,
																				},
																			),
																		projects,
																	)
																: undefined;

														return (
															<CapabilityCard
																key={tool.id}
																title={
																	tool.name
																}
																description={
																	tool.description
																}
																selected={
																	isSelected
																}
																onClick={() =>
																	handleAddBuiltInTool(
																		tool,
																	)
																}
																onDetailsClick={() =>
																	setDetailView(
																		{
																			type: "builtin",
																			id: tool.id,
																		},
																	)
																}
																recommended={
																	suggested
																}
																leading={
																	typeof tool.icon ===
																	"function" ? (
																		<div
																			className={cn(
																				"flex h-10 w-10 items-center justify-center rounded-xl",
																				tool.iconBgClassName ??
																					"bg-muted",
																			)}
																		>
																			{tool.icon(
																				"size-5 text-foreground",
																			)}
																		</div>
																	) : null
																}
																extraContent={
																	extraContent
																}
															/>
														);
													},
												)}
											</div>
										</div>
									)}

								{/* MCP Servers */}
								{(filter === "all" || filter === "tools") &&
									(filteredMcpConfigs.length > 0 ||
										!searchQuery) && (
										<div>
											<h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
												MCP Servers
											</h4>
											{filteredMcpConfigs.length > 0 ? (
												<div className="grid gap-4 md:grid-cols-2">
													{filteredMcpConfigs.map(
														(config: any) => {
															const configId =
																config.id;
															const toolId = `mcp:${configId}`;
															const isSelected =
																selectedTools.includes(
																	toolId,
																);
															const name =
																config.displayName ||
																config.mcpServer
																	?.name ||
																"MCP Server";
															const description =
																config.mcpServer
																	?.description ||
																config.description;
															const isActive =
																config.enabled ??
																true;
															const suggested =
																isSuggested(
																	toolId,
																) ||
																isSuggested(
																	name,
																);

															return (
																<CapabilityCard
																	key={
																		configId
																	}
																	title={name}
																	description={
																		description ||
																		"MCP server connection"
																	}
																	selected={
																		isSelected
																	}
																	onClick={() =>
																		handleToggleMcpServer(
																			configId,
																		)
																	}
																	onDetailsClick={() =>
																		setDetailView(
																			{
																				type: "mcp",
																				configId,
																			},
																		)
																	}
																	recommended={
																		suggested
																	}
																	badge={
																		isActive
																			? "Active"
																			: "Inactive"
																	}
																	leading={
																		<McpServerIcon
																			name={
																				name
																			}
																			iconUrl={
																				config
																					.mcpServer
																					?.iconUrl
																			}
																			docsUrl={
																				config
																					.mcpServer
																					?.docsUrl
																			}
																			repositoryUrl={
																				config
																					.mcpServer
																					?.repositoryUrl
																			}
																			defaultUrl={
																				config.baseUrl ||
																				config
																					.mcpServer
																					?.defaultUrl
																			}
																			size={
																				40
																			}
																			className="h-10 w-10 rounded-lg"
																			fallbackClassName={cn(
																				isSelected
																					? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-400"
																					: "bg-muted text-muted-foreground",
																			)}
																		/>
																	}
																/>
															);
														},
													)}
												</div>
											) : (
												<div className="text-center py-6 text-muted-foreground border border-dashed rounded-lg">
													<ServerIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
													<p className="text-sm">
														No MCP servers
														configured
													</p>
													<p className="text-xs mt-1">
														Go to Settings &rarr;
														MCP Servers to add one
													</p>
												</div>
											)}
										</div>
									)}

								{/* Integration tools */}
								{(filter === "all" || filter === "tools") &&
									filteredIntegrationPlugins.length > 0 && (
										<div>
											<h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
												Integrations
											</h4>
											<div className="grid gap-4 md:grid-cols-2">
												{filteredIntegrationPlugins.map(
													(plugin) => {
														if (!plugin) {
															return null;
														}
														const isSelected =
															selectedTools.includes(
																plugin.type,
															);
														const isConfigured =
															isIntegrationConfigured(
																plugin.type,
															);
														const Icon =
															plugin.icon;
														return (
															<CapabilityCard
																key={
																	plugin.type
																}
																title={
																	plugin.label
																}
																description={
																	plugin.description
																}
																selected={
																	isSelected
																}
																onClick={() =>
																	handleAddIntegrationTool(
																		plugin.type,
																	)
																}
																onDetailsClick={() =>
																	setDetailView(
																		{
																			type: "integration",
																			integrationType:
																				plugin.type,
																		},
																	)
																}
																badge={
																	isConfigured &&
																	!isSelected
																		? "Configured"
																		: undefined
																}
																leading={
																	<IntegrationBrandIcon
																		icon={
																			Icon
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
																		size={
																			40
																		}
																	/>
																}
																footerText={
																	!isConfigured
																		? "Click to configure"
																		: undefined
																}
															/>
														);
													},
												)}
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
							<SparklesIcon className="h-4 w-4 text-primary" />
							<span className="text-sm font-medium">
								{selectedTools.length + selectedSkillIds.length}{" "}
								capability
								{selectedTools.length +
									selectedSkillIds.length !==
								1
									? "ies"
									: "y"}{" "}
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
								Add capabilities
							</Button>
						</div>
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}

function renderProjectPicker(
	value: string | undefined,
	onChange: (next: string | undefined) => void,
	projects: Array<{ id: string; name: string }>,
) {
	return (
		<div className="space-y-1.5">
			<Label
				htmlFor="project-context-project"
				className="text-xs uppercase tracking-wider text-muted-foreground"
			>
				Project
			</Label>
			<Select
				value={value ?? "__none__"}
				onValueChange={(next) =>
					onChange(next === "__none__" ? undefined : next)
				}
			>
				<SelectTrigger id="project-context-project" className="w-full">
					<SelectValue placeholder="Select a project" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="__none__">No project bound</SelectItem>
					{projects.map((project) => (
						<SelectItem key={project.id} value={project.id}>
							{project.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="text-xs text-muted-foreground">
				The agent will answer about this project's documents,
				transcripts, code, and contexts.
			</p>
		</div>
	);
}

function CapabilityCard({
	title,
	description,
	selected,
	onClick,
	onDetailsClick,
	leading,
	badge,
	recommended = false,
	footerText,
	detailsLabel = "Tool Details",
	extraContent,
}: {
	title: string;
	description: string;
	selected: boolean;
	onClick: () => void;
	onDetailsClick?: () => void;
	leading?: ReactNode;
	badge?: string;
	recommended?: boolean;
	footerText?: string;
	detailsLabel?: string;
	/**
	 * Optional extra content rendered below the description (e.g., a
	 * config picker for tools that need additional setup). Clicks inside
	 * this region are stopped from propagating so they don't toggle the
	 * card's selection.
	 */
	extraContent?: ReactNode;
}) {
	return (
		<Card
			className={cn(
				"min-h-[168px] rounded-3xl border p-5 cursor-pointer transition-colors hover:border-primary/40",
				selected &&
					"border-emerald-500/50 bg-emerald-50/50 dark:bg-emerald-950/20",
			)}
			onClick={onClick}
		>
			<div className="flex h-full flex-col">
				<div className="flex items-start justify-between gap-4">
					<div className="flex min-w-0 gap-3">
						{leading ? (
							<div className="shrink-0">{leading}</div>
						) : (
							<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted" />
						)}
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<p className="text-lg font-semibold leading-tight">
									{title}
								</p>
								{selected && (
									<CheckCircle2Icon className="h-4 w-4 text-emerald-500 shrink-0" />
								)}
							</div>
							<div className="mt-2 flex items-center gap-2 flex-wrap">
								{badge && (
									<Badge
										variant="outline"
										className="text-xs"
									>
										{badge}
									</Badge>
								)}
								{recommended && !selected && (
									<Badge
										variant="secondary"
										className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0"
									>
										Recommended
									</Badge>
								)}
							</div>
						</div>
					</div>
					<Button
						type="button"
						size="sm"
						variant={selected ? "secondary" : "outline"}
						className="shrink-0 rounded-xl px-4"
					>
						{selected ? "Added" : "+ Add"}
					</Button>
				</div>

				<p className="mt-4 max-w-[34ch] text-sm leading-6 text-muted-foreground">
					{description}
				</p>

				{extraContent && (
					<div
						className="mt-4"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						{extraContent}
					</div>
				)}

				<div className="mt-auto pt-4">
					{onDetailsClick ? (
						<button
							type="button"
							className="text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
							onClick={(e) => {
								e.stopPropagation();
								onDetailsClick();
							}}
						>
							{detailsLabel}
						</button>
					) : (
						<p className="text-sm font-semibold text-muted-foreground">
							{detailsLabel}
						</p>
					)}
					{footerText && (
						<p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
							<SettingsIcon className="h-3 w-3" />
							{footerText}
						</p>
					)}
				</div>
			</div>
		</Card>
	);
}

const STAKE_OPTIONS = [
	{ value: "high", label: "High stake (always ask)" },
	{ value: "medium", label: "Medium stake (save per-agent)" },
	{ value: "low", label: "Low stake (can disable)" },
	{ value: "never", label: "Never ask (automatic execution)" },
] as const;

function CapabilityDetailView({
	icon,
	title,
	description,
	subTools,
	onBack,
}: {
	icon?: ReactNode;
	title: string;
	description: string;
	subTools: CapabilitySubTool[];
	onBack: () => void;
}) {
	const [stakeSettings, setStakeSettings] = useState<Record<string, string>>(
		() =>
			Object.fromEntries(
				subTools.map((t) => [t.name, t.stake ?? "never"]),
			),
	);

	return (
		<div>
			{/* Header */}
			<div className="flex items-center gap-4 mb-6">
				{icon && <div className="shrink-0">{icon}</div>}
				<div>
					<h3 className="text-xl font-semibold">{title}</h3>
					<p className="text-sm text-muted-foreground mt-1">
						{description}
					</p>
				</div>
			</div>

			{/* Available Tools section */}
			{subTools.length > 0 && (
				<div className="space-y-4">
					<div className="flex items-center gap-3">
						<h4 className="text-base font-semibold">
							Available Tools
						</h4>
						<Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0 text-xs font-medium">
							{subTools.length}{" "}
							{subTools.length === 1 ? "tool" : "tools"}
						</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						{subTools.length === 1
							? "This tool will be available to your agent during conversations and can be configured with different permission levels:"
							: "These tools will be available to your agent during conversations and can be configured with different permission levels:"}
					</p>

					{/* User Approval Settings info box */}
					<div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-4 text-sm space-y-1">
						<div className="flex items-center gap-2 font-semibold text-blue-900 dark:text-blue-200 mb-2">
							<InfoIcon className="h-4 w-4 shrink-0" />
							User Approval Settings
						</div>
						<p className="text-blue-800 dark:text-blue-300">
							<strong>High stake</strong> tools need explicit user
							approval.
						</p>
						<p className="text-blue-800 dark:text-blue-300">
							<strong>Medium stake</strong> tools allow users to
							save per-agent confirmations.
						</p>
						<p className="text-blue-800 dark:text-blue-300">
							Users can completely disable confirmations for{" "}
							<strong>low stake</strong> tools.
						</p>
						<p className="text-blue-800 dark:text-blue-300">
							<strong>Never ask</strong> tools run automatically.
						</p>
					</div>

					{/* Sub-tool list */}
					<div className="space-y-3">
						{subTools.map((tool) => (
							<div
								key={tool.name}
								className="rounded-lg border bg-muted/30 p-4"
							>
								<h5 className="font-semibold text-sm mb-1">
									{tool.name}
								</h5>
								<p className="text-sm text-muted-foreground mb-3">
									{tool.description}
								</p>
								<div className="flex items-center justify-between gap-4">
									<span className="text-sm text-muted-foreground font-medium">
										Tool stake setting
									</span>
									<Select
										value={
											stakeSettings[tool.name] ?? "never"
										}
										onValueChange={(value) =>
											setStakeSettings((prev) => ({
												...prev,
												[tool.name]: value,
											}))
										}
									>
										<SelectTrigger className="w-56 text-sm h-9">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{STAKE_OPTIONS.map((opt) => (
												<SelectItem
													key={opt.value}
													value={opt.value}
												>
													{opt.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{subTools.length === 0 && (
				<div className="text-center py-8 text-muted-foreground border border-dashed rounded-lg">
					<p className="text-sm">
						No individual tool details available.
					</p>
				</div>
			)}

			{/* Back button */}
			<div className="mt-8 pt-4 border-t">
				<Button
					variant="outline"
					onClick={onBack}
					className="flex items-center gap-2"
				>
					<ArrowLeftIcon className="h-4 w-4" />
					Back
				</Button>
			</div>
		</div>
	);
}
