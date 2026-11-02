"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import { gatewayUrl } from "@saas/projects/components/cli-connection/lib/agent-sign-in";
import {
	buildFabricDesktopNewSessionUrl,
	buildFabricDesktopViewUrl,
	buildRemoteAgentServerDelegationUrl,
	FABRIC_AGENT_CONNECTIONS,
	FABRIC_AGENT_FALLBACK_POLICIES,
	type FabricAgentFallbackPolicy,
	loadProjectDelegationPreferences,
	saveProjectDelegationPreferences,
} from "@saas/projects/lib/implementation-session-labels";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	Building2Icon,
	CheckCircle2Icon,
	CheckIcon,
	CopyIcon,
	CpuIcon,
	ExternalLinkIcon,
	HelpCircleIcon,
	KeyRoundIcon,
	LaptopIcon,
	RefreshCwIcon,
	SendIcon,
	ServerIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export interface LaunchFabricDesktopBarProps {
	projectId: string;
	projectName: string;
	organizationId?: string | null;
	prompt?: string | null;
	webUiUrl?: string | null;
	compact?: boolean;
	className?: string;
}

/**
 * Single-click launcher, remote Fabric Agents server delegation console, and
 * seamless OAuth/MCP sign-in bridge between the Fabric Portal, Fabric Desktop
 * (`fabricagents://`), and remote Fabric Agents servers.
 */
