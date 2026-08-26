"use client";

/**
 * Register External Agent Page
 *
 * Allows users to register external agents (A2A or MCP) to be used
 * by Fabric Loom for task delegation or tool access.
 *
 * Agent Types:
 * - A2A: Full task-executing agents that support the A2A protocol
 * - MCP: Tool-providing agents that expose MCP tools
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
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
	AlertTriangle,
	ArrowRight,
	Bot,
	CheckCircle2,
	Loader2,
	Network,
	Search,
	Shield,
	Wrench,
	XCircle,
	Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

type AgentType = "A2A" | "MCP";
type DiscoveryStatus = "idle" | "discovering" | "success" | "error";

interface DiscoveryResult {
	valid: boolean;
	agentCard: {
		name: string;
		description: string;
		url: string;
		protocolVersion: string;
		capabilities?: {
			streaming?: boolean;
		};
		skills: Array<{
			id: string;
			name: string;
			description: string;
		}>;
	} | null;
	protocolVersion: string | null;
	healthy: boolean;
	responseTime: number;
	registrationData: {
		name: string;
		displayName: string;
		description: string;
		capabilities: string[];
		skills: Array<{
			id: string;
			name: string;
			description: string;
		}>;
		supportsStreaming: boolean;
	} | null;
	validation: {
		agentCard: boolean;
		sendMessage: boolean;
		streaming: boolean;
		taskManagement: boolean;
		errors: string[];
	};
}

export default function RegisterAgentPage() {
	const router = useRouter();
	const { organizationId, organizationSlug, organizationName, basePath } =
		useOrganizationContext();

	// Agent type state
	const [agentType, setAgentType] = useState<AgentType>("A2A");

	// Form state
	const [deploymentUrl, setDeploymentUrl] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [description, setDescription] = useState("");
	const [scope, setScope] = useState<"user" | "organization">("user");

	// MCP-specific state
	const [mcpName, setMcpName] = useState("");

	// Discovery state
	const [discoveryStatus, setDiscoveryStatus] =
		useState<DiscoveryStatus>("idle");
	const [discoveryResult, setDiscoveryResult] =
		useState<DiscoveryResult | null>(null);

	// Discover mutation
	const discoverMutation = useMutation({
		mutationFn: async (url: string) => {
			setDiscoveryStatus("discovering");
			const result = await orpcClient.agents.registry.discoverA2A({
				deploymentUrl: url,
				timeout: 15000,
			});
			return result as unknown as DiscoveryResult;
		},
		onSuccess: (result) => {
			setDiscoveryResult(result);
			setDiscoveryStatus(result.valid ? "success" : "error");

			// Pre-fill form with discovered data
			if (result.registrationData) {
				setDisplayName(result.registrationData.displayName);
				setDescription(result.registrationData.description);
			}
		},
		onError: (error) => {
			setDiscoveryStatus("error");
			setDiscoveryResult(null);
			toast.error(`Discovery failed: ${error.message}`);
		},
	});

	// Register mutation
	const registerMutation = useMutation({
		mutationFn: async () => {
			if (agentType === "A2A") {
				if (!discoveryResult?.valid) {
					throw new Error("Agent not validated");
				}

				// Create A2A agent in registry
				const result = await orpcClient.agents.registry.create({
					name: discoveryResult.agentCard?.name ?? "",
					displayName:
						displayName ||
						discoveryResult.registrationData?.displayName ||
						"",
					description:
						description ||
						discoveryResult.registrationData?.description ||
						"",
					framework: "A2A",
					deploymentUrl,
					scope: scope.toUpperCase() as "USER" | "ORGANIZATION",
					organizationId:
						scope === "organization"
							? (organizationId ?? undefined)
							: undefined,
					config: {
						capabilities:
							discoveryResult.registrationData?.capabilities,
						skills: discoveryResult.registrationData?.skills,
						supportsStreaming:
							discoveryResult.registrationData?.supportsStreaming,
						protocolVersion: discoveryResult.protocolVersion,
					},
					metadata: {
						agentCard: discoveryResult.agentCard,
					},
				});

				return result;
			}
			// Create MCP agent in registry (tool provider)
			if (!mcpName || !deploymentUrl) {
				throw new Error("Name and URL are required for MCP agents");
			}

			const result = await orpcClient.agents.registry.create({
				name: mcpName.toLowerCase().replace(/\s+/g, "-"),
				displayName: displayName || mcpName,
				description:
					description || `MCP tool provider at ${deploymentUrl}`,
				framework: "MCP",
				deploymentUrl,
				scope: scope.toUpperCase() as "USER" | "ORGANIZATION",
				organizationId:
					scope === "organization"
						? (organizationId ?? undefined)
						: undefined,
				config: {
					transport: "HTTP", // Default to HTTP transport
				},
				metadata: {
					frameworkType: "tool-provider",
				},
			});

			return result;
		},
		onSuccess: () => {
			toast.success("Agent registered successfully!");
			router.push("/app/agents");
		},
		onError: (error) => {
			toast.error(`Registration failed: ${error.message}`);
		},
	});

	const handleDiscover = () => {
		if (!deploymentUrl) {
			toast.error("Please enter a deployment URL");
			return;
		}

		discoverMutation.mutate(deploymentUrl);
	};

	const handleRegister = () => {
		registerMutation.mutate();
	};

	const breadcrumbItems = [
		...(organizationSlug
			? [
					{
						label: "Organization",
						href: basePath,
					},
				]
			: []),
		{ label: "AI Agents", href: `${basePath}/agents` },
		{ label: "Register Agent" },
	];

	// Reset form when agent type changes
	const handleAgentTypeChange = (type: AgentType) => {
		setAgentType(type);
		setDiscoveryStatus("idle");
		setDiscoveryResult(null);
		setDisplayName("");
		setDescription("");
		setMcpName("");
	};

	return (
		<div className="container max-w-6xl py-8 space-y-8">
			<PageBreadcrumbs items={breadcrumbItems} />

			<div className="rounded-3xl border border-border/70 bg-[radial-gradient(circle_at_top_left,rgba(244,114,182,0.12),transparent_32%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] p-8">
				<div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
					<div className="space-y-3">
						<Badge variant="outline" className="w-fit">
							Agent Registry
						</Badge>
						<div className="space-y-2">
							<h1 className="text-3xl font-bold tracking-tight">
								Register External Agent
							</h1>
							<p className="max-w-2xl text-base text-muted-foreground">
								Add A2A task executors and MCP tool providers to
								the registry so people can inspect them
								internally, review their health, and decide when
								to route work out to hosted runtimes.
							</p>
						</div>
					</div>
					<div className="grid gap-3 sm:grid-cols-3">
						<div className="rounded-2xl border bg-background/60 px-4 py-3">
							<p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
								Primary use
							</p>
							<p className="mt-1 text-sm font-medium">
								Registry-backed details
							</p>
						</div>
						<div className="rounded-2xl border bg-background/60 px-4 py-3">
							<p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
								Protocols
							</p>
							<p className="mt-1 text-sm font-medium">
								A2A and MCP
							</p>
						</div>
						<div className="rounded-2xl border bg-background/60 px-4 py-3">
							<p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
								Outcome
							</p>
							<p className="mt-1 text-sm font-medium">
								Internal detail page first
							</p>
						</div>
					</div>
				</div>
			</div>

			<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
				<div className="space-y-8">
					{/* Agent Type Selection */}
					<Card className="rounded-2xl border-border/70">
						<CardHeader>
							<CardTitle>Agent Type</CardTitle>
							<CardDescription>
								Select the type of agent you want to register
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<button
									type="button"
									onClick={() => handleAgentTypeChange("A2A")}
									className={cn(
										"p-4 rounded-lg border-2 text-left transition-colors",
										agentType === "A2A"
											? "border-primary bg-primary/5"
											: "border-muted hover:border-muted-foreground/50",
									)}
								>
									<div className="flex items-center gap-3 mb-2">
										<div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
											<Network className="h-5 w-5 text-white" />
										</div>
										<div>
											<h3 className="font-semibold">
												A2A Agent
											</h3>
											<p className="text-xs text-muted-foreground">
												Task Executor
											</p>
										</div>
									</div>
									<p className="text-sm text-muted-foreground">
										Full agent supporting A2A protocol. Can
										execute tasks and be delegated work by
										the orchestrator.
									</p>
								</button>

								<button
									type="button"
									onClick={() => handleAgentTypeChange("MCP")}
									className={cn(
										"p-4 rounded-lg border-2 text-left transition-colors",
										agentType === "MCP"
											? "border-primary bg-primary/5"
											: "border-muted hover:border-muted-foreground/50",
									)}
								>
									<div className="flex items-center gap-3 mb-2">
										<div className="h-10 w-10 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
											<Wrench className="h-5 w-5 text-white" />
										</div>
										<div>
											<h3 className="font-semibold">
												MCP Agent
											</h3>
											<p className="text-xs text-muted-foreground">
												Tool Provider
											</p>
										</div>
									</div>
									<p className="text-sm text-muted-foreground">
										MCP server providing tools. Exposes
										tools that other agents can use for
										specific operations.
									</p>
								</button>
							</div>
						</CardContent>
					</Card>

					{/* Step 1: Enter URL (A2A) */}
					{agentType === "A2A" && (
						<Card className="rounded-2xl border-border/70">
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">
										1
									</span>
									Discover Agent
								</CardTitle>
								<CardDescription>
									Enter the deployment URL of your
									A2A-compatible agent. We'll fetch its Agent
									Card and validate protocol support.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="flex gap-2">
									<div className="flex-1">
										<Label
											htmlFor="deploymentUrl"
											className="sr-only"
										>
											Deployment URL
										</Label>
										<Input
											id="deploymentUrl"
											placeholder="https://your-agent.example.com"
											value={deploymentUrl}
											onChange={(e) =>
												setDeploymentUrl(e.target.value)
											}
											disabled={
												discoverMutation.isPending
											}
										/>
									</div>
									<Button
										onClick={handleDiscover}
										disabled={
											!deploymentUrl ||
											discoverMutation.isPending
										}
									>
										{discoverMutation.isPending ? (
											<Loader2 className="h-4 w-4 animate-spin mr-2" />
										) : (
											<Search className="h-4 w-4 mr-2" />
										)}
										Discover
									</Button>
								</div>

								{/* Discovery Result */}
								{discoveryStatus === "discovering" && (
									<Alert>
										<Loader2 className="h-4 w-4 animate-spin" />
										<AlertTitle>
											Discovering Agent
										</AlertTitle>
										<AlertDescription>
											Fetching Agent Card from{" "}
											{deploymentUrl}...
										</AlertDescription>
									</Alert>
								)}

								{discoveryStatus === "error" && (
									<Alert variant="error">
										<XCircle className="h-4 w-4" />
										<AlertTitle>
											Discovery Failed
										</AlertTitle>
										<AlertDescription>
											{discoveryResult?.validation.errors.join(
												", ",
											) ||
												"Could not reach the agent or invalid A2A protocol."}
										</AlertDescription>
									</Alert>
								)}

								{discoveryStatus === "success" &&
									discoveryResult?.valid && (
										<Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30">
											<CheckCircle2 className="h-4 w-4 text-green-600" />
											<AlertTitle className="text-green-700 dark:text-green-400">
												Agent Discovered Successfully
											</AlertTitle>
											<AlertDescription className="text-green-600 dark:text-green-500">
												Found "
												{
													discoveryResult.agentCard
														?.name
												}
												" (A2A v
												{
													discoveryResult.protocolVersion
												}
												)
											</AlertDescription>
										</Alert>
									)}
							</CardContent>
						</Card>
					)}

					{/* Step 2: Agent Details (shown after successful discovery) - A2A only */}
					{agentType === "A2A" &&
						discoveryStatus === "success" &&
						discoveryResult?.valid && (
							<Card className="rounded-2xl border-border/70">
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">
											2
										</span>
										Agent Details
									</CardTitle>
									<CardDescription>
										Review and customize the agent
										configuration before registering.
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-6">
									{/* Agent Card Preview */}
									<div className="rounded-lg border bg-muted/30 p-4 space-y-4">
										<div className="flex items-start gap-3">
											<div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
												<Bot className="h-5 w-5 text-white" />
											</div>
											<div className="flex-1">
												<h3 className="font-semibold">
													{
														discoveryResult
															.agentCard?.name
													}
												</h3>
												<p className="text-sm text-muted-foreground">
													{
														discoveryResult
															.agentCard
															?.description
													}
												</p>
											</div>
										</div>

										<div className="flex flex-wrap gap-2">
											<Badge
												variant="outline"
												className="text-xs"
											>
												A2A v
												{
													discoveryResult.protocolVersion
												}
											</Badge>
											{discoveryResult.registrationData
												?.supportsStreaming && (
												<Badge
													variant="secondary"
													className="text-xs"
												>
													<Zap className="h-3 w-3 mr-1" />
													Streaming
												</Badge>
											)}
											{discoveryResult.healthy && (
												<Badge
													variant="secondary"
													className="text-xs bg-green-100 text-green-700"
												>
													<CheckCircle2 className="h-3 w-3 mr-1" />
													Healthy
												</Badge>
											)}
											<Badge
												variant="outline"
												className="text-xs"
											>
												{discoveryResult.responseTime}ms
											</Badge>
										</div>

										{/* Skills */}
										{(discoveryResult.registrationData
											?.skills?.length ?? 0) > 0 && (
											<div>
												<p className="text-xs font-medium text-muted-foreground mb-2">
													Skills
												</p>
												<div className="space-y-1">
													{discoveryResult.registrationData?.skills?.map(
														(skill) => (
															<div
																key={skill.id}
																className="text-sm flex items-start gap-2"
															>
																<ArrowRight className="h-3 w-3 mt-1 text-muted-foreground" />
																<div>
																	<span className="font-medium">
																		{
																			skill.name
																		}
																	</span>
																	<span className="text-muted-foreground">
																		{" "}
																		-{" "}
																		{
																			skill.description
																		}
																	</span>
																</div>
															</div>
														),
													)}
												</div>
											</div>
										)}
									</div>

									{/* Customization Form */}
									<div className="space-y-4">
										<div className="grid gap-4 sm:grid-cols-2">
											<div className="space-y-2">
												<Label htmlFor="displayName">
													Display Name
												</Label>
												<Input
													id="displayName"
													value={displayName}
													onChange={(e) =>
														setDisplayName(
															e.target.value,
														)
													}
													placeholder={
														discoveryResult
															.registrationData
															?.displayName
													}
												/>
											</div>

											<div className="space-y-2">
												<Label htmlFor="scope">
													Visibility
												</Label>
												<Select
													value={scope}
													onValueChange={(v) =>
														setScope(
															v as
																| "user"
																| "organization",
														)
													}
												>
													<SelectTrigger>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="user">
															<div className="flex items-center gap-2">
																<Shield className="h-4 w-4" />
																Personal (Only
																Me)
															</div>
														</SelectItem>
														{organizationId && (
															<SelectItem value="organization">
																<div className="flex items-center gap-2">
																	<Shield className="h-4 w-4" />
																	Organization
																	(
																	{
																		organizationName
																	}
																	)
																</div>
															</SelectItem>
														)}
													</SelectContent>
												</Select>
											</div>
										</div>

										<div className="space-y-2">
											<Label htmlFor="description">
												Description
											</Label>
											<Textarea
												id="description"
												value={description}
												onChange={(e) =>
													setDescription(
														e.target.value,
													)
												}
												placeholder={
													discoveryResult
														.registrationData
														?.description
												}
												rows={3}
											/>
										</div>
									</div>
								</CardContent>
							</Card>
						)}

					{/* Step 3: Register (A2A) */}
					{agentType === "A2A" &&
						discoveryStatus === "success" &&
						discoveryResult?.valid && (
							<Card className="rounded-2xl border-border/70">
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">
											3
										</span>
										Register Agent
									</CardTitle>
									<CardDescription>
										Once registered, this agent will be
										available to Fabric Loom for task
										delegation.
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="flex justify-end gap-2">
										<Button
											variant="outline"
											onClick={() =>
												router.push(
													`${basePath}/agents`,
												)
											}
										>
											Cancel
										</Button>
										<Button
											onClick={handleRegister}
											disabled={
												registerMutation.isPending
											}
										>
											{registerMutation.isPending ? (
												<Loader2 className="h-4 w-4 animate-spin mr-2" />
											) : (
												<CheckCircle2 className="h-4 w-4 mr-2" />
											)}
											Register Agent
										</Button>
									</div>
								</CardContent>
							</Card>
						)}

					{/* MCP Agent Registration Form */}
					{agentType === "MCP" && (
						<>
							<Card className="rounded-2xl border-border/70">
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">
											1
										</span>
										MCP Server Details
									</CardTitle>
									<CardDescription>
										Enter the details of your MCP server to
										register it as a tool provider.
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="space-y-2">
										<Label htmlFor="mcpName">
											Server Name
										</Label>
										<Input
											id="mcpName"
											placeholder="my-mcp-server"
											value={mcpName}
											onChange={(e) =>
												setMcpName(e.target.value)
											}
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="mcpUrl">
											Server URL
										</Label>
										<Input
											id="mcpUrl"
											placeholder="https://your-mcp-server.example.com"
											value={deploymentUrl}
											onChange={(e) =>
												setDeploymentUrl(e.target.value)
											}
										/>
									</div>

									<div className="grid gap-4 sm:grid-cols-2">
										<div className="space-y-2">
											<Label htmlFor="mcpDisplayName">
												Display Name
											</Label>
											<Input
												id="mcpDisplayName"
												placeholder="My MCP Server"
												value={displayName}
												onChange={(e) =>
													setDisplayName(
														e.target.value,
													)
												}
											/>
										</div>

										<div className="space-y-2">
											<Label htmlFor="mcpScope">
												Visibility
											</Label>
											<Select
												value={scope}
												onValueChange={(v) =>
													setScope(
														v as
															| "user"
															| "organization",
													)
												}
											>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="user">
														<div className="flex items-center gap-2">
															<Shield className="h-4 w-4" />
															Personal (Only Me)
														</div>
													</SelectItem>
													{organizationId && (
														<SelectItem value="organization">
															<div className="flex items-center gap-2">
																<Shield className="h-4 w-4" />
																Organization (
																{
																	organizationName
																}
																)
															</div>
														</SelectItem>
													)}
												</SelectContent>
											</Select>
										</div>
									</div>

									<div className="space-y-2">
										<Label htmlFor="mcpDescription">
											Description
										</Label>
										<Textarea
											id="mcpDescription"
											value={description}
											onChange={(e) =>
												setDescription(e.target.value)
											}
											placeholder="Describe what tools this MCP server provides..."
											rows={3}
										/>
									</div>
								</CardContent>
							</Card>

							<Card className="rounded-2xl border-border/70">
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">
											2
										</span>
										Register MCP Server
									</CardTitle>
									<CardDescription>
										Once registered, this MCP server's tools
										will be available to agents.
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="flex justify-end gap-2">
										<Button
											variant="outline"
											onClick={() =>
												router.push(
													`${basePath}/agents`,
												)
											}
										>
											Cancel
										</Button>
										<Button
											onClick={handleRegister}
											disabled={
												!mcpName ||
												!deploymentUrl ||
												registerMutation.isPending
											}
										>
											{registerMutation.isPending ? (
												<Loader2 className="h-4 w-4 animate-spin mr-2" />
											) : (
												<CheckCircle2 className="h-4 w-4 mr-2" />
											)}
											Register MCP Server
										</Button>
									</div>
								</CardContent>
							</Card>
						</>
					)}

					{/* Protocol Info (A2A) */}
					{agentType === "A2A" && (
						<Card className="rounded-2xl border-border/70 bg-muted/30">
							<CardHeader>
								<CardTitle className="text-base flex items-center gap-2">
									<AlertTriangle className="h-4 w-4" />
									A2A Protocol Requirements
								</CardTitle>
							</CardHeader>
							<CardContent className="text-sm text-muted-foreground space-y-2">
								<p>
									Your agent must implement the A2A
									(Agent2Agent) protocol:
								</p>
								<ul className="list-disc list-inside space-y-1 ml-2">
									<li>
										Serve an Agent Card at{" "}
										<code className="text-xs bg-muted px-1 py-0.5 rounded">
											/.well-known/agent.json
										</code>
									</li>
									<li>
										Handle messages at{" "}
										<code className="text-xs bg-muted px-1 py-0.5 rounded">
											POST /a2a/send
										</code>
									</li>
									<li>
										Return task status at{" "}
										<code className="text-xs bg-muted px-1 py-0.5 rounded">
											GET /a2a/tasks/{"{id}"}
										</code>
									</li>
								</ul>
								<p className="mt-4">
									See the{" "}
									<a
										href="https://a2a-protocol.org"
										target="_blank"
										rel="noopener noreferrer"
										className="text-primary underline"
									>
										A2A Protocol documentation
									</a>{" "}
									for implementation details.
								</p>
							</CardContent>
						</Card>
					)}

					{/* Protocol Info (MCP) */}
					{agentType === "MCP" && (
						<Card className="rounded-2xl border-border/70 bg-muted/30">
							<CardHeader>
								<CardTitle className="text-base flex items-center gap-2">
									<AlertTriangle className="h-4 w-4" />
									MCP Server Requirements
								</CardTitle>
							</CardHeader>
							<CardContent className="text-sm text-muted-foreground space-y-2">
								<p>
									Your MCP server must implement the MCP
									(Model Context Protocol):
								</p>
								<ul className="list-disc list-inside space-y-1 ml-2">
									<li>Support HTTP or SSE transport</li>
									<li>
										Expose tools via the MCP tools/list
										endpoint
									</li>
									<li>
										Handle tool calls via the MCP tools/call
										endpoint
									</li>
								</ul>
								<p className="mt-4">
									See the{" "}
									<a
										href="https://modelcontextprotocol.io"
										target="_blank"
										rel="noopener noreferrer"
										className="text-primary underline"
									>
										MCP Protocol documentation
									</a>{" "}
									for implementation details.
								</p>
							</CardContent>
						</Card>
					)}
				</div>

				<div className="space-y-4">
					<Card className="rounded-2xl border-border/70">
						<CardHeader>
							<CardTitle className="text-base">
								What Happens After Registration
							</CardTitle>
							<CardDescription>
								Registry entries are now meant to be inspected
								inside Fabric before anyone opens the hosted
								runtime directly.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-3 text-sm text-muted-foreground">
							<p>
								Clicking a registered agent opens its internal
								detail page, where people can review metadata,
								health, and connection information.
							</p>
							<p>
								Deployment URLs stay available as explicit
								actions on the detail page instead of surprise
								navigation from the grid.
							</p>
						</CardContent>
					</Card>

					<Card className="rounded-2xl border-border/70">
						<CardHeader>
							<CardTitle className="text-base">
								Choose The Right Registry Entry
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3 text-sm">
							<div className="rounded-xl border bg-muted/30 p-3">
								<p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
									A2A Agent
								</p>
								<p className="mt-1">
									Use for externally hosted agents that can
									accept delegated tasks and expose an Agent
									Card.
								</p>
							</div>
							<div className="rounded-xl border bg-muted/30 p-3">
								<p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
									MCP Agent
								</p>
								<p className="mt-1">
									Use for external tool servers that should
									make capabilities available to agents during
									a run.
								</p>
							</div>
							<div className="rounded-xl border bg-muted/30 p-3">
								<p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
									Registry UX
								</p>
								<p className="mt-1">
									Internal details first, explicit external
									open second. That keeps the registry
									inspectable and consistent with the rest of
									Fabric.
								</p>
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
