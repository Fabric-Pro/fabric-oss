"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import { gatewayUrl } from "@saas/projects/components/cli-connection/lib/agent-sign-in";
import {
	buildFabricDesktopNewSessionUrl,
	buildFabricDesktopViewUrl,
	loadProjectDelegationPreferences,
	saveProjectDelegationPreferences,
} from "@saas/projects/lib/implementation-session-labels";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	CopyIcon,
	ExternalLinkIcon,
	KeyRoundIcon,
	LaptopIcon,
	ServerIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { RemoteAgentServerPicker } from "./RemoteAgentServerPicker";

export interface LaunchFabricDesktopBarProps {
	projectId: string;
	projectName: string;
	organizationId?: string | null;
	prompt?: string | null;
	webUiUrl?: string | null;
	compact?: boolean;
	className?: string;
}

/** Desktop setup and the same authorized server registry used by Start work. */
export function LaunchFabricDesktopBar({
	projectId,
	projectName,
	organizationId: organizationIdProp,
	prompt,
	compact = false,
	className,
}: LaunchFabricDesktopBarProps) {
	const t = useTranslations("projects.remoteAgents.launcher");
	const context = useOrganizationContext();
	const organizationId =
		organizationIdProp === undefined
			? context.organizationId
			: organizationIdProp;
	const basePath = context.organizationSlug
		? `/app/${encodeURIComponent(context.organizationSlug)}`
		: null;
	const panelId = useId();
	const [origin, setOrigin] = useState("");
	const [connectOpen, setConnectOpen] = useState(false);
	const [panel, setPanel] = useState<"desktop" | "sources" | "remote" | null>(
		null,
	);
	const [selected, setSelected] = useState("");
	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);

	useEffect(() => {
		setSelected(
			loadProjectDelegationPreferences(projectId).preferredServerId ?? "",
		);
	}, [projectId]);
	const servers = useQuery({
		queryKey: ["remoteAgentServers", projectId, organizationId],
		queryFn: () =>
			orpcClient.codingRuns.remoteServers.list({
				projectId,
				organizationId,
			}),
		enabled: panel === "remote" && Boolean(organizationId),
		retry: false,
		gcTime: 0,
	});
	const selectedServer = servers.data?.servers.find(
		(server) => server.id === selected,
	);
	const chooseServer = (id: string) => {
		setSelected(id);
		const server = servers.data?.servers.find((item) => item.id === id);
		saveProjectDelegationPreferences(projectId, {
			...loadProjectDelegationPreferences(projectId),
			preferredServerId: id,
			...(server
				? {
						preferredServerScope:
							server.scope === "TEAM" ? "TEAM" : "PRIVATE",
					}
				: {}),
		});
	};
	// Only a registered server can supply a Web UI target. Never put tasks or tokens in its URL.
	let serverUrl: string | null = null;
	if (selectedServer) {
		try {
			const url = new URL(selectedServer.url);
			if (
				(url.protocol === "https:" || url.protocol === "http:") &&
				!url.username &&
				!url.password
			) {
				url.search = "";
				url.hash = "";
				serverUrl = url.href;
			}
		} catch {
			/* A malformed address cannot become a launch link. */
		}
	}
	const desktopUrl =
		panel === "sources"
			? buildFabricDesktopViewUrl("sources")
			: buildFabricDesktopNewSessionUrl({
					projectId,
					projectName,
					origin: origin || null,
					prompt,
				});
	const mcpGateway = origin ? gatewayUrl(origin, projectId) : "";
	const copyGateway = async () => {
		try {
			if (!mcpGateway || !navigator.clipboard) {
				throw new Error("Clipboard unavailable");
			}
			await navigator.clipboard.writeText(mcpGateway);
			toast.success(t("copied"));
		} catch {
			toast.error(t("copyFailed"));
		}
	};
	const toggle = (next: typeof panel) =>
		setPanel((current) => (current === next ? null : next));
	return (
		<section
			className={cn(
				"rounded-lg border border-border bg-card",
				compact ? "p-3" : "p-4",
				className,
			)}
			data-testid="launch-fabric-desktop-bar"
		>
			<div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
				<div className="min-w-0 space-y-1">
					<h3 className="flex items-center gap-2 text-sm font-semibold">
						<LaptopIcon className="size-4 shrink-0 text-primary" />
						{t("title")}
					</h3>
					<p className="max-w-prose text-sm text-muted-foreground">
						{t("description")}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						onClick={() => toggle("desktop")}
						aria-expanded={panel === "desktop"}
						aria-controls={panelId}
						data-testid="launch-fabric-desktop-button"
					>
						<LaptopIcon className="mr-1.5 size-4" />
						{t("launch")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => toggle("remote")}
						aria-expanded={panel === "remote"}
						aria-controls={panelId}
						data-testid="delegate-remote-agent-server-button"
					>
						<ServerIcon className="mr-1.5 size-4" />
						{t("delegate")}
					</Button>
					{basePath && (
						<Button asChild variant="outline" size="sm">
							<a
								href={`${basePath}/settings/ai-providers`}
								data-testid="launch-fabric-desktop-ai-settings"
							>
								<SlidersHorizontalIcon className="mr-1.5 size-4" />
								{t("ai")}
							</a>
						</Button>
					)}
					{!compact && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => toggle("sources")}
							aria-expanded={panel === "sources"}
							aria-controls={panelId}
							data-testid="launch-fabric-desktop-sources"
						>
							{t("sources")}
						</Button>
					)}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!organizationId}
						onClick={() => setConnectOpen(true)}
						data-testid="launch-fabric-desktop-sso"
					>
						<KeyRoundIcon className="mr-1.5 size-4" />
						{t("signIn")}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={copyGateway}
						disabled={!mcpGateway}
					>
						<CopyIcon className="mr-1.5 size-4" />
						{t("copy")}
					</Button>
				</div>
			</div>
			{panel && (
				<div
					id={panelId}
					className="mt-4 space-y-3 border-t border-border pt-4"
				>
					{panel === "remote" ? (
						<div
							data-testid="remote-server-delegation-panel"
							className="space-y-3"
						>
							<p className="max-w-prose text-sm text-muted-foreground">
								{t("remoteHelp")}
							</p>
							{!organizationId ? (
								<p role="alert">{t("organizationRequired")}</p>
							) : servers.isPending ? (
								<output>{t("loading")}</output>
							) : servers.isError ? (
								<div role="alert" className="space-y-2">
									<p className="text-sm text-destructive">
										{t("loadFailed")}
									</p>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => servers.refetch()}
									>
										{t("retry")}
									</Button>
								</div>
							) : !servers.data?.enabled ? (
								<output className="text-sm text-muted-foreground">
									{t("disabled")}
								</output>
							) : (
								<>
									<RemoteAgentServerPicker
										key={`${organizationId}:${projectId}`}
										projectId={projectId}
										organizationId={organizationId}
										servers={servers.data.servers}
										canShare={servers.data.canShare}
										value={selectedServer?.id ?? ""}
										onChange={chooseServer}
									/>
									<div className="flex flex-wrap gap-2">
										{basePath && (
											<Button asChild size="sm">
												<a
													href={`${basePath}/projects/${encodeURIComponent(projectId)}?tab=stories`}
												>
													{t("chooseFeature")}
												</a>
											</Button>
										)}
										{serverUrl && (
											<Button
												asChild
												variant="outline"
												size="sm"
											>
												<a
													href={serverUrl}
													target="_blank"
													rel="noopener noreferrer"
													data-testid="open-remote-server-webui-link"
												>
													<ExternalLinkIcon className="mr-1.5 size-4" />
													{t("openRemote")}
												</a>
											</Button>
										)}
									</div>
								</>
							)}
						</div>
					) : (
						<div
							className="space-y-3"
							data-testid="desktop-launch-help"
						>
							<p className="max-w-prose text-sm text-muted-foreground">
								{panel === "sources"
									? t("sourcesHelp")
									: t("desktopHelp")}
							</p>
							<div className="flex flex-wrap gap-2">
								<Button asChild size="sm">
									<a href={desktopUrl}>
										{t("openInstalled")}
									</a>
								</Button>
								<Button asChild variant="outline" size="sm">
									<a
										href="https://agents.fabric.pro"
										target="_blank"
										rel="noopener noreferrer"
									>
										{t("getDesktop")}
									</a>
								</Button>
								<Button asChild variant="ghost" size="sm">
									<a
										href={buildFabricDesktopViewUrl(
											"settings",
										)}
									>
										{t("desktopAi")}
									</a>
								</Button>
							</div>
							<p className="max-w-prose text-xs text-muted-foreground">
								{t("aiHelp")}
							</p>
						</div>
					)}
				</div>
			)}
			{connectOpen && organizationId && (
				<ConnectCliDialog
					open={connectOpen}
					onOpenChange={setConnectOpen}
					organizationId={organizationId}
					projectId={projectId}
					projectName={projectName}
					purpose="project"
				/>
			)}
		</section>
	);
}
