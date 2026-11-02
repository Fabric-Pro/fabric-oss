"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Building2Icon,
	CheckCircle2Icon,
	CpuIcon,
	LaptopIcon,
	RefreshCwIcon,
	ServerCogIcon,
	ShieldCheckIcon,
	SparklesIcon,
	TerminalIcon,
	WorkflowIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	DEFAULT_PROJECT_DELEGATION_PREFERENCES,
	FABRIC_AGENT_CONNECTIONS,
	FABRIC_AGENT_FALLBACK_POLICIES,
	type FabricAgentFallbackPolicy,
	getExecutionProviderDescription,
	getExecutionProviderLabel,
	getExecutionProviderPlatformLabel,
	getFabricAgentConnectionModels,
	loadProjectDelegationPreferences,
	type ProjectDelegationPreferences,
	saveProjectDelegationPreferences,
} from "../lib/implementation-session-labels";
import { RemoteAgentServerPicker } from "./coding-runs/RemoteAgentServerPicker";

interface ProjectImplementationDefaultsSettingsProps {
	project: {
		id: string;
		organizationId?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
	};
}

export function ProjectImplementationDefaultsSettings({
	project,
}: ProjectImplementationDefaultsSettingsProps) {
	const hasRepositoryContext =
		!!project.repositoryOwner && !!project.repositoryName;

	const [prefs, setPrefs] = useState<ProjectDelegationPreferences>(
		DEFAULT_PROJECT_DELEGATION_PREFERENCES,
	);
	const [selectedServerId, setSelectedServerId] = useState("");

	useEffect(() => {
		const loaded = loadProjectDelegationPreferences(project.id);
		setPrefs(loaded);
		setSelectedServerId(loaded.preferredServerId ?? "");
	}, [project.id]);

	const serversQuery = useQuery({
		queryKey: ["remoteAgentServers", project.id, project.organizationId],
		queryFn: () =>
			orpcClient.codingRuns.remoteServers.list({
				projectId: project.id,
				organizationId: project.organizationId,
			}),
		retry: false,
	});

	const activeConnection =
		FABRIC_AGENT_CONNECTIONS.find(
			(item) => item.value === prefs.defaultConnection,
		) ?? FABRIC_AGENT_CONNECTIONS[0];
	const availableModels = getFabricAgentConnectionModels(
		prefs.defaultConnection,
	);

	const updatePrefs = (next: Partial<ProjectDelegationPreferences>) => {
		setPrefs((prev) => {
			const updated: ProjectDelegationPreferences = {
				...prev,
				...next,
			};
			saveProjectDelegationPreferences(project.id, updated);
			return updated;
		});
	};

	const toggleFallbackHarness = (harnessValue: string) => {
		const exists = prefs.fallbackHarnesses.includes(harnessValue);
		const nextChain = exists
			? prefs.fallbackHarnesses.filter((item) => item !== harnessValue)
			: [...prefs.fallbackHarnesses, harnessValue];
		if (nextChain.length === 0) {
			return;
		}
		updatePrefs({ fallbackHarnesses: nextChain });
	};

	const handleSaveDefaults = () => {
		saveProjectDelegationPreferences(project.id, prefs);
		toast.success("Saved Fabric Agents delegation defaults", {
			description:
				"New coding runs in this project will pre-select your chosen server target, subscription harness, model, and fallback policy.",
		});
	};

	return (
		<Card className="border-border/80 shadow-xs">
			<div className="space-y-6 p-6 sm:p-8">
				{/* Header */}
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex items-start gap-3.5">
						<div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
							<WorkflowIcon className="size-5" />
						</div>
						<div className="space-y-1">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="text-lg font-semibold tracking-tight text-foreground">
									Fabric Agents Remote Server &amp; Fabric
									Agents Desktop Delegation
								</h3>
								<Badge
									variant="outline"
									className="rounded-full border-primary/25 bg-primary/5 px-2.5 py-0.5 text-[11px] text-primary"
								>
									Subscription Offload Ready
								</Badge>
							</div>
							<p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
								Delegate coding tasks to{" "}
								<strong>Fabric Agents Desktop</strong>, a{" "}
								<strong>
									Personal Fabric Agents Remote Server
								</strong>
								, or an{" "}
								<strong>
									Organization Fabric Agents Remote Server
								</strong>{" "}
								using your CLI subscriptions (Claude, Codex,
								ChatGPT Plus/Pro, Droid, Grok, Kimi,
								Antigravity, Cursor), and choose how runs behave
								when subscription quotas are reached.
							</p>
						</div>
					</div>
					<Button
						type="button"
						size="sm"
						onClick={handleSaveDefaults}
					>
						Save delegation defaults
					</Button>
				</div>

				{/* Step 1: Execution Target Mode (Personal vs Organization Fabric Agents Remote Server) */}
				<div className="space-y-3 rounded-lg border border-border/70 bg-muted/15 p-4">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							1. Default Fabric Agents Remote Server target
						</p>
						<Badge
							variant="secondary"
							className="rounded-full text-[11px]"
						>
							{prefs.preferredServerScope === "PRIVATE"
								? "Personal Fabric Agents Remote Server"
								: "Organization Fabric Agents Remote Server"}
						</Badge>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<button
							type="button"
							onClick={() =>
								updatePrefs({ preferredServerScope: "PRIVATE" })
							}
							aria-pressed={
								prefs.preferredServerScope === "PRIVATE"
							}
							className={`flex items-start justify-between gap-3 rounded-lg border p-3.5 text-left transition-all ${
								prefs.preferredServerScope === "PRIVATE"
									? "border-primary bg-primary/[0.06] ring-1 ring-primary/25"
									: "border-border/70 bg-background hover:border-border"
							}`}
						>
							<div className="space-y-1">
								<p className="flex items-center gap-2 text-sm font-semibold text-foreground">
									<LaptopIcon className="size-4 text-primary" />
									Personal Fabric Agents Remote Server
								</p>
								<p className="text-xs leading-5 text-muted-foreground">
									Delegate tasks to{" "}
									<code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
										127.0.0.1:9100
									</code>{" "}
									or your personal Fabric Agents Remote Server
									using your own signed-in subscription
									tokens.
								</p>
							</div>
							{prefs.preferredServerScope === "PRIVATE" && (
								<CheckCircle2Icon className="size-4 shrink-0 text-primary" />
							)}
						</button>

						<button
							type="button"
							onClick={() =>
								updatePrefs({ preferredServerScope: "TEAM" })
							}
							aria-pressed={prefs.preferredServerScope === "TEAM"}
							className={`flex items-start justify-between gap-3 rounded-lg border p-3.5 text-left transition-all ${
								prefs.preferredServerScope === "TEAM"
									? "border-primary bg-primary/[0.06] ring-1 ring-primary/25"
									: "border-border/70 bg-background hover:border-border"
							}`}
						>
							<div className="space-y-1">
								<p className="flex items-center gap-2 text-sm font-semibold text-foreground">
									<Building2Icon className="size-4 text-primary" />
									Organization Fabric Agents Remote Server
								</p>
								<p className="text-xs leading-5 text-muted-foreground">
									Run coding sessions on your organization’s
									shared{" "}
									{getExecutionProviderLabel(
										"BACKGROUND_AGENTS",
									)}{" "}
									remote server with isolated git worktrees
									and pooled subscription seats.
								</p>
							</div>
							{prefs.preferredServerScope === "TEAM" && (
								<CheckCircle2Icon className="size-4 shrink-0 text-primary" />
							)}
						</button>
					</div>

					{serversQuery.data?.enabled && (
						<div className="pt-2">
							<RemoteAgentServerPicker
								projectId={project.id}
								organizationId={project.organizationId}
								servers={serversQuery.data.servers}
								canShare={serversQuery.data.canShare}
								value={selectedServerId}
								onChange={(id) => {
									setSelectedServerId(id);
									updatePrefs({ preferredServerId: id });
								}}
							/>
						</div>
					)}
				</div>

				{/* Step 2: Subscription Harness & Pre-Configured Models */}
				<div className="space-y-3 rounded-lg border border-border/70 bg-muted/15 p-4">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<CpuIcon className="size-4 text-primary" />
							<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								2. Default subscription harness &amp; model
							</p>
						</div>
						<Badge
							variant="outline"
							className="rounded-full px-2.5 py-0.5 text-[11px]"
						>
							{activeConnection.subscriptionBadge}
						</Badge>
					</div>

					<div className="flex flex-wrap gap-1.5">
						{FABRIC_AGENT_CONNECTIONS.map((option) => {
							const isSelected =
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
									className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
										isSelected
											? "border-primary bg-primary/10 text-primary"
											: "border-border/70 bg-background text-foreground/80 hover:border-border hover:bg-muted/40"
									}`}
								>
									<span>{option.label}</span>
								</button>
							);
						})}
					</div>

					<div className="grid gap-3 sm:grid-cols-2">
						<div>
							<label
								htmlFor="project-default-harness-select"
								className="text-xs font-medium text-muted-foreground"
							>
								Primary subscription harness
							</label>
							<select
								id="project-default-harness-select"
								aria-label="Primary subscription harness"
								value={prefs.defaultConnection}
								onChange={(event) =>
									updatePrefs({
										defaultConnection: event.target.value,
										defaultModel: "default",
									})
								}
								className="mt-1 flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm text-foreground shadow-2xs"
							>
								{FABRIC_AGENT_CONNECTIONS.map((option) => (
									<option
										key={option.value}
										value={option.value}
									>
										{option.label} (
										{option.subscriptionBadge})
									</option>
								))}
							</select>
						</div>

						<div>
							<label
								htmlFor="project-default-model-select"
								className="flex items-center justify-between text-xs font-medium text-muted-foreground"
							>
								<span>
									Default model (pre-configured tiers)
								</span>
								<SparklesIcon className="size-3.5 text-primary" />
							</label>
							<select
								id="project-default-model-select"
								aria-label="Default model"
								value={prefs.defaultModel}
								onChange={(event) =>
									updatePrefs({
										defaultModel: event.target.value,
									})
								}
								className="mt-1 flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm text-foreground shadow-2xs"
							>
								<option value="default">
									{prefs.defaultConnection === "default"
										? "Server default model (Auto)"
										: `Harness default (${activeConnection.defaultModel})`}
								</option>
								{prefs.defaultConnection !== "default" &&
									availableModels.map((modelOption) => (
										<option
											key={modelOption.id}
											value={modelOption.id}
										>
											{modelOption.label} —{" "}
											{modelOption.tierLabel}
										</option>
									))}
							</select>
						</div>
					</div>
				</div>

				{/* Step 3: Quota & Rate-Limit Fallback Policy */}
				<div className="space-y-3 rounded-lg border border-border/70 bg-muted/15 p-4">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<RefreshCwIcon className="size-4 text-primary" />
							<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								3. Quota &amp; rate-limit fallback choice
							</p>
						</div>
						<Badge
							variant="outline"
							className="rounded-full border-primary/25 bg-primary/5 px-2.5 py-0.5 text-[11px] text-primary"
						>
							User Controlled
						</Badge>
					</div>

					<fieldset className="grid gap-2.5 lg:grid-cols-3">
						<legend className="sr-only">
							Project quota fallback policy
						</legend>
						{FABRIC_AGENT_FALLBACK_POLICIES.map((policyOption) => {
							const isSelected =
								prefs.fallbackPolicy === policyOption.value;
							return (
								<label
									key={policyOption.value}
									className={`flex cursor-pointer flex-col justify-between gap-2 rounded-lg border p-3.5 text-left transition-all ${
										isSelected
											? "border-primary bg-primary/[0.06] ring-1 ring-primary/25"
											: "border-border/70 bg-background hover:border-border"
									}`}
								>
									<input
										type="radio"
										name="project-quota-fallback-policy"
										value={policyOption.value}
										checked={isSelected}
										onChange={() =>
											updatePrefs({
												fallbackPolicy:
													policyOption.value as FabricAgentFallbackPolicy,
											})
										}
										className="sr-only"
									/>
									<div className="space-y-1.5">
										<div className="flex items-start justify-between gap-2">
											<span className="text-xs font-semibold text-foreground">
												{policyOption.label}
											</span>
											{isSelected ? (
												<CheckCircle2Icon className="size-4 shrink-0 text-primary" />
											) : (
												<ShieldCheckIcon className="size-4 shrink-0 text-muted-foreground/40" />
											)}
										</div>
										<Badge
											variant={
												isSelected
													? "default"
													: "secondary"
											}
											className="rounded-full px-2 py-0 text-[10px]"
										>
											{policyOption.badge}
										</Badge>
										<p className="text-xs leading-5 text-muted-foreground">
											{policyOption.description}
										</p>
									</div>
								</label>
							);
						})}
					</fieldset>

					{prefs.fallbackPolicy === "subscription_harnesses" && (
						<div className="rounded-lg border border-border/60 bg-background p-3">
							<p className="text-xs font-medium text-foreground">
								Enabled backup subscription harnesses (rotates
								in order when quota is reached):
							</p>
							<div className="mt-2 flex flex-wrap gap-1.5">
								{FABRIC_AGENT_CONNECTIONS.filter(
									(item) => item.value !== "default",
								).map((harness) => {
									const included =
										prefs.fallbackHarnesses.includes(
											harness.value,
										);
									const orderIndex =
										prefs.fallbackHarnesses.indexOf(
											harness.value,
										);
									return (
										<button
											key={harness.value}
											type="button"
											onClick={() =>
												toggleFallbackHarness(
													harness.value,
												)
											}
											aria-pressed={included}
											className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
												included
													? "border-primary/40 bg-primary/10 text-primary"
													: "border-border/60 bg-muted/20 text-muted-foreground hover:text-foreground"
											}`}
										>
											{included && (
												<span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
													{orderIndex + 1}
												</span>
											)}
											<span>{harness.label}</span>
										</button>
									);
								})}
							</div>
						</div>
					)}
				</div>

				<div className="grid items-stretch gap-5 xl:grid-cols-2">
					{/* Fabric Agents Card */}
					<div className="group relative flex h-full flex-col overflow-hidden rounded-lg border border-primary/20 bg-gradient-to-br from-primary/[0.03] to-primary/[0.06] p-5 shadow-xs">
						<div className="mb-3 flex items-center gap-3">
							<div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
								<ServerCogIcon className="size-4 text-primary" />
							</div>
							<h4 className="font-semibold text-sm text-foreground">
								{getExecutionProviderLabel("BACKGROUND_AGENTS")}{" "}
								CLI Quickstart
							</h4>
						</div>
						<p className="mb-3 text-xs leading-relaxed text-muted-foreground">
							{getExecutionProviderDescription(
								"BACKGROUND_AGENTS",
							)}
						</p>
						<div className="mt-auto space-y-2 rounded-lg border border-primary/15 bg-background/60 p-3">
							<div className="flex items-center gap-2">
								<TerminalIcon className="size-3.5 text-muted-foreground" />
								<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
									Start remote server (:9100)
								</p>
							</div>
							<code className="block font-mono text-xs text-foreground">
								FABRIC_SERVER_TOKEN=&lt;secret&gt;
								fabric-agent-server --port 9100
							</code>
						</div>
					</div>

					{/* Fabric Kanban Card */}
					<div className="group relative flex h-full flex-col overflow-hidden rounded-lg border border-primary/20 bg-gradient-to-br from-primary/[0.03] to-primary/[0.06] p-5 shadow-xs">
						<div className="mb-3 flex items-center gap-3">
							<div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
								<LaptopIcon className="size-4 text-primary" />
							</div>
							<h4 className="font-semibold text-sm text-foreground">
								{getExecutionProviderLabel("KANBAN_LOCAL")}
							</h4>
						</div>
						<p className="mb-3 text-xs leading-relaxed text-muted-foreground">
							Queues features for local development through{" "}
							{getExecutionProviderPlatformLabel("KANBAN_LOCAL")}.
							{hasRepositoryContext
								? ` Connected repository: ${project.repositoryOwner}/${project.repositoryName}.`
								: " Connect a repository to pull queued items."}
						</p>
						<div className="mt-auto space-y-2 rounded-lg border border-primary/15 bg-background/60 p-3">
							<div className="flex items-center gap-2">
								<TerminalIcon className="size-3.5 text-muted-foreground" />
								<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
									Install &amp; run
								</p>
							</div>
							<code className="block font-mono text-xs text-foreground">
								npm install -g @fabriccode/kanban@latest
								&amp;&amp; fabric-kanban
							</code>
						</div>
					</div>
				</div>
			</div>
		</Card>
	);
}
