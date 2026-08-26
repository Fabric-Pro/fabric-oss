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
import { useQuery } from "@tanstack/react-query";
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
import {
	AlertCircle,
	ArrowLeft,
	ArrowRightIcon,
	CheckCircleIcon,
	Clock,
	ExternalLink,
	FileText,
	Globe,
	LoaderIcon,
	MessageSquare,
	PlayIcon,
	Server,
	Settings,
	Shield,
	XCircleIcon,
	Zap,
} from "lucide-react";
import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";

function getSkillIntegration(id: string) {
	const normalized = id.toUpperCase().replace(/[\s-]+/g, "_");
	return (
		getIntegration(normalized as Parameters<typeof getIntegration>[0]) ??
		null
	);
}

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

/**
 * Organization Agent Details Page
 *
 * Displays comprehensive information about an agent including:
 * - Hero section with agent icon/image
 * - Agent metadata (name, description, framework, status)
 * - Protocols supported (A2A, AG-UI, etc.)
 * - Skills/capabilities
 * - "Try Agent" button that routes appropriately
 */
export default function OrganizationAgentDetailsPage() {
	const params = useParams();
	const router = useRouter();
	const agentId = params.agentId as string;
	const { basePath } = useOrganizationContext();

	const agentsBasePath = `${basePath}/agents`;

	// CUIDs are 25-char lowercase alphanumeric — these are template instance IDs.
	// Registered agents use slug-format agentIds (e.g. "deep-researcher", "prompt_enhancer").
	// Skip the registry lookup entirely for instance IDs to avoid a 404 console error.
	const isInstanceId =
		agentId.length >= 20 && /^[a-z][a-z0-9]+$/.test(agentId);

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
		enabled: !isInstanceId,
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

	// Extract capabilities and skills using the shared helper
	const skills = useMemo(() => {
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

	// Extract protocols from metadata
	const protocols = useMemo(() => {
		if (metadata?.protocols) {
			return Array.isArray(metadata.protocols) ? metadata.protocols : [];
		}
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

	const framework = useMemo(() => {
		return agent?.framework || "Unknown";
	}, [agent]);

	const heroImage = useMemo(() => {
		if (!agent) {
			return "";
		}
		return (
			(metadata as any)?.heroImageUrl ||
			generateHeroImage({
				name: agent.displayName,
				category: (metadata as any)?.category || agent.framework,
			})
		);
	}, [agent, metadata]);

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
					icon: <XCircleIcon className="h-4 w-4 text-red-500" />,
					text: "Error",
					color: "text-red-600",
					bgColor: "bg-red-500/10",
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
		router.push(`${agentsBasePath}/${agentId}/${routingInfo.route}`);
	};

	// Render instance view immediately — no registry query needed
	if (isInstanceId) {
		return <AgentInstanceDetail instanceId={agentId} basePath={basePath} />;
	}

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
			return (
				<AgentInstanceDetail instanceId={agentId} basePath={basePath} />
			);
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
						onClick={() => router.push(agentsBasePath)}
					>
						<ArrowLeft className="h-4 w-4 mr-2" />
						Back to Agents
					</Button>
				</div>
			</div>
		);
	}

	const statusInfo = getStatusInfo();

	return (
		<div className="min-h-screen">
			{/* Hero Section */}
			<div className="relative overflow-hidden bg-gradient-to-b from-card via-background to-background">
				<div className="pointer-events-none absolute inset-0 overflow-hidden">
					<div
						className="absolute top-10 -left-40 h-[500px] w-[500px] animate-pulse rounded-full bg-gradient-to-r from-purple-500/20 to-pink-500/15 blur-[100px]"
						style={{ animationDuration: "4s" }}
					/>
					<div
						className="absolute top-20 -right-40 h-[400px] w-[400px] animate-pulse rounded-full bg-gradient-to-l from-violet-500/15 to-purple-500/10 blur-[80px]"
						style={{
							animationDelay: "1s",
							animationDuration: "5s",
						}}
					/>
				</div>

				<div className="container relative z-10 py-8">
					<div className="mb-6">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => router.push(agentsBasePath)}
						>
							<ArrowLeft className="h-4 w-4 mr-2" />
							Back to Agents
						</Button>
					</div>

					<div className="flex flex-col lg:flex-row gap-8 items-start">
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

							<p className="mt-4 text-foreground/70 text-lg leading-relaxed max-w-3xl">
								{agent.description || "No description provided"}
							</p>

							<div className="mt-6 flex flex-wrap gap-2">
								<Badge variant="secondary" className="text-sm">
									<Server className="h-3 w-3 mr-1" />
									{framework}
								</Badge>
								<Badge variant="outline" className="text-sm">
									{agent.scope === "SYSTEM"
										? "System"
										: agent.scope === "ORGANIZATION"
											? "Organization"
											: "Personal"}
								</Badge>
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
							</div>

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

			{/* Details Section */}
			<div className="container py-8">
				<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
					<div className="lg:col-span-2 space-y-6">
						{skills.length > 0 && (
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
										{skills.map((skill, index) => {
											if (skill.kind === "capability") {
												const builtIn =
													getBuiltInCapability(
														skill.id,
													);
												return (
													<div
														key={skill.id || index}
														className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
													>
														<div
															className={`h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0 ${builtIn?.iconBgClassName ?? "bg-primary/10"}`}
														>
															{getCapabilityIcon(
																skill.id,
																"h-4 w-4 text-foreground",
															)}
														</div>
														<div className="min-w-0">
															<div className="font-medium text-sm">
																{skill.name}
															</div>
															{skill.description && (
																<div className="text-xs text-muted-foreground mt-0.5">
																	{
																		skill.description
																	}
																</div>
															)}
														</div>
													</div>
												);
											}
											const integration =
												getSkillIntegration(skill.id);
											if (integration) {
												const IntIcon =
													integration.icon;
												return (
													<div
														key={skill.id || index}
														className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
													>
														<div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
															<IntIcon
																className={`h-4 w-4 ${integration.color ?? "text-foreground"}`}
															/>
														</div>
														<div className="min-w-0">
															<div className="font-medium text-sm">
																{skill.name}
															</div>
															{skill.description && (
																<div className="text-xs text-muted-foreground mt-0.5">
																	{
																		skill.description
																	}
																</div>
															)}
														</div>
													</div>
												);
											}
											return (
												<div
													key={skill.id || index}
													className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
												>
													<div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
														<PuzzleIcon className="h-4 w-4 text-muted-foreground" />
													</div>
													<div className="min-w-0">
														<div className="font-medium text-sm">
															{skill.name}
														</div>
														{skill.description && (
															<div className="text-xs text-muted-foreground mt-0.5">
																{
																	skill.description
																}
															</div>
														)}
													</div>
												</div>
											);
										})}
									</div>
								</CardContent>
							</Card>
						)}

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
											{metadata.author}
										</p>
									</div>
								)}
								{metadata?.version && (
									<div>
										<h4 className="text-sm font-medium text-muted-foreground mb-1">
											Version
										</h4>
										<p className="text-foreground font-mono">
											{metadata.version}
										</p>
									</div>
								)}
							</CardContent>
						</Card>
					</div>

					<div className="space-y-6">
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
											: agent.scope === "ORGANIZATION"
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
							</CardContent>
						</Card>

						{protocols.length > 0 && (
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2 text-lg">
										<Shield className="h-5 w-5" />
										Protocols
									</CardTitle>
									<CardDescription>
										Communication protocols supported
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										{protocols.map((protocol: string) => {
											const protocolInfo =
												getProtocolInfo(protocol);
											return (
												<div
													key={protocol}
													className="flex items-start gap-2 p-2 rounded-lg bg-muted/50"
												>
													<Globe className="h-4 w-4 text-muted-foreground mt-0.5" />
													<div>
														<span className="text-sm font-medium">
															{protocol}
														</span>
														{protocolInfo && (
															<p className="text-[10px] text-muted-foreground">
																{protocolInfo}
															</p>
														)}
													</div>
												</div>
											);
										})}
									</div>
								</CardContent>
							</Card>
						)}

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
							</CardContent>
						</Card>
					</div>
				</div>
			</div>
		</div>
	);
}
