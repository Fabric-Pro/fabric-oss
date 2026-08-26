"use client";

import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { getIntegration } from "@saas/workflows/lib/plugins";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { cn } from "@ui/lib";
import { format, formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	BarChart3Icon,
	BookOpenIcon,
	BrainIcon,
	BriefcaseIcon,
	CodeIcon,
	DatabaseIcon,
	EditIcon,
	HeadphonesIcon,
	MegaphoneIcon,
	PlayIcon,
	RocketIcon,
	ScaleIcon,
	SettingsIcon,
	SparklesIcon,
	TrashIcon,
	WalletIcon,
	WrenchIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { toast } from "sonner";

type IntegrationConfig = {
	integrationType: string;
};

type InstanceWithTemplate = {
	template?: {
		displayName: string;
		description?: string | null;
		category: string;
	} | null;
	integrationConfigurations?: IntegrationConfig[];
	customInstructions?: Record<string, unknown> | null;
	toolConnections?: Record<
		string,
		{ enabled?: boolean; mcpConfigId?: string }
	> | null;
	workspaceIds?: string[];
	executionMode?: "single_turn" | "goal_oriented" | null;
	goal?: string | null;
	maxIterations?: number | null;
	lastRunAt?: string | Date | null;
	runCount?: number | null;
	createdAt: string | Date;
	status: string;
	name: string;
	description?: string | null;
	organizationId?: string | null;
	heroEmojis?: string[] | null;
};

const categoryIcons: Record<
	string,
	{ icon: React.ElementType; gradient: string }
> = {
	DATA: { icon: BarChart3Icon, gradient: "from-blue-500 to-blue-600" },
	DESIGN: { icon: SparklesIcon, gradient: "from-purple-500 to-purple-600" },
	ENGINEERING: { icon: CodeIcon, gradient: "from-green-500 to-green-600" },
	SALES: { icon: BriefcaseIcon, gradient: "from-amber-500 to-amber-600" },
	SUPPORT: {
		icon: HeadphonesIcon,
		gradient: "from-purple-500 to-purple-600",
	},
	MARKETING: { icon: MegaphoneIcon, gradient: "from-pink-500 to-pink-600" },
	PRODUCT: { icon: RocketIcon, gradient: "from-cyan-500 to-cyan-600" },
	KNOWLEDGE: {
		icon: BookOpenIcon,
		gradient: "from-indigo-500 to-indigo-600",
	},
	PRODUCTIVITY: { icon: ZapIcon, gradient: "from-yellow-500 to-yellow-600" },
	FINANCE: { icon: WalletIcon, gradient: "from-emerald-500 to-emerald-600" },
	LEGAL: { icon: ScaleIcon, gradient: "from-slate-500 to-slate-600" },
	OPERATIONS: {
		icon: SettingsIcon,
		gradient: "from-orange-500 to-orange-600",
	},
	GENERAL: { icon: RobotIcon, gradient: "from-slate-500 to-slate-600" },
};

const getCategoryIcon = (category: string | undefined) =>
	categoryIcons[category || "GENERAL"] || categoryIcons.GENERAL;

const formatToolLabel = (toolKey: string) =>
	toolKey
		.replace(/^mcp:/, "")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());

type Props = {
	instanceId: string;
	basePath?: string;
};