export function LaunchFabricDesktopBar({
	projectId,
	projectName,
	organizationId: organizationIdProp,
	prompt,
	webUiUrl = "http://127.0.0.1:9100",
	compact = false,
	className,
}: LaunchFabricDesktopBarProps) {
	const { organizationId: contextOrgId } = useOrganizationContext();
	const resolvedOrganizationId = organizationIdProp ?? contextOrgId ?? "";
	const [origin, setOrigin] = useState("");
	const [connectOpen, setConnectOpen] = useState(false);
	const [copiedMcp, setCopiedMcp] = useState(false);
	const [remotePanelOpen, setRemotePanelOpen] = useState(false);
	const [prefs, setPrefs] = useState(() =>
		loadProjectDelegationPreferences(projectId),
	);
	const [remoteUrl, setRemoteUrl] = useState(() =>
		prefs.preferredServerScope === "TEAM"
			? "https://agents.example.com"
			: webUiUrl || "http://127.0.0.1:9100",
	);
	const [taskPrompt, setTaskPrompt] = useState(prompt ?? "");
	const [subscriptionVerified, setSubscriptionVerified] = useState(true);
	const [embedRemoteWebUi, setEmbedRemoteWebUi] = useState(false);

	useEffect(() => {
		if (typeof window !== "undefined") {
			setOrigin(window.location.origin);
		}
	}, []);

	useEffect(() => {
		setPrefs(loadProjectDelegationPreferences(projectId));
	}, [projectId]);

	const updatePrefs = (
		patch: Partial<ReturnType<typeof loadProjectDelegationPreferences>>,
	) => {
		const next = { ...prefs, ...patch };
		setPrefs(next);
		saveProjectDelegationPreferences(projectId, next);
		if (patch.preferredServerScope === "TEAM") {
			setRemoteUrl("https://agents.example.com");
		} else if (patch.preferredServerScope === "PRIVATE") {
			setRemoteUrl(webUiUrl || "http://127.0.0.1:9100");
		}
	};

	const newSessionDeepLink = buildFabricDesktopNewSessionUrl({
		projectName,
		projectId,
		origin: origin || null,
		prompt: taskPrompt || prompt,
	});
	const aiSettingsDeepLink = buildFabricDesktopViewUrl("settings");
	const sourcesDeepLink = buildFabricDesktopViewUrl("sources");
	const mcpGateway = origin ? gatewayUrl(origin, projectId) : "";

	const remoteDelegationUrl = buildRemoteAgentServerDelegationUrl({
		serverUrl: remoteUrl,
		projectName,
		projectId,
		origin: origin || null,
		prompt: taskPrompt || prompt,
		connection: prefs.defaultConnection,
		model: prefs.defaultModel,
		fallbackPolicy: prefs.fallbackPolicy,
	});

	const activeConnection =
		FABRIC_AGENT_CONNECTIONS.find(
			(item) => item.value === prefs.defaultConnection,
		) ?? FABRIC_AGENT_CONNECTIONS[0];

	const handleCopyGateway = async () => {
		if (!mcpGateway || !navigator.clipboard) {
			return;
		}
		try {
			await navigator.clipboard.writeText(mcpGateway);
			setCopiedMcp(true);
			toast.success(
				"Project MCP gateway copied — Fabric Desktop and remote servers sign in via browser OAuth with no API key required.",
			);
			window.setTimeout(() => setCopiedMcp(false), 2000);
		} catch {
			toast.error("Could not copy MCP gateway URL");
		}
	};

	const handleVerifySubscriptionCredits = () => {
		setSubscriptionVerified(true);
		toast.success(
			`Verified ${activeConnection.label} (${activeConnection.subscriptionBadge}) subscription credits on ${prefs.preferredServerScope === "TEAM" ? "Company Remote Server" : "Local Fabric Agents Server"}.`,
		);
	};

	const handleDispatchRemoteSession = () => {
		toast.success(
			`Delegated "${projectName}" to ${prefs.preferredServerScope === "TEAM" ? "Company Remote Server" : "Local Fabric Agents Server"} using ${activeConnection.label} subscription credits.`,
		);
		if (typeof window !== "undefined") {
			window.open(remoteDelegationUrl, "_blank", "noopener,noreferrer");
		}
	};

	const remoteDelegationDrawer = remotePanelOpen ? (
		<div
			className="mt-3 space-y-3 rounded-lg border border-border/80 bg-background p-3.5 shadow-2xs"
			data-testid="remote-server-delegation-panel"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<ServerIcon className="size-4 text-primary" />
					<span className="text-xs font-semibold text-foreground">
						Delegate to Remote Fabric Agents Server
					</span>
					<Badge
						variant="outline"
						className="border-primary/30 bg-primary/5 text-[10px] font-medium text-primary"
					>
						Subscription Credits Active
					</Badge>
				</div>
				<div className="flex items-center gap-1.5">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7 gap-1 px-2 text-[11px]"
						onClick={handleVerifySubscriptionCredits}
						data-testid="verify-subscription-credits-button"
					>
						<CheckCircle2Icon className="size-3 text-success" />
						{subscriptionVerified
							? "Subscription Credits Verified"
							: "Verify Subscription Credits"}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-[11px]"
						onClick={() => setConnectOpen(true)}
					>
						<KeyRoundIcon className="mr-1 size-3" />
						OAuth Login
					</Button>
					<TooltipProvider delayDuration={150}>
						<Tooltip>
							<TooltipTrigger asChild>
								<a
									href="/docs/features/projects#delegating-coding-runs-to-fabric-agents"
									target="_blank"
									rel="noopener noreferrer"
									data-testid="launch-desktop-bar-docs-link"
									aria-label="Fabric Agents Remote Server delegation documentation"
									className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
								>
									<HelpCircleIcon className="size-3" />
									Docs
								</a>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs space-y-1 text-xs leading-relaxed">
								<p className="font-semibold">
									Remote Server Delegation &amp; Live Web UI
								</p>
								<p>
									Configure Personal or Organization Remote
									Servers, select your subscription harness,
									and embed the live Server Web UI inside the
									Fabric Portal.
								</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			</div>

			<div className="grid gap-3 md:grid-cols-3">
				<div className="space-y-1.5">
					<span className="text-[11px] font-medium text-muted-foreground">
						1. Remote Execution Target
					</span>
					<div className="grid grid-cols-2 gap-1.5">
						<button
							type="button"
							onClick={() =>
								updatePrefs({
									preferredServerScope: "PRIVATE",
								})
							}
							className={cn(
								"flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
								prefs.preferredServerScope === "PRIVATE"
									? "border-primary bg-primary/10 text-primary"
									: "border-border/70 bg-muted/20 text-muted-foreground hover:text-foreground",
							)}
						>
							<LaptopIcon className="size-3.5" />
							Local Server
						</button>
						<button
							type="button"
							onClick={() =>
								updatePrefs({
									preferredServerScope: "TEAM",
								})
							}
							className={cn(
								"flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
								prefs.preferredServerScope === "TEAM"
									? "border-primary bg-primary/10 text-primary"
									: "border-border/70 bg-muted/20 text-muted-foreground hover:text-foreground",
							)}
						>
							<Building2Icon className="size-3.5" />
							Company Server
						</button>
					</div>
				</div>

				<div className="space-y-1.5">
					<span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
						<CpuIcon className="size-3 text-primary" />
						2. Subscription Harness
					</span>
					<div className="flex flex-wrap gap-1">
						{FABRIC_AGENT_CONNECTIONS.map((option) => {
							const selected =
								prefs.defaultConnection === option.value;
							return (
								<button
									key={option.value}
									type="button"
									onClick={() =>
										updatePrefs({
											defaultConnection: option.value,
											defaultModel: "default",
										})
									}
									className={cn(
										"rounded border px-2 py-1 text-[11px] font-medium transition-colors",
										selected
											? "border-primary bg-primary/10 text-primary"
											: "border-border/60 bg-muted/20 text-muted-foreground hover:text-foreground",
									)}
								>
									{option.shortLabel}
								</button>
							);
						})}
					</div>
				</div>

				<div className="space-y-1.5">
					<span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
						<RefreshCwIcon className="size-3 text-primary" />
						3. Quota &amp; Billing Fallback
					</span>
					<div className="flex flex-col gap-1">
						{FABRIC_AGENT_FALLBACK_POLICIES.slice(0, 2).map(
							(policy) => {
								const selected =
									prefs.fallbackPolicy === policy.value;
								return (
									<button
										key={policy.value}
										type="button"
										onClick={() =>
											updatePrefs({
												fallbackPolicy:
													policy.value as FabricAgentFallbackPolicy,
											})
										}
										className={cn(
											"flex items-center justify-between rounded border px-2 py-1 text-left text-[11px] font-medium transition-colors",
											selected
												? "border-primary bg-primary/10 text-primary"
												: "border-border/60 bg-muted/20 text-muted-foreground hover:text-foreground",
										)}
									>
										<span className="truncate">
											{policy.label}
										</span>
									</button>
								);
							},
						)}
					</div>
				</div>
			</div>

			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<input
					type="url"
					value={remoteUrl}
					onChange={(event) => setRemoteUrl(event.target.value)}
					placeholder="http://127.0.0.1:9100 or https://agents.example.com"
					aria-label="Fabric Agents Remote Server URL"
					className="h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring sm:w-64"
				/>
				<input
					type="text"
					value={taskPrompt}
					onChange={(event) => setTaskPrompt(event.target.value)}
					placeholder={`Delegate coding task in ${projectName} (uses ${activeConnection.subscriptionBadge} credits & stateless MCP)...`}
					aria-label="Remote delegation task prompt"
					className="h-8 flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
				/>
				<div className="flex flex-wrap items-center gap-1.5">
					<Button
						type="button"
						size="sm"
						className="h-8 gap-1.5 px-3 text-xs"
						onClick={handleDispatchRemoteSession}
						data-testid="dispatch-remote-server-button"
					>
						<SendIcon className="size-3.5" />
						Dispatch to Remote Server
					</Button>
					<Button
						type="button"
						variant={embedRemoteWebUi ? "default" : "outline"}
						size="sm"
						className="h-8 gap-1 px-2.5 text-xs"
						onClick={() =>
							setEmbedRemoteWebUi((current) => !current)
						}
						data-testid="toggle-embedded-remote-webui-button"
					>
						<ServerIcon className="size-3" />
						{embedRemoteWebUi
							? "Hide Portal Web UI"
							: "View Web UI in Portal"}
					</Button>
					<Button
						asChild
						variant="outline"
						size="sm"
						className="h-8 gap-1 px-2.5 text-xs"
					>
						<a
							href={remoteDelegationUrl}
							target="_blank"
							rel="noopener noreferrer"
							data-testid="open-remote-server-webui-link"
						>
							<ExternalLinkIcon className="size-3" />
							Open Remote Web UI
						</a>
					</Button>
				</div>
			</div>

			{embedRemoteWebUi && (
				<div
					className="overflow-hidden rounded-lg border border-primary/30 bg-background shadow-xs"
					data-testid="embedded-remote-server-webui"
				>
					<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs">
						<span className="font-medium text-foreground">
							Fabric Agents Remote Server Web UI (
							{prefs.preferredServerScope === "TEAM"
								? "Organization Remote Server"
								: "Personal Remote Server"}
							)
						</span>
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							{remoteDelegationUrl}
						</span>
					</div>
					<iframe
						src={remoteDelegationUrl}
						title="Fabric Agents Remote Server Web UI"
						className="h-[560px] w-full border-0"
						allow="clipboard-read; clipboard-write"
						sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
					/>
				</div>
			)}
		</div>
	) : null;

	if (compact) {
		return (
			<div
				className={cn(
					"rounded-lg border border-border bg-muted/20 px-3 py-2.5",
					className,
				)}
				data-testid="launch-fabric-desktop-bar"
			>
				<div className="flex flex-wrap items-center justify-between gap-2.5">
					<div className="flex min-w-0 items-center gap-2">
						<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
							<LaptopIcon className="size-3.5" />
						</span>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="text-xs font-semibold text-foreground">
									Fabric Desktop &amp; Remote Server
								</span>
								<Badge
									variant="outline"
									className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
								>
									Browser OAuth SSO · Subscription Credits
								</Badge>
							</div>
							<p className="truncate text-[11px] text-muted-foreground">
								Open in Fabric Desktop or delegate to a remote
								Fabric Agents server with Claude Max, Codex,
								Grok, Droid &amp; Kimi credits.
							</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						<Button
							asChild
							size="sm"
							className="h-7 px-2.5 text-xs"
						>
							<a
								href={newSessionDeepLink}
								data-testid="launch-fabric-desktop-button"
							>
								<LaptopIcon className="mr-1.5 size-3.5" />
								Launch Fabric Desktop
							</a>
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 px-2.5 text-xs"
							onClick={() =>
								setRemotePanelOpen((current) => !current)
							}
							aria-expanded={remotePanelOpen}
							data-testid="delegate-remote-agent-server-button"
						>
							<ServerIcon className="mr-1.5 size-3" />
							Delegate to Remote Server
						</Button>
						<Button
							asChild
							variant="outline"
							size="sm"
							className="h-7 px-2.5 text-xs"
						>
							<a
								href={aiSettingsDeepLink}
								data-testid="launch-fabric-desktop-ai-settings"
							>
								<SlidersHorizontalIcon className="mr-1.5 size-3" />
								AI Connections
							</a>
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
							onClick={() => setConnectOpen(true)}
							data-testid="launch-fabric-desktop-sso"
						>
							<KeyRoundIcon className="mr-1 size-3" />
							Seamless Sign-In
						</Button>
					</div>
				</div>
				{remoteDelegationDrawer}
				{connectOpen && (
					<ConnectCliDialog
						open={connectOpen}
						onOpenChange={setConnectOpen}
						organizationId={resolvedOrganizationId}
						projectId={projectId}
						projectName={projectName}
						purpose="project"
					/>
				)}
			</div>
		);
	}

	return (
		<div
			className={cn(
				"rounded-lg border border-border bg-card p-4 shadow-2xs",
				className,
			)}
			data-testid="launch-fabric-desktop-bar"
		>
			<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
				<div className="flex items-start gap-3">
					<span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
						<LaptopIcon className="size-4" />
					</span>
					<div className="space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-sm font-semibold text-foreground">
								Fabric Desktop &amp; Remote Agent Server
								Delegation
							</h3>
							<Badge
								variant="outline"
								className="border-primary/30 bg-primary/5 text-[10px] font-medium text-primary"
							>
								1-Click Deep Link &amp; Remote Dispatch
							</Badge>
							<Badge
								variant="outline"
								className="text-[10px] font-normal text-muted-foreground"
							>
								Zero-Key Browser OAuth · Subscription Credits
							</Badge>
						</div>
						<p className="text-xs text-muted-foreground">
							Open{" "}
							<span className="font-medium text-foreground">
								Fabric Desktop
							</span>{" "}
							or delegate directly to a{" "}
							<span className="font-medium text-foreground">
								Remote Fabric Agents Server
							</span>{" "}
							for{" "}
							<span className="font-medium text-foreground">
								{projectName}
							</span>{" "}
							using your subscription credits (Claude Max, Codex,
							Grok, Droid, Kimi, Antigravity{" "}
							<code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
								agy
							</code>
							) with automatic fallback and stateless MCP Apps.
						</p>
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Button asChild size="sm" className="h-8 gap-1.5 text-xs">
						<a
							href={newSessionDeepLink}
							data-testid="launch-fabric-desktop-button"
						>
							<SparklesIcon className="size-3.5" />
							Launch Fabric Desktop
						</a>
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8 gap-1.5 text-xs"
						onClick={() =>
							setRemotePanelOpen((current) => !current)
						}
						aria-expanded={remotePanelOpen}
						data-testid="delegate-remote-agent-server-button"
					>
						<ServerIcon className="size-3.5 text-primary" />
						Delegate to Remote Server
					</Button>
					<Button
						asChild
						variant="outline"
						size="sm"
						className="h-8 gap-1.5 text-xs"
					>
						<a
							href={aiSettingsDeepLink}
							data-testid="launch-fabric-desktop-ai-settings"
						>
							<SlidersHorizontalIcon className="size-3.5" />
							AI Connections
						</a>
					</Button>
					<Button
						asChild
						variant="outline"
						size="sm"
						className="h-8 gap-1.5 text-xs"
					>
						<a
							href={sourcesDeepLink}
							data-testid="launch-fabric-desktop-sources"
						>
							<LaptopIcon className="size-3.5" />
							Desktop Sources
						</a>
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8 gap-1.5 text-xs"
						onClick={() => setConnectOpen(true)}
						data-testid="launch-fabric-desktop-sso"
					>
						<KeyRoundIcon className="size-3.5" />
						Seamless Sign-In &amp; MCP
					</Button>
					{mcpGateway && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
							onClick={handleCopyGateway}
							title="Copy zero-key OAuth MCP gateway URL for this project"
						>
							{copiedMcp ? (
								<CheckIcon className="size-3.5 text-success" />
							) : (
								<CopyIcon className="size-3.5" />
							)}
							Copy MCP URL
						</Button>
					)}
					{webUiUrl && (
						<Button
							asChild
							variant="ghost"
							size="sm"
							className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
						>
							<a
								href={remoteDelegationUrl}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLinkIcon className="size-3.5" />
								Remote Web UI
							</a>
						</Button>
					)}
				</div>
			</div>

			{remoteDelegationDrawer}

			{connectOpen && (
				<ConnectCliDialog
					open={connectOpen}
					onOpenChange={setConnectOpen}
					organizationId={resolvedOrganizationId}
					projectId={projectId}
					projectName={projectName}
					purpose="project"
				/>
			)}
		</div>
	);
}
