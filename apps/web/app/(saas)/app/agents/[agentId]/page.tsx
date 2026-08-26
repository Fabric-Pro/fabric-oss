"use client";

import { AgentInstanceDetail } from "@saas/agent-templates/components/AgentInstanceDetail";
import {
	getAgentSelectionSummary,
	getBuiltInCapability,
	getCapabilityIcon,
} from "@saas/agents/lib/builtin-capabilities";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { generateHeroImage } from "@saas/shared/utils/generateHeroImage";
import { getIntegration } from "@saas/workflows/lib/plugins/registry";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Separator } from "@ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	AlertCircle,
	ArrowLeft,
	ArrowRightIcon,
	BarChart3,
	CheckCircleIcon,
	Clock,
	ExternalLink,
	FileText,
	Globe,
	History,
	LoaderIcon,
	MessageSquare,
	PlayIcon,
	RotateCcw,
	Server,
	Settings,
	Shield,
	TrendingUp,
	XCircleIcon,
	Zap,
} from "lucide-react";
import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

/**
 * Get human-readable description for a protocol
 */
function getProtocolInfo(protocol: string): string | null {
	switch (protocol.toUpperCase()) {
		case "A2A":
			return "Agent-to-Agent communication for orchestration";
		case "AG-UI":
			return "Agent UI protocol for real-time streaming";
		case "MCP":
			return "Model Context Protocol for tool access";
		default:
			return null;
	}
}

/** Format milliseconds to a readable duration string */
function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) {
		return "—";
	}
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	return `${(ms / 60000).toFixed(1)}m`;
}

/** Format a date to a short relative string */
function formatRelativeDate(date: Date | null | undefined): string {
	if (!date) {
		return "—";
	}
	const d = date instanceof Date ? date : new Date(date);
	const now = Date.now();
	const diff = now - d.getTime();
	if (diff < 60_000) {
		return "just now";
	}
	if (diff < 3_600_000) {
		return `${Math.floor(diff / 60_000)}m ago`;
	}
	if (diff < 86_400_000) {
		return `${Math.floor(diff / 3_600_000)}h ago`;
	}
	if (diff < 7 * 86_400_000) {
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}
	return d.toLocaleDateString();
}

