"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import {
	Building2Icon,
	CheckCircle2Icon,
	ExternalLinkIcon,
	LaptopIcon,
	PlusCircleIcon,
	ServerIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

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
	hasDefaultServer = false,
	value,
	onChange,
}: {
	projectId: string;
	organizationId?: string | null;
	servers: RemoteAgentServerOption[];
	canShare: boolean;
	hasDefaultServer?: boolean;
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
			setName("Local Fabric Agents Workstation");
		}
		setUrl("http://127.0.0.1:9100");
		setScope("PRIVATE");
	};

	const applyTeamPreset = () => {
		if (!name.trim()) {
			setName("Company Fabric Agents Cluster");
		}
		if (!url.trim() || url === "http://127.0.0.1:9100") {
			setUrl("https://agents.example.com");
		}
		if (canShare) {
			setScope("TEAM");
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
				</div>

				<div className="inline-flex items-center rounded-md border border-border/70 bg-muted/30 p-0.5 text-xs">
					<button
						type="button"
						aria-pressed={scopeFilter === "ALL"}
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
						aria-pressed={scopeFilter === "PRIVATE"}
						onClick={() => setScopeFilter("PRIVATE")}
						className={cn(
							"inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
							scopeFilter === "PRIVATE"
								? "bg-background text-foreground shadow-2xs"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<LaptopIcon className="size-3" />
						Local ({privateServers.length})
					</button>
					<button
						type="button"
						aria-pressed={scopeFilter === "TEAM"}
						onClick={() => setScopeFilter("TEAM")}
						className={cn(
							"inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
							scopeFilter === "TEAM"
								? "bg-background text-foreground shadow-2xs"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<Building2Icon className="size-3" />
						Company ({teamServers.length})
					</button>
				</div>
			</div>

			{/* Visual quick-select server cards */}
			{visibleServers.length > 0 && (
				<div className="grid gap-2 sm:grid-cols-2">
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
									"flex flex-col justify-between gap-1.5 rounded-lg border p-3 text-left transition-all",
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
										<span className="truncate text-xs font-semibold text-foreground">
											{server.name}
										</span>
									</div>
									{isSelected && (
										<CheckCircle2Icon className="size-3.5 shrink-0 text-primary" />
									)}
								</div>
								<div className="flex items-center justify-between gap-2">
									<span className="truncate font-mono text-[11px] text-muted-foreground">
										{server.url}
									</span>
									<Badge
										variant="outline"
										className="shrink-0 rounded-full px-1.5 py-0 text-[10px]"
									>
										{isTeam ? "Company" : "Local"}
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
				<option value="">
					{hasDefaultServer ? "Deployment server" : t("choose")}
				</option>
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

			<details className="group rounded-md border border-dashed border-border/80 bg-muted/15 px-3 py-2">
				<summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-foreground">
					<span className="inline-flex items-center gap-1.5 underline underline-offset-4">
						<PlusCircleIcon className="size-3.5 text-primary" />
						{t("connect")}
					</span>
					<span className="text-[11px] text-muted-foreground">
						Local (:9100) or Company Server
					</span>
				</summary>
				<div className="mt-3 space-y-3 border-t border-border/60 pt-3">
					<p className="text-xs leading-5 text-muted-foreground">
						{t("connectionHelp")}
					</p>

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
							Local Workstation (127.0.0.1:9100)
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 gap-1.5 px-2.5 text-xs"
							onClick={applyTeamPreset}
						>
							<Building2Icon className="size-3 text-primary" />
							Company Remote Server
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
						</div>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-secret`} className="text-xs">
								{t("secret")}
							</Label>
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