export function AgentInstanceDetail({
	instanceId,
	basePath = "/app/agent-templates",
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();

	const { data, isLoading, error } = useQuery(
		orpc.agentTemplates.instances.get.queryOptions({
			input: { id: instanceId },
		}),
	);

	const instance = data?.instance as InstanceWithTemplate | undefined;

	const { data: mcpData } = useQuery(
		orpc.mcp.configs.list.queryOptions({
			input: {
				organizationId: instance?.organizationId ?? null,
			},
		}),
	);

	const workspaceIds = instance?.workspaceIds ?? [];
	const { data: workspacesData } = useQuery({
		queryKey: [
			"document-workspaces",
			instance?.organizationId ?? null,
			workspaceIds,
		],
		queryFn: async () =>
			orpcClient.documentWorkspaces.list({
				organizationId: instance?.organizationId ?? null,
				limit: 100,
				status: "ACTIVE",
				includeShared: true,
			}),
		enabled: workspaceIds.length > 0,
	});

	const workspaceMap = useMemo(
		() =>
			new Map(
				(workspacesData?.workspaces ?? []).map((workspace) => [
					workspace.id,
					workspace.name,
				]),
			),
		[workspacesData?.workspaces],
	);

	const mcpConfigNameMap = useMemo(() => {
		const configs: { id: string; displayName?: string | null }[] =
			Array.isArray(mcpData) ? mcpData : (mcpData?.configs ?? []);
		return new Map(
			configs.map((config) => [
				config.id,
				config.displayName || config.id,
			]),
		);
	}, [mcpData]);

	const enabledTools = useMemo(
		() =>
			Object.entries(instance?.toolConnections ?? {})
				.filter(([, config]) => config?.enabled !== false)
				.map(([toolKey]) => toolKey),
		[instance?.toolConnections],
	);

	const configuredKnowledgeSources = useMemo(
		() =>
			(instance?.integrationConfigurations ?? []).map(
				(config) => config.integrationType,
			),
		[instance?.integrationConfigurations],
	);

	const instructions = useMemo(() => {
		const value = instance?.customInstructions ?? {};
		if (typeof value.additionalContext === "string") {
			return value.additionalContext;
		}
		if (typeof value.role === "string") {
			return value.role;
		}
		return "";
	}, [instance?.customInstructions]);

	const { data: memoryData } = useQuery(
		orpc.agentMemory.files.list.queryOptions({
			input: {
				organizationId: instance?.organizationId ?? null,
				agentInstanceId: instanceId,
				fileType: "SKILL",
			},
		}),
	);

	const skillFiles = memoryData?.files ?? [];
	const chatbotAgentHref = useMemo(() => {
		const payload = encodeURIComponent(
			JSON.stringify({
				agentId: `template-instance:${instanceId}`,
				name: instance?.name,
				description: instance?.description ?? "",
			}),
		);
		return `${basePath.replace(/\/agent-templates$/, "")}/nexus?agent=${payload}`;
	}, [basePath, instance?.description, instance?.name, instanceId]);

	const deleteMutation = useMutation(
		orpc.agentTemplates.instances.delete.mutationOptions(),
	);

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	if (error || !instance) {
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<AlertCircleIcon className="mx-auto h-12 w-12 text-destructive/50" />
					<h3 className="mt-4 font-semibold">Agent Not Found</h3>
					<p className="mt-2 text-muted-foreground">
						{error?.message ||
							"The agent you're looking for doesn't exist or you don't have access."}
					</p>
					<Button asChild className="mt-4">
						<Link href={basePath}>Go Back</Link>
					</Button>
				</CardContent>
			</Card>
		);
	}

	const template = instance.template;
	const { icon: CategoryIcon, gradient } = getCategoryIcon(
		template?.category,
	);

	return (
		<div className="bg-background">
			<div className="flex w-full">
				<div className="flex-1 overflow-y-auto">
					<div className="space-y-8 p-6">
						<section className="rounded-2xl border border-border bg-card p-6">
							<div className="flex flex-col gap-5 lg:flex-row lg:items-start">
								<div
									className={cn(
										"flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br shadow-lg",
										gradient,
									)}
								>
									<CategoryIcon className="h-8 w-8 text-white" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="mb-4 flex flex-wrap items-start justify-between gap-4">
										<div className="min-w-0">
											<div className="mb-2 flex flex-wrap items-center gap-3">
												<h2 className="font-sans text-3xl font-normal tracking-tight">
													{instance.name}
												</h2>
												<Badge
													variant={
														instance.status ===
														"ACTIVE"
															? "default"
															: "secondary"
													}
													className={
														instance.status ===
														"ACTIVE"
															? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
															: ""
													}
												>
													{instance.status ===
													"ACTIVE"
														? "Active"
														: instance.status}
												</Badge>
											</div>
											<p className="max-w-3xl text-sm leading-6 text-muted-foreground">
												{instance.description ||
													"Add a description in edit mode so teammates understand when to use this agent."}
											</p>
										</div>
										<div className="flex flex-wrap items-center gap-2">
											<Button variant="outline" asChild>
												<Link
													href={`${basePath}/agents/${instanceId}/memory`}
												>
													<BrainIcon className="mr-2 h-4 w-4" />
													Memory
												</Link>
											</Button>
											<Button variant="outline" asChild>
												<Link
													href={`${basePath}/agents/${instanceId}/edit`}
												>
													<EditIcon className="mr-2 h-4 w-4" />
													Edit
												</Link>
											</Button>
											<Button asChild>
												<Link href={chatbotAgentHref}>
													<PlayIcon className="mr-2 h-4 w-4" />
													Start Chat
												</Link>
											</Button>
										</div>
									</div>

									<div className="mt-2 flex flex-wrap gap-2">
										{template && (
											<div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-sm text-muted-foreground">
												<span className="mr-1 text-muted-foreground/70">
													Based on
												</span>
												<strong className="text-foreground">
													{template.displayName}
												</strong>
											</div>
										)}
										<div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-sm text-muted-foreground">
											<span className="mr-1 text-muted-foreground/70">
												Created
											</span>
											<span>
												{formatDistanceToNow(
													new Date(
														instance.createdAt,
													),
													{
														addSuffix: true,
													},
												)}
											</span>
										</div>
										{instance.lastRunAt && (
											<div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-sm text-muted-foreground">
												<span className="mr-1 text-muted-foreground/70">
													Last run
												</span>
												<span>
													{formatDistanceToNow(
														new Date(
															instance.lastRunAt,
														),
														{ addSuffix: true },
													)}
												</span>
											</div>
										)}
									</div>
								</div>
							</div>
						</section>

						<section>
							<div className="mb-4">
								<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
									<span className="inline-block h-3 w-px bg-[--mkt-red]" />
									Step 1
								</p>
								<h3 className="text-base font-semibold">
									Instructions
								</h3>
								<p className="text-sm text-muted-foreground">
									The behavior and context currently stored on
									this agent.
								</p>
							</div>
							<div className="rounded-xl border border-border bg-card p-4">
								{instructions ? (
									<pre className="whitespace-pre-wrap font-mono text-sm leading-6 text-foreground">
										{instructions}
									</pre>
								) : (
									<p className="text-sm text-muted-foreground">
										No custom instructions saved yet.
									</p>
								)}
							</div>
						</section>

						<section>
							<div className="mb-4">
								<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
									<span className="inline-block h-3 w-px bg-[--mkt-red]" />
									Step 2
								</p>
								<h3 className="text-base font-semibold">
									Knowledge & Tools
								</h3>
								<p className="text-sm text-muted-foreground">
									Connected workspaces, integrations, and
									capabilities.
								</p>
							</div>

							<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
								<div className="flex flex-col rounded-xl border border-border bg-card">
									<div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
										<div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
											<DatabaseIcon className="h-3.5 w-3.5 text-primary" />
										</div>
										<div>
											<h4 className="text-sm font-semibold">
												Knowledge
											</h4>
											<p className="text-xs text-muted-foreground">
												Workspaces & integrations
											</p>
										</div>
									</div>
									<div className="flex-1 p-3">
										{configuredKnowledgeSources.length ===
											0 && workspaceIds.length === 0 ? (
											<div className="rounded-xl border border-dashed border-border p-4 text-center">
												<DatabaseIcon className="mx-auto mb-2 h-5 w-5 text-muted-foreground/30" />
												<p className="text-xs text-muted-foreground">
													No searchable knowledge
													configured
												</p>
											</div>
										) : (
											<div className="space-y-1.5">
												{workspaceIds.map(
													(workspaceId) => (
														<div
															key={workspaceId}
															className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2"
														>
															<DatabaseIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
															<span className="flex-1 truncate text-sm">
																{workspaceMap.get(
																	workspaceId,
																) ??
																	workspaceId}
															</span>
															<Badge variant="secondary">
																Workspace
															</Badge>
														</div>
													),
												)}
												{configuredKnowledgeSources.map(
													(source) => (
														<div
															key={source}
															className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2"
														>
															<BookOpenIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
															<span className="flex-1 truncate text-sm">
																{getIntegration(
																	source as never,
																)?.label ??
																	source.replace(
																		/_/g,
																		" ",
																	)}
															</span>
															<Badge variant="secondary">
																Integration
															</Badge>
														</div>
													),
												)}
											</div>
										)}
									</div>
								</div>

								<div className="flex flex-col rounded-xl border border-border bg-card">
									<div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
										<div className="flex h-7 w-7 items-center justify-center rounded-lg bg-secondary/10">
											<WrenchIcon className="h-3.5 w-3.5 text-secondary-foreground" />
										</div>
										<div>
											<h4 className="text-sm font-semibold">
												Capabilities
											</h4>
											<p className="text-xs text-muted-foreground">
												Tools available to this agent
											</p>
										</div>
									</div>
									<div className="flex-1 p-3">
										{enabledTools.length === 0 &&
										skillFiles.length === 0 ? (
											<div className="rounded-xl border border-dashed border-border p-4 text-center">
												<WrenchIcon className="mx-auto mb-2 h-5 w-5 text-muted-foreground/30" />
												<p className="text-xs text-muted-foreground">
													No capabilities configured
												</p>
											</div>
										) : (
											<div className="space-y-1.5">
												{skillFiles.map((file) => {
													const skillId = file.path
														.replace("skills/", "")
														.replace(
															"/SKILL.md",
															"",
														);
													const skillName =
														skillId.replace(
															/-/g,
															" ",
														);
													const integrationPlugin =
														getIntegration(
															skillId
																.toUpperCase()
																.replace(
																	/-/g,
																	"_",
																) as Parameters<
																typeof getIntegration
															>[0],
														);
													const SkillIcon =
														integrationPlugin?.icon ??
														PuzzleIcon;
													const skillIconColor =
														integrationPlugin?.color ??
														"text-muted-foreground";
													return (
														<div
															key={file.id}
															className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2"
														>
															<SkillIcon
																className={`h-3.5 w-3.5 shrink-0 ${skillIconColor}`}
															/>
															<span className="flex-1 truncate text-sm capitalize">
																{skillName}
															</span>
															<Badge
																variant="secondary"
																className="text-[11px]"
															>
																Skill
															</Badge>
														</div>
													);
												})}
												{enabledTools.map((toolKey) => {
													const isMcp =
														toolKey.startsWith(
															"mcp:",
														);
													const configId = isMcp
														? toolKey.replace(
																"mcp:",
																"",
															)
														: null;
													const label =
														isMcp && configId
															? (mcpConfigNameMap.get(
																	configId,
																) ?? configId)
															: formatToolLabel(
																	toolKey,
																);
													const toolPlugin = !isMcp
														? getIntegration(
																toolKey as Parameters<
																	typeof getIntegration
																>[0],
															)
														: null;
													const ToolIcon =
														toolPlugin?.icon ??
														WrenchIcon;
													const toolIconColor =
														toolPlugin?.color ??
														"text-primary";
													return (
														<div
															key={toolKey}
															className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2"
														>
															<ToolIcon
																className={`h-3.5 w-3.5 shrink-0 ${toolIconColor}`}
															/>
															<span className="flex-1 truncate text-sm">
																{label}
															</span>
															<Badge
																variant="secondary"
																className="text-[11px]"
															>
																Tool
															</Badge>
														</div>
													);
												})}
											</div>
										)}
									</div>
								</div>
							</div>
						</section>

						<section>
							<div className="mb-4">
								<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
									<span className="inline-block h-3 w-px bg-[--mkt-red]" />
									Step 3
								</p>
								<h3 className="text-base font-semibold">
									Execution
								</h3>
								<p className="text-sm text-muted-foreground">
									How this agent operates when someone invokes
									it.
								</p>
							</div>
							<div className="rounded-xl border border-border bg-card p-4">
								<div className="mb-4 flex flex-wrap items-center gap-2">
									<Badge variant="secondary">
										{instance.executionMode ===
										"goal_oriented"
											? "Goal Oriented"
											: "Single Turn"}
									</Badge>
									{instance.executionMode ===
										"goal_oriented" && (
										<span className="text-sm text-muted-foreground">
											Max iterations:{" "}
											{instance.maxIterations ?? 10}
										</span>
									)}
								</div>
								{instance.executionMode === "goal_oriented" &&
								instance.goal ? (
									<div className="rounded-xl border border-border/60 bg-muted/40 p-4">
										<p className="mb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
											Goal
										</p>
										<p className="text-sm leading-6">
											{instance.goal}
										</p>
									</div>
								) : (
									<p className="text-sm text-muted-foreground">
										This agent replies in a single turn
										without an iterative goal loop.
									</p>
								)}
							</div>
						</section>
					</div>
				</div>

				<div className="min-h-[calc(100vh-120px)] w-[346px] border-l border-border bg-card/50">
					<div className="sticky top-16">
						<div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
							<div>
								<p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
									<span className="inline-block h-3 w-px bg-[--mkt-red]" />
									Summary
								</p>
								<h3 className="text-sm font-semibold">
									Agent Snapshot
								</h3>
							</div>
						</div>

						<div className="space-y-0 divide-y divide-border/60">
							<div className="px-5 py-4">
								<p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
									Template
								</p>
								<div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background px-3 py-3">
									<div
										className={cn(
											"flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br",
											gradient,
										)}
									>
										<CategoryIcon className="h-5 w-5 text-white" />
									</div>
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">
											{template?.displayName ??
												"Unknown template"}
										</p>
										<p className="text-xs text-muted-foreground">
											{template?.category ?? "General"}
										</p>
									</div>
								</div>
							</div>

							<div className="px-5 py-4">
								<p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
									Activity
								</p>
								<div className="grid grid-cols-2 gap-2">
									<div className="rounded-xl border border-border/60 bg-background p-3">
										<p className="text-lg font-semibold">
											{instance.runCount || 0}
										</p>
										<p className="text-[11px] text-muted-foreground">
											Total runs
										</p>
									</div>
									<div className="rounded-xl border border-border/60 bg-background p-3">
										<p className="text-lg font-semibold">
											{instance.lastRunAt
												? format(
														new Date(
															instance.lastRunAt,
														),
														"MMM d",
													)
												: "-"}
										</p>
										<p className="text-[11px] text-muted-foreground">
											Last run
										</p>
									</div>
									<div className="rounded-xl border border-border/60 bg-background p-3">
										<p className="text-lg font-semibold">
											{format(
												new Date(instance.createdAt),
												"MMM d",
											)}
										</p>
										<p className="text-[11px] text-muted-foreground">
											Created
										</p>
									</div>
									<div className="rounded-xl border border-border/60 bg-background p-3">
										<p className="text-lg font-semibold">
											{instance.status === "ACTIVE"
												? "Active"
												: instance.status}
										</p>
										<p className="text-[11px] text-muted-foreground">
											Status
										</p>
									</div>
								</div>
							</div>

							<div className="px-5 py-4">
								<p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
									Next step
								</p>
								<div className="rounded-xl bg-muted/60 p-3.5">
									<p className="mb-1 text-xs font-semibold text-foreground">
										Refine with edit mode
									</p>
									<p className="text-[11px] leading-relaxed text-muted-foreground">
										The edit page now uses the same builder
										as create, so any changes will follow
										the same structure and validation flow.
									</p>
								</div>
							</div>

							<div className="px-5 py-4">
								<p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-destructive">
									Danger zone
								</p>
								<div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
									<p className="text-sm font-medium text-foreground">
										Delete this agent
									</p>
									<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
										This removes the current agent instance
										and its configuration.
									</p>
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												variant="destructive"
												className="mt-3 w-full"
											>
												<TrashIcon className="mr-2 h-4 w-4" />
												Delete Agent
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Delete Agent
												</AlertDialogTitle>
												<AlertDialogDescription>
													Are you sure you want to
													delete "{instance.name}"?
													This action cannot be
													undone.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>
													Cancel
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={async () => {
														try {
															await deleteMutation.mutateAsync(
																{
																	id: instanceId,
																},
															);
															await queryClient.invalidateQueries(
																{
																	queryKey: [
																		"agentTemplates",
																		"instances",
																	],
																},
															);
															toast.success(
																"Agent deleted successfully",
															);
															router.push(
																basePath,
															);
														} catch (deleteError) {
															toast.error(
																deleteError instanceof
																	Error
																	? deleteError.message
																	: "Failed to delete agent",
															);
														}
													}}
													variant="destructive"
												>
													Delete
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