/** Format a date string like "2025-01-15" to short display */
function formatShortDate(dateStr: string): string {
	const d = new Date(dateStr);
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ============================================================
// Skill / Integration Icon Helper
// ============================================================

/**
 * Look up a skill ID against the workflow plugin registry.
 * Normalizes the skill ID to IntegrationType format (UPPER_SNAKE_CASE).
 * Returns the plugin's icon component and color if found.
 */
function getSkillIntegration(id: string) {
	// Normalize: "google-drive" | "google drive" | "google_drive" → "GOOGLE_DRIVE"
	const normalized = id.toUpperCase().replace(/[\s-]+/g, "_");
	return (
		getIntegration(normalized as Parameters<typeof getIntegration>[0]) ??
		null
	);
}

// ============================================================
// Version History Tab
// ============================================================

interface VersionHistoryTabProps {
	instanceSId: string;
	organizationId: string | undefined;
}

function VersionHistoryTab({
	instanceSId,
	organizationId,
}: VersionHistoryTabProps) {
	const queryClient = useQueryClient();

	const { data: versions, isLoading } = useQuery({
		queryKey: ["agent", "instances", "versions", instanceSId],
		queryFn: () =>
			orpcClient.agents.instances.versions({
				instanceSId,
				organizationId: organizationId ?? null,
			}),
	});

	const restoreMutation = useMutation({
		mutationFn: (instanceId: string) =>
			orpcClient.agents.instances.restore({
				instanceId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["agent", "instances", "versions", instanceSId],
			});
		},
	});

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 py-8 text-muted-foreground">
				<Spinner className="size-4" />
				<span className="text-sm">Loading version history...</span>
			</div>
		);
	}

	if (!versions || versions.length === 0) {
		return (
			<div className="py-8 text-center text-sm text-muted-foreground">
				No version history found.
			</div>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<History className="h-4 w-4" />
					Version History
				</CardTitle>
				<CardDescription>
					All saved versions of this agent, newest first. Restore an
					older version to make it active again.
				</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				<div className="divide-y">
					{versions.map((v) => {
						const isActive = v.status === "ACTIVE";
						const isRestoring =
							restoreMutation.isPending &&
							restoreMutation.variables === v.id;

						return (
							<div
								key={v.id}
								className="flex items-center gap-3 px-6 py-4"
							>
								{/* Version badge */}
								<Badge
									variant={isActive ? "default" : "secondary"}
									className="shrink-0 font-mono text-xs"
								>
									v{v.version}
								</Badge>

								{/* Status */}
								<Badge
									variant="outline"
									className={
										isActive
											? "shrink-0 border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
											: "shrink-0 text-muted-foreground"
									}
								>
									{v.status === "ACTIVE"
										? "Active"
										: v.status === "ARCHIVED"
											? "Archived"
											: v.status}
								</Badge>

								{/* Name + date */}
								<div className="min-w-0 flex-1">
									<span className="truncate text-sm font-medium">
										{v.name}
									</span>
									{v.modelOverride && (
										<span className="ml-2 text-xs text-muted-foreground font-mono">
											{v.modelOverride}
										</span>
									)}
								</div>

								<span className="shrink-0 text-xs text-muted-foreground">
									{formatRelativeDate(v.createdAt)}
								</span>

								{/* Restore action — only for non-active versions */}
								{!isActive && (
									<Button
										size="sm"
										variant="outline"
										disabled={restoreMutation.isPending}
										onClick={() =>
											restoreMutation.mutate(v.id)
										}
									>
										{isRestoring ? (
											<>
												<Spinner className="mr-1 size-3" />
												Restoring…
											</>
										) : (
											<>
												<RotateCcw className="mr-1 h-3 w-3" />
												Restore
											</>
										)}
									</Button>
								)}
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}

// ============================================================
// Insights Tab
// ============================================================

interface InsightsTabProps {
	instanceId: string;
	organizationId: string | undefined;
}

function InsightsTab({ instanceId, organizationId }: InsightsTabProps) {
	const t = useTranslations("tooltips.agents");
	const { data: insights, isLoading } = useQuery({
		queryKey: ["agent", "instances", "insights", instanceId],
		queryFn: () =>
			orpcClient.agents.instances.insights({
				instanceId,
				organizationId: organizationId ?? null,
			}),
	});

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 py-8 text-muted-foreground">
				<Spinner className="size-4" />
				<span className="text-sm">Loading insights...</span>
			</div>
		);
	}

	if (!insights) {
		return (
			<div className="py-8 text-center text-sm text-muted-foreground">
				No insights available.
			</div>
		);
	}

	const maxCount = Math.max(...insights.runsByDay.map((d) => d.count), 1);

	return (
		<div className="space-y-6">
			{/* Summary stats */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<Card>
					<CardContent className="pt-6">
						<div className="flex items-center gap-3">
							<div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
								<TrendingUp className="h-5 w-5 text-primary" />
							</div>
							<div>
								<p className="text-2xl font-bold">
									{insights.totalRuns}
								</p>
								<p className="text-xs text-muted-foreground uppercase tracking-wide">
									Total Runs
								</p>
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardContent className="pt-6">
						<div className="flex items-center gap-3">
							<div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
								<CheckCircleIcon className="h-5 w-5 text-green-600" />
							</div>
							<div>
								<p className="text-2xl font-bold">
									{insights.successRate}%
								</p>
								<p className="text-xs text-muted-foreground uppercase tracking-wide">
									Success Rate
								</p>
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardContent className="pt-6">
						<div className="flex items-center gap-3">
							<div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
								<Clock className="h-5 w-5 text-primary" />
							</div>
							<div>
								<p className="text-2xl font-bold">
									{formatDuration(insights.avgDurationMs)}
								</p>
								<p className="text-xs text-muted-foreground uppercase tracking-wide">
									Avg Duration
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Runs per day chart */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<BarChart3 className="h-4 w-4" />
						Runs per Day (Last 14 Days)
					</CardTitle>
				</CardHeader>
				<CardContent>
					{insights.totalRuns === 0 ? (
						<p className="text-sm text-muted-foreground text-center py-4">
							No runs recorded in the last 14 days.
						</p>
					) : (
						<div className="flex items-end gap-1 h-32">
							{insights.runsByDay.map((day) => {
								const heightPct =
									maxCount > 0
										? (day.count / maxCount) * 100
										: 0;
								const runsCopy = t("runsOnDay", {
									date: formatShortDate(day.date),
									count: day.count,
								});
								return (
									<Tooltip key={day.date}>
										<TooltipTrigger asChild>
											<div className="flex-1 flex flex-col items-center gap-1 group">
												<div className="w-full flex items-end justify-center h-24">
													<div
														className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary min-h-[2px]"
														style={{
															height: `${Math.max(heightPct, day.count > 0 ? 4 : 2)}%`,
														}}
													/>
												</div>
												<span className="text-[9px] text-muted-foreground">
													{
														formatShortDate(
															day.date,
														).split(" ")[1]
													}
												</span>
												<span className="sr-only">
													{runsCopy}
												</span>
											</div>
										</TooltipTrigger>
										<TooltipContent>
											{runsCopy}
										</TooltipContent>
									</Tooltip>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Recent runs table */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Recent Runs</CardTitle>
					<CardDescription>
						Last 10 executions of this agent
					</CardDescription>
				</CardHeader>
				<CardContent className="p-0">
					{insights.recentRuns.length === 0 ? (
						<p className="text-sm text-muted-foreground text-center py-6">
							No runs yet.
						</p>
					) : (
						<div className="divide-y">
							{insights.recentRuns.map((run) => (
								<div
									key={run.id}
									className="flex items-center gap-3 px-6 py-3 text-sm"
								>
									{/* Status indicator */}
									<div className="shrink-0">
										{run.status === "COMPLETED" ? (
											<CheckCircleIcon className="h-4 w-4 text-green-500" />
										) : run.status === "FAILED" ? (
											<XCircleIcon className="h-4 w-4 text-destructive" />
										) : run.status === "RUNNING" ? (
											<LoaderIcon className="h-4 w-4 animate-spin text-primary" />
										) : (
											<Clock className="h-4 w-4 text-muted-foreground" />
										)}
									</div>

									{/* Status text */}
									<span
										className={
											run.status === "COMPLETED"
												? "font-medium text-green-700 dark:text-green-400"
												: run.status === "FAILED"
													? "font-medium text-destructive"
													: "font-medium text-muted-foreground"
										}
									>
										{run.status.charAt(0) +
											run.status.slice(1).toLowerCase()}
									</span>

									{/* Duration */}
									<span className="text-muted-foreground shrink-0">
										{formatDuration(run.duration)}
									</span>

									{/* Trigger */}
									{run.triggerType && (
										<Badge
											variant="outline"
											className="shrink-0 text-xs capitalize"
										>
											{run.triggerType}
										</Badge>
									)}

									{/* Date */}
									<span className="ml-auto shrink-0 text-muted-foreground">
										{formatRelativeDate(run.startedAt)}
									</span>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

// ============================================================
// Main Page
// ============================================================

/**
 * Agent Details Page
 *
 * Displays comprehensive information about an agent including:
 * - Hero section with agent icon/image
 * - Agent metadata (name, description, framework, status)
 * - Protocols supported (A2A, AG-UI, etc.)
 * - Skills/capabilities
 * - "Try Agent" button that routes appropriately
 * - Version History tab (if agent has a linked instance)
 * - Insights tab (if agent has a linked instance)
 */
export default function AgentDetailsPage() {
	const params = useParams();
	const router = useRouter();
	const agentId = params.agentId as string;

	const { organizationId } = useOrganizationContext();

	// Fetch agent details from registry
	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["agent", "registry", agentId],
		queryFn: async () => {
			try {
				return await orpcClient.agents.registry.get({ id: agentId });
			} catch {
				return null;
			}
		},
		retry: false,
	});

	// Parse metadata for additional info
	const metadata = useMemo(() => {
		if (!agent?.metadata) {
			return null;
		}
		try {
			return typeof agent.metadata === "string"
				? JSON.parse(agent.metadata)
				: agent.metadata;
		} catch {
			return null;
		}
	}, [agent]);

	// Extract the instanceId from agent metadata (if present)
	// This links the registered agent to its AgentTemplateInstance
	const instanceId = useMemo<string | null>(() => {
		if (!metadata) {
			return null;
		}
		const id = (metadata as Record<string, unknown>).instanceId;
		return typeof id === "string" ? id : null;
	}, [metadata]);

	// Extract the instanceSId from agent metadata (if present)
	// We need sId to look up all versions
	const instanceSId = useMemo<string | null>(() => {
		if (!metadata) {
			return null;
		}
		const sId = (metadata as Record<string, unknown>).instanceSId;
		return typeof sId === "string" ? sId : null;
	}, [metadata]);

	// Extract capabilities from metadata
	const capabilities = useMemo(() => {
		if (!metadata?.capabilities) {
			return null;
		}
		return metadata.capabilities as {
			supportsPredictiveState?: boolean;
			usesOpenAPI?: boolean;
			requiresEditor?: boolean;
			editorType?: "document" | "prompt" | "code";
		};
	}, [metadata]);

	// Determine routing based on capabilities
	const routingInfo = useMemo(() => {
		if (!agent) {
			return { route: "try", type: "chat" };
		}

		const caps = capabilities;

		// Check for editor-based agents
		if (caps?.requiresEditor) {
			switch (caps.editorType) {
				case "document":
					return { route: "chat", type: "document-editor" };
				case "prompt":
					return { route: "try", type: "prompt-editor" };
				case "code":
					return { route: "try", type: "code-editor" };
				default:
					return { route: "chat", type: "editor" };
			}
		}

		// Check for predictive state support (CopilotKit sidebar)
		if (caps?.supportsPredictiveState) {
			return { route: "chat", type: "copilotkit" };
		}

		// Check for OpenAPI-based agents
		if (caps?.usesOpenAPI) {
			return { route: "try", type: "openapi" };
		}

		// Default to direct mode chat
		return { route: "try", type: "direct" };
	}, [agent, capabilities]);

	const selectedCapabilities = useMemo(() => {
		const summary = getAgentSelectionSummary(agent ?? undefined);
		return [
			...summary.skillDetails.map((skill) => ({
				id: skill.id,
				name: skill.name,
				description: skill.description,
				kind: "skill" as const,
			})),
			...summary.capabilityIds.map((capabilityId) => {
				const capability = getBuiltInCapability(capabilityId);
				return {
					id: capabilityId,
					name: capability?.name ?? capabilityId,
					description: capability?.description ?? "",
					kind: "capability" as const,
				};
			}),
		];
	}, [agent]);

	// Extract protocols from metadata (communication protocols: A2A, AG-UI, MCP)
	const protocols = useMemo(() => {
		if (metadata?.protocols) {
			return Array.isArray(metadata.protocols) ? metadata.protocols : [];
		}
		// Infer from framework if protocols not specified
		const protos: string[] = [];
		if (agent?.framework === "A2A") {
			protos.push("A2A");
		}
		if (
			agent?.framework === "LangGraph" ||
			agent?.framework === "LANGGRAPH"
		) {
			protos.push("A2A");
			protos.push("AG-UI");
		}
		if (agent?.framework === "MCP") {
			protos.push("MCP");
		}
		return protos;
	}, [metadata, agent]);

	// Extract framework (what the agent is built with)
	const framework = useMemo(() => {
		return agent?.framework || "Unknown";
	}, [agent]);

	// Generate hero image
	const heroImage = useMemo(() => {
		if (!agent) {
			return "";
		}
		return (
			((metadata as Record<string, unknown> | null)?.heroImageUrl as
				| string
				| undefined) ||
			generateHeroImage({
				name: agent.displayName,
				category:
					((metadata as Record<string, unknown> | null)
						?.category as string) || agent.framework,
			})
		);
	}, [agent, metadata]);

	// Get status info
	const getStatusInfo = () => {
		switch (agent?.status) {
			case "ACTIVE":
				return {
					icon: (
						<CheckCircleIcon className="h-4 w-4 text-green-500" />
					),
					text: "Active",
					color: "text-green-600",
					bgColor: "bg-green-500/10",
				};
			case "DEPLOYING":
				return {
					icon: (
						<LoaderIcon className="h-4 w-4 animate-spin text-blue-500" />
					),
					text: "Deploying",
					color: "text-blue-600",
					bgColor: "bg-blue-500/10",
				};
			case "ERROR":
				return {
					icon: <XCircleIcon className="h-4 w-4 text-destructive" />,
					text: "Error",
					color: "text-destructive",
					bgColor: "bg-destructive/10",
				};
			default:
				return {
					icon: <Clock className="h-4 w-4 text-muted-foreground" />,
					text: agent?.status || "Unknown",
					color: "text-muted-foreground",
					bgColor: "bg-muted",
				};
		}
	};

	const handleTryAgent = () => {
		// Route based on agent capabilities
		router.push(`/app/agents/${agentId}/${routingInfo.route}`);
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center min-h-[400px]">
				<Spinner className="mr-2 size-4 text-primary" />
				<span className="text-sm text-muted-foreground">
					Loading agent details...
				</span>
			</div>
		);
	}

	if (error || !agent) {
		// Registry lookup failed — fall back to instance view
		if (error || !agent) {
			return <AgentInstanceDetail instanceId={agentId} basePath="/app" />;
		}
		return (
			<div className="container py-8">
				<Alert variant="error">
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>Error</AlertTitle>
					<AlertDescription>Agent not found</AlertDescription>
				</Alert>
				<div className="mt-4">
					<Button
						variant="outline"
						onClick={() => router.push("/app/agents")}
					>
						<ArrowLeft className="h-4 w-4 mr-2" />
						Back to Agents
					</Button>
				</div>
			</div>
		);
	}

	const statusInfo = getStatusInfo();
	const hasInstance = Boolean(instanceId);

	return (
		<div className="min-h-screen">
			{/* Hero Section */}
			<div className="relative overflow-hidden bg-gradient-to-b from-card via-background to-background">
				{/* Dot-grid texture */}
				<div
					className="pointer-events-none absolute inset-0 opacity-[0.04]"
					style={{
						backgroundImage:
							"radial-gradient(circle, currentColor 1px, transparent 1px)",
						backgroundSize: "32px 32px",
					}}
				/>

				<div className="container relative z-10 py-8">
					{/* Back Button */}
					<div className="mb-6">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => router.push("/app/agents")}
						>
							<ArrowLeft className="h-4 w-4 mr-2" />
							Back to Agents
						</Button>
					</div>

					{/* Agent Hero */}
					<div className="flex flex-col lg:flex-row gap-8 items-start">
						{/* Hero Image */}
						<div className="relative w-full lg:w-80 aspect-video lg:aspect-square rounded-2xl overflow-hidden border bg-card/50">
							<Image
								src={heroImage}
								alt={agent.displayName}
								fill
								sizes="(max-width: 768px) 100vw, 320px"
								className="object-cover object-left-bottom"
								unoptimized
							/>
						</div>

						{/* Agent Info */}
						<div className="flex-1 min-w-0">
							<div className="flex items-start gap-4 flex-wrap">
								<div className="flex-1 min-w-0">
									<h1 className="font-bold text-2xl lg:text-3xl tracking-tight">
										{agent.displayName}
									</h1>
									{agent.name !== agent.displayName && (
										<p className="text-muted-foreground text-sm mt-1 font-mono">
											{agent.name}
										</p>
									)}
								</div>

								{/* Status Badge */}
								<div
									className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${statusInfo.bgColor}`}
								>
									{statusInfo.icon}
									<span
										className={`text-sm font-medium ${statusInfo.color}`}
									>
										{statusInfo.text}
									</span>
								</div>
							</div>

							{/* Description */}
							<p className="mt-4 text-foreground/70 text-lg leading-relaxed max-w-3xl">
								{agent.description || "No description provided"}
							</p>

							{/* Tags - Framework, Protocols, Scope */}
							<div className="mt-6 flex flex-wrap gap-2">
								{/* Framework - What it's built with */}
								<Badge variant="secondary" className="text-sm">
									<Server className="h-3 w-3 mr-1" />
									{framework}
								</Badge>
								{/* Scope */}
								<Badge variant="outline" className="text-sm">
									{agent.scope === "SYSTEM"
										? "System"
										: agent.scope === "ORGANIZATION"
											? "Organization"
											: "Personal"}
								</Badge>
								{/* Protocols - How it communicates */}
								{protocols.map((protocol: string) => (
									<Badge
										key={protocol}
										variant="outline"
										className="text-sm bg-primary/5"
									>
										<Globe className="h-3 w-3 mr-1" />
										{protocol}
									</Badge>
								))}
								{/* Capabilities indicators */}
								{capabilities?.supportsPredictiveState && (
									<Badge
										variant="outline"
										className="text-sm bg-green-500/10 text-green-600 border-green-500/20"
									>
										<Zap className="h-3 w-3 mr-1" />
										Predictive State
									</Badge>
								)}
								{capabilities?.usesOpenAPI && (
									<Badge
										variant="outline"
										className="text-sm bg-primary/10 text-primary border-primary/20"
									>
										<Globe className="h-3 w-3 mr-1" />
										OpenAPI
									</Badge>
								)}
							</div>

							{/* Action Buttons */}
							<div className="mt-8 flex flex-wrap gap-3">
								<Button
									size="lg"
									onClick={handleTryAgent}
									disabled={agent.status !== "ACTIVE"}
								>
									<PlayIcon className="h-4 w-4 mr-2" />
									Try Agent
									<ArrowRightIcon className="h-4 w-4 ml-2" />
								</Button>

								{agent.deploymentUrl && (
									<Button variant="outline" size="lg" asChild>
										<a
											href={agent.deploymentUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											<ExternalLink className="h-4 w-4 mr-2" />
											View Deployment
										</a>
									</Button>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Tabs Section */}
			<div className="container py-8">
				<Tabs defaultValue="overview">
					<TabsList className="mb-6">
						<TabsTrigger value="overview">Overview</TabsTrigger>
						{hasInstance && (
							<TabsTrigger value="versions">
								<History className="h-3.5 w-3.5 mr-1.5" />
								Version History
							</TabsTrigger>
						)}
						{hasInstance && (
							<TabsTrigger value="insights">
								<BarChart3 className="h-3.5 w-3.5 mr-1.5" />
								Insights
							</TabsTrigger>
						)}
					</TabsList>

					{/* Overview Tab */}
					<TabsContent value="overview">
						<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
							{/* Main Content */}
							<div className="lg:col-span-2 space-y-6">
								{/* Capabilities/Skills */}
								{selectedCapabilities.length > 0 && (
									<Card>
										<CardHeader>
											<CardTitle className="flex items-center gap-2">
												<Zap className="h-5 w-5" />
												Capabilities
											</CardTitle>
											<CardDescription>
												What this agent can do for you
											</CardDescription>
										</CardHeader>
										<CardContent>
											<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
												{selectedCapabilities.map(
													(
														capability,
														index: number,
													) => {
														// Built-in capability: use its defined icon + bg
														if (
															capability.kind ===
															"capability"
														) {
															const builtIn =
																getBuiltInCapability(
																	capability.id,
																);
															return (
																<div
																	key={
																		capability.id ||
																		index
																	}
																	className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
																>
																	<div
																		className={`h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0 ${builtIn?.iconBgClassName ?? "bg-primary/10"}`}
																	>
																		{getCapabilityIcon(
																			capability.id,
																			"h-4 w-4 text-foreground",
																		)}
																	</div>
																	<div className="min-w-0">
																		<div className="font-medium text-sm">
																			{
																				capability.name
																			}
																		</div>
																		{capability.description && (
																			<div className="text-xs text-muted-foreground mt-0.5">
																				{
																					capability.description
																				}
																			</div>
																		)}
																	</div>
																</div>
															);
														}
														// Skill: check plugin registry for integration brand icon
														const plugin =
															getSkillIntegration(
																capability.id,
															);
														if (plugin) {
															const IntIcon =
																plugin.icon;
															return (
																<div
																	key={
																		capability.id ||
																		index
																	}
																	className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
																>
																	<div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
																		<IntIcon
																			className={`h-4 w-4 ${plugin.color ?? "text-foreground"}`}
																		/>
																	</div>
																	<div className="min-w-0">
																		<div className="font-medium text-sm">
																			{
																				capability.name
																			}
																		</div>
																		{capability.description && (
																			<div className="text-xs text-muted-foreground mt-0.5">
																				{
																					capability.description
																				}
																			</div>
																		)}
																	</div>
																</div>
															);
														}
														// Default skill: puzzle icon
														return (
															<div
																key={
																	capability.id ||
																	index
																}
																className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
															>
																<div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
																	<PuzzleIcon className="h-4 w-4 text-muted-foreground" />
																</div>
																<div className="min-w-0">
																	<div className="font-medium text-sm">
																		{
																			capability.name
																		}
																	</div>
																	{capability.description && (
																		<div className="text-xs text-muted-foreground mt-0.5">
																			{
																				capability.description
																			}
																		</div>
																	)}
																</div>
															</div>
														);
													},
												)}
											</div>
										</CardContent>
									</Card>
								)}

								{/* About */}
								<Card>
									<CardHeader>
										<CardTitle className="flex items-center gap-2">
											<FileText className="h-5 w-5" />
											About
										</CardTitle>
									</CardHeader>
									<CardContent className="space-y-4">
										<div>
											<h4 className="text-sm font-medium text-muted-foreground mb-1">
												Description
											</h4>
											<p className="text-foreground">
												{agent.description ||
													"No description available."}
											</p>
										</div>

										{metadata?.author && (
											<div>
												<h4 className="text-sm font-medium text-muted-foreground mb-1">
													Author
												</h4>
												<p className="text-foreground">
													{String(metadata.author)}
												</p>
											</div>
										)}

										{metadata?.version && (
											<div>
												<h4 className="text-sm font-medium text-muted-foreground mb-1">
													Version
												</h4>
												<p className="text-foreground font-mono">
													{String(metadata.version)}
												</p>
											</div>
										)}
									</CardContent>
								</Card>
							</div>

							{/* Sidebar */}
							<div className="space-y-6">
								{/* Technical Details */}
								<Card>
									<CardHeader>
										<CardTitle className="flex items-center gap-2 text-lg">
											<Settings className="h-5 w-5" />
											Technical Details
										</CardTitle>
									</CardHeader>
									<CardContent className="space-y-4">
										<div className="flex justify-between items-center">
											<span className="text-sm text-muted-foreground">
												Framework
											</span>
											<Badge variant="secondary">
												{framework}
											</Badge>
										</div>
										<Separator />
										<div className="flex justify-between items-center">
											<span className="text-sm text-muted-foreground">
												Scope
											</span>
											<span className="text-sm font-medium">
												{agent.scope === "SYSTEM"
													? "System"
													: agent.scope ===
															"ORGANIZATION"
														? "Organization"
														: "Personal"}
											</span>
										</div>
										<Separator />
										<div className="flex justify-between items-center">
											<span className="text-sm text-muted-foreground">
												Status
											</span>
											<div className="flex items-center gap-1.5">
												{statusInfo.icon}
												<span
													className={`text-sm font-medium ${statusInfo.color}`}
												>
													{statusInfo.text}
												</span>
											</div>
										</div>
										{agent.lastHealthCheck && (
											<>
												<Separator />
												<div className="flex justify-between items-center">
													<span className="text-sm text-muted-foreground">
														Last Health Check
													</span>
													<span className="text-sm">
														{new Date(
															agent.lastHealthCheck,
														).toLocaleDateString()}
													</span>
												</div>
											</>
										)}
										{agent.deploymentUrl && (
											<>
												<Separator />
												<div>
													<span className="text-sm text-muted-foreground block mb-1">
														Deployment URL
													</span>
													<a
														href={
															agent.deploymentUrl
														}
														target="_blank"
														rel="noopener noreferrer"
														className="text-sm text-primary hover:underline break-all"
													>
														{agent.deploymentUrl}
													</a>
												</div>
											</>
										)}
									</CardContent>
								</Card>

								{/* Protocols - How the agent communicates */}
								{protocols.length > 0 && (
									<Card>
										<CardHeader>
											<CardTitle className="flex items-center gap-2 text-lg">
												<Shield className="h-5 w-5" />
												Protocols
											</CardTitle>
											<CardDescription>
												Communication protocols
												supported
											</CardDescription>
										</CardHeader>
										<CardContent>
											<div className="space-y-2">
												{protocols.map(
													(protocol: string) => {
														const protocolInfo =
															getProtocolInfo(
																protocol,
															);
														return (
															<div
																key={protocol}
																className="flex items-start gap-2 p-2 rounded-lg bg-muted/50"
															>
																<Globe className="h-4 w-4 text-muted-foreground mt-0.5" />
																<div>
																	<span className="text-sm font-medium">
																		{
																			protocol
																		}
																	</span>
																	{protocolInfo && (
																		<p className="text-[10px] text-muted-foreground">
																			{
																				protocolInfo
																			}
																		</p>
																	)}
																</div>
															</div>
														);
													},
												)}
											</div>
										</CardContent>
									</Card>
								)}

								{/* Quick Actions */}
								<Card>
									<CardHeader>
										<CardTitle className="flex items-center gap-2 text-lg">
											<MessageSquare className="h-5 w-5" />
											Quick Actions
										</CardTitle>
									</CardHeader>
									<CardContent className="space-y-2">
										<Button
											className="w-full justify-start"
											variant="outline"
											onClick={handleTryAgent}
											disabled={agent.status !== "ACTIVE"}
										>
											<PlayIcon className="h-4 w-4 mr-2" />
											Try Agent
										</Button>
										{agent.deploymentUrl && (
											<Button
												className="w-full justify-start"
												variant="outline"
												asChild
											>
												<a
													href={agent.deploymentUrl}
													target="_blank"
													rel="noopener noreferrer"
												>
													<ExternalLink className="h-4 w-4 mr-2" />
													Open Deployment
												</a>
											</Button>
										)}
									</CardContent>
								</Card>
							</div>
						</div>
					</TabsContent>

					{/* Version History Tab */}
					{hasInstance && instanceId && instanceSId && (
						<TabsContent value="versions">
							<VersionHistoryTab
								instanceSId={instanceSId}
								organizationId={organizationId ?? undefined}
							/>
						</TabsContent>
					)}

					{/* Insights Tab */}
					{hasInstance && instanceId && (
						<TabsContent value="insights">
							<InsightsTab
								instanceId={instanceId}
								organizationId={organizationId ?? undefined}
							/>
						</TabsContent>
					)}
				</Tabs>
			</div>
		</div>
	);
}
