"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
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
	ExternalLinkIcon,
	HelpCircleIcon,
	KeyRoundIcon,
	LaptopIcon,
	PlusCircleIcon,
	ServerIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_PRESET_URLS = new Set([
	"http://localhost:9100",
	"http://127.0.0.1:9100",
	"http://[::1]:9100",
]);

function normalizeLoopbackHost(hostname?: string): string | null {
	if (!hostname) {
		return null;
	}
	const trimmed = hostname.trim().toLowerCase();
	if (!trimmed) {
		return null;
	}
	return trimmed === "::1" ? "[::1]" : trimmed;
}

export function resolvePersonalLoopbackUrl(portalHostname?: string): string {
	const host = normalizeLoopbackHost(portalHostname);
	if (host === "127.0.0.1") {
		return "http://127.0.0.1:9100";
	}
	if (host === "[::1]") {
		return "http://[::1]:9100";
	}
	return "http://localhost:9100";
}

export function getLoopbackHostMismatchUrl(
	candidateUrl: string,
	portalHostname?: string,
): string | null {
	const portalHost = normalizeLoopbackHost(portalHostname);
	if (!portalHost || !LOOPBACK_HOSTS.has(portalHost)) {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(candidateUrl.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}
	const candidateHost = normalizeLoopbackHost(parsed.hostname);
	if (
		!candidateHost ||
		!LOOPBACK_HOSTS.has(candidateHost) ||
		candidateHost === portalHost
	) {
		return null;
	}
	parsed.hostname = portalHost;
	return parsed.pathname === "/" && !parsed.search && !parsed.hash
		? parsed.origin
		: parsed.href;
}

function generateServerSecret(): string {
	const bytes = new Uint8Array(24);
	if (typeof crypto !== "undefined" && crypto.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return `fab_srv_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface RemoteAgentServerOption {
	id: string;
	name: string;
	scope: string;
	url: string;
	ownedByCaller: boolean;
}

export function RemoteAgentServerPicker({
	projectId,
	organizationId,
	servers,
	canShare,
	value,
	onChange,
}: {
	projectId: string;
	organizationId?: string | null;
	servers: RemoteAgentServerOption[];
	canShare: boolean;
	value: string;
	onChange: (id: string) => void;
}) {
	const t = useTranslations("projects.remoteAgents");
	const id = useId();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState("");
	const [scope, setScope] = useState<"PRIVATE" | "TEAM">("PRIVATE");
	const [scopeFilter, setScopeFilter] = useState<"ALL" | "PRIVATE" | "TEAM">(
		"ALL",
	);
	const [portalHostname, setPortalHostname] = useState<string | undefined>(
		undefined,
	);

	useEffect(() => {
		setPortalHostname(window.location.hostname);
	}, []);

	const personalPresetUrl = resolvePersonalLoopbackUrl(portalHostname);
	const personalPresetHostPort = personalPresetUrl.replace(
		/^https?:\/\//,
		"",
	);
	const suggestedLoopbackUrl = getLoopbackHostMismatchUrl(
		url,
		portalHostname,
	);

	const selected = servers.find((server) => server.id === value);
	const privateServers = servers.filter(
		(server) => server.scope === "PRIVATE",
	);
	const teamServers = servers.filter((server) => server.scope === "TEAM");
	const visibleServers = servers.filter((server) => {
		if (scopeFilter === "ALL") {
			return true;
		}
		return server.scope === scopeFilter;
	});

	const connect = useMutation({
		mutationFn: () =>
			orpcClient.codingRuns.remoteServers.connect({
				projectId,
				organizationId,
				name,
				url,
				secret,
				scope,
			}),
		onSuccess: async (server) => {
			setSecret("");
			setName("");
			setUrl("");
			await queryClient.invalidateQueries({
				queryKey: ["remoteAgentServers", projectId],
			});
			onChange(server.id);
		},
	});
	const disconnect = useMutation({
		mutationFn: () =>
			orpcClient.codingRuns.remoteServers.disconnect({
				projectId,
				organizationId,
				id: value,
			}),
		onSuccess: async () => {
			onChange("");
			await queryClient.invalidateQueries({
				queryKey: ["remoteAgentServers", projectId],
			});
		},
	});

	const applyLocalPreset = () => {
		if (!name.trim()) {
			setName("Personal Fabric Agents Remote Server");
		}
		const currentHostname =
			typeof window === "undefined"
				? portalHostname
				: window.location.hostname;
		setUrl(resolvePersonalLoopbackUrl(currentHostname));
		setScope("PRIVATE");
		if (secret.length < 32) {
			setSecret(generateServerSecret());
		}
	};

	const applyTeamPreset = () => {
		if (!name.trim()) {
			setName("Organization Fabric Agents Remote Server");
		}
		if (!url.trim() || LOOPBACK_PRESET_URLS.has(url.trim())) {
			setUrl("https://agents.example.com");
		}
		if (canShare) {
			setScope("TEAM");
		}
		if (secret.length < 32) {
			setSecret(generateServerSecret());
		}
	};

	return (
		<section
			className="space-y-3 rounded-lg border border-border/70 bg-background p-4"
			aria-label={t("title")}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<ServerIcon className="size-4 text-primary" />
					<Label
						htmlFor={`${id}-server`}
						className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
					>
						{t("title")}
					</Label>
					<TooltipProvider delayDuration={150}>
						<Tooltip>
							<TooltipTrigger asChild>
								<a
									href="/docs/features/projects#personal-vs-organization-remote-servers"
									target="_blank"
									rel="noopener noreferrer"
									data-testid="remote-server-picker-docs-link"
									aria-label="Personal and Organization Fabric Agents Remote Server documentation"
									className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
								>
									<HelpCircleIcon className="size-3" />
									Docs
								</a>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs space-y-1 text-xs leading-relaxed">
								<p className="font-semibold">
									Personal vs. Organization Remote Servers
								</p>
								<p>
									Register multiple Personal servers (
									<code>PRIVATE</code>, visible only to you)
									or shared Organization servers (
									<code>TEAM</code>). Click to open the full
									setup guide.
								</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>

				<div className="inline-flex max-w-full flex-wrap items-center rounded-md border border-border/70 bg-muted/30 p-0.5 text-xs">
					<button
						type="button"
						onClick={() => setScopeFilter("ALL")}
						className={cn(
							"rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
							scopeFilter === "ALL"
								? "bg-background text-foreground shadow-2xs"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						All ({servers.length})
					</button>
					<button
						type="button"
						onClick={() => setScopeFilter("PRIVATE")}
						className={cn(
							"inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
							scopeFilter === "PRIVATE"
								? "bg-background text-foreground shadow-2xs"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<LaptopIcon className="size-3" />
						Personal ({privateServers.length})
					</button>
					<button
						type="button"
						onClick={() => setScopeFilter("TEAM")}
						className={cn(
							"inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
							scopeFilter === "TEAM"
								? "bg-background text-foreground shadow-2xs"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<Building2Icon className="size-3" />
						Organization ({teamServers.length})
					</button>
				</div>
			</div>

			{/* Visual quick-select server cards */}
			{visibleServers.length > 0 && (
				<div className="grid auto-rows-fr gap-2 sm:grid-cols-2">
					{visibleServers.map((server) => {
						const isSelected = server.id === value;
						const isTeam = server.scope === "TEAM";
						return (
							<button
								key={server.id}
								type="button"
								onClick={() =>
									onChange(isSelected ? "" : server.id)
								}
								aria-pressed={isSelected}
								className={cn(
									"flex h-full flex-col justify-between gap-1.5 rounded-lg border p-3 text-left transition-all",
									isSelected
										? "border-primary bg-primary/[0.05] ring-1 ring-primary/30"
										: "border-border/60 bg-muted/15 hover:border-border hover:bg-muted/35",
								)}
							>
								<div className="flex items-start justify-between gap-2">
									<div className="flex min-w-0 items-center gap-1.5">
										{isTeam ? (
											<Building2Icon className="size-3.5 shrink-0 text-primary" />
										) : (
											<LaptopIcon className="size-3.5 shrink-0 text-primary" />
										)}
										<span className="font-semibold text-xs leading-snug text-foreground">
											{server.name}
										</span>
									</div>
									{isSelected && (
										<CheckCircle2Icon className="size-3.5 shrink-0 text-primary" />
									)}
								</div>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="break-all font-mono text-[11px] text-muted-foreground">
										{server.url}
									</span>
									<Badge
										variant="outline"
										className="shrink-0 rounded-full px-1.5 py-0 text-[10px]"
									>
										{isTeam
											? "Organization Remote Server"
											: "Personal Remote Server"}
									</Badge>
								</div>
							</button>
						);
					})}
				</div>
			)}

			<select
				id={`${id}-server`}
				className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-2xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			>
				<option value="">{t("choose")}</option>
				<optgroup label={t("mine")}>
					{privateServers.map((server) => (
						<option key={server.id} value={server.id}>
							{server.name}
						</option>
					))}
				</optgroup>
				<optgroup label={t("team")}>
					{teamServers.map((server) => (
						<option key={server.id} value={server.id}>
							{server.name}
						</option>
					))}
				</optgroup>
			</select>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-xs leading-5 text-muted-foreground">
					{selected
						? t(
								selected.scope === "TEAM"
									? "teamHelp"
									: "privateHelp",
							)
						: t("emptyHelp")}
				</p>
				<div className="flex items-center gap-2">
					{selected && (
						<Button
							asChild
							variant="outline"
							size="sm"
							className="h-7 gap-1.5 px-2.5 text-xs"
						>
							<a
								href={selected.url}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLinkIcon className="size-3" />
								{t("openServer")}
							</a>
						</Button>
					)}
					{selected &&
						(selected.scope === "PRIVATE"
							? selected.ownedByCaller
							: canShare) && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 gap-1 px-2.5 text-xs text-muted-foreground hover:text-destructive"
								loading={disconnect.isPending}
								onClick={() => disconnect.mutate()}
							>
								<Trash2Icon className="size-3" />
								{t("disconnect")}
							</Button>
						)}
				</div>
			</div>

			<details
				open={servers.length === 0}
				className="group rounded-md border border-dashed border-border/80 bg-muted/15 px-3 py-2"
			>
				<summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-xs font-medium text-foreground">
					<span className="inline-flex items-center gap-1.5 underline underline-offset-4">
						<PlusCircleIcon className="size-3.5 text-primary" />
						{t("connect")}
					</span>
					<span className="text-[11px] text-muted-foreground">
						Personal Remote Server (:9100) or Organization Remote
						Server
					</span>
				</summary>
				<div className="mt-3 space-y-3 border-t border-border/60 pt-3">
					<p className="text-xs leading-5 text-muted-foreground">
						{t("connectionHelp")}
					</p>
					<ol className="list-decimal space-y-1 rounded-md border border-border/60 bg-background/80 p-2.5 pl-6 text-[11px] leading-5 text-muted-foreground">
						<li>
							Start your{" "}
							<code className="font-mono text-foreground">
								fabric-agent-server
							</code>{" "}
							or open <strong>Fabric Agents Desktop</strong> and
							enable <strong>Execution Bridge</strong> in
							Settings.
						</li>
						<li>
							Copy the endpoint URL (e.g.{" "}
							<code className="font-mono text-foreground">
								{personalPresetUrl}
							</code>{" "}
							for a Personal Fabric Agents Remote Server or{" "}
							<code className="font-mono text-foreground">
								https://agents.example.com
							</code>{" "}
							for a personal tunnel or Organization Fabric Agents
							Remote Server) and the 32+ character shared secret.
						</li>
						<li>
							Verify and connect below so this project can
							dispatch coding runs directly using your
							subscription tokens.
						</li>
					</ol>

					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[11px] font-medium text-muted-foreground">
							Quick presets:
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 gap-1.5 px-2.5 text-xs"
							onClick={applyLocalPreset}
						>
							<LaptopIcon className="size-3 text-primary" />
							Personal Fabric Agents Remote Server (
							{personalPresetHostPort})
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 gap-1.5 px-2.5 text-xs"
							onClick={applyTeamPreset}
						>
							<Building2Icon className="size-3 text-primary" />
							Organization Fabric Agents Remote Server
						</Button>
					</div>

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-name`} className="text-xs">
								{t("name")}
							</Label>
							<Input
								id={`${id}-name`}
								value={name}
								placeholder="e.g. My MacBook Pro or Team GPU Node"
								onChange={(event) =>
									setName(event.target.value)
								}
								maxLength={80}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-url`} className="text-xs">
								{t("url")}
							</Label>
							<Input
								id={`${id}-url`}
								type="url"
								placeholder="https://agents.example.com"
								value={url}
								onChange={(event) => setUrl(event.target.value)}
							/>
							{suggestedLoopbackUrl && (
								<div
									data-testid="loopback-host-mismatch-hint"
									className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
								>
									<span>
										Match this tab&apos;s loopback hostname
										so embedded Server Web UI sessions keep
										their{" "}
										<code className="font-mono text-foreground">
											SameSite=Strict
										</code>{" "}
										sign-in cookie.
									</span>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-6 px-2 text-xs"
										onClick={() =>
											setUrl(suggestedLoopbackUrl)
										}
									>
										Use {suggestedLoopbackUrl}
									</Button>
								</div>
							)}
						</div>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<div className="flex items-center justify-between gap-2">
								<Label
									htmlFor={`${id}-secret`}
									className="text-xs"
								>
									{t("secret")}
								</Label>
								<button
									type="button"
									onClick={() =>
										setSecret(generateServerSecret())
									}
									className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
								>
									<KeyRoundIcon className="size-3" />
									Generate token
								</button>
							</div>
							<Input
								id={`${id}-secret`}
								type="password"
								autoComplete="new-password"
								placeholder="32+ character execution service secret"
								value={secret}
								onChange={(event) =>
									setSecret(event.target.value)
								}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-scope`} className="text-xs">
								{t("visibility")}
							</Label>
							<select
								id={`${id}-scope`}
								className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
								value={scope}
								onChange={(event) =>
									setScope(
										event.target.value as
											| "PRIVATE"
											| "TEAM",
									)
								}
							>
								<option value="PRIVATE">{t("mine")}</option>
								{canShare && (
									<option value="TEAM">{t("team")}</option>
								)}
							</select>
						</div>
					</div>

					<div className="space-y-2 text-sm text-muted-foreground">
						<p>{t("setupHelp")}</p>
						<a
							className="inline-flex items-center gap-1 text-primary underline underline-offset-4"
							href="/docs/features/projects#personal-vs-organization-remote-servers"
							target="_blank"
							rel="noopener noreferrer"
						>
							<ExternalLinkIcon className="size-3.5" />
							{t("setupGuide")}
						</a>
					</div>

					<Button
						type="button"
						size="sm"
						disabled={!name.trim() || !url || secret.length < 32}
						loading={connect.isPending}
						onClick={() => connect.mutate()}
					>
						{t("verify")}
					</Button>
				</div>
			</details>
			{(connect.error || disconnect.error) && (
				<p role="alert" className="text-sm text-destructive">
					{(connect.error || disconnect.error)?.message}
				</p>
			)}
		</section>
	);
}
