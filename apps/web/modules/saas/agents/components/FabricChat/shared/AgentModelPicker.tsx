"use client";

/**
 * The agent and model picker — one list, two sections, one selection array.
 *
 * Models are offered as pseudo-agents with a `model:` prefixed id, which is what
 * lets a user pick a raw model as easily as a registered agent and have both
 * flow through the same selection path. Selection is additive: clicking a row
 * toggles it and the popover stays open, so several can be picked in a row.
 *
 * Lifted out of the Nexus composer, which was the only surface offering it. The
 * unified agent interface needs it reachable from the shared chat components —
 * `ChatInput` renders it through `headerSlot`, which takes arbitrary content, so
 * no change to that component's API is required.
 *
 * Owns its own open state because the three catalog queries are gated on it:
 * nothing is fetched until the user actually opens the picker.
 */

import { CHATGPT_PLAN_MODEL_OVERRIDE_PREFIX } from "@repo/agent-types/chatgpt-plan-fetch";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { formatPlanResetTime } from "@saas/shared/lib/ai-error-message";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { CheckCircle2Icon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentAvatar, VendorLogo } from "./AgentIdentity";
import {
	buildInstanceAgentConfig,
	PLAN_MODEL_AGENT_PREFIX,
	type SelectedAgent,
} from "./agent-selection";

type AvailableAgent = {
	agentId: string;
	displayName: string;
	description?: string | null;
	instructions?: string | null;
	enabledMcpConfigIds?: string[];
	workspaceIds?: string[];
	instanceId?: string;
	instanceVersion?: number;
	enabledFabricToolIds?: string[];
	boundProjectId?: string | null;
	enabledIntegrationProviders?: string[];
};

export interface AgentModelPickerProps {
	/** Currently picked agents and models. */
	selectedAgents: SelectedAgent[];
	/** Toggles one entry in the selection. Omit to render the picker inert. */
	onToggleAgent?: (agent: SelectedAgent) => void;
	/** Tenant scope for the catalog queries. */
	organizationId?: string | null;
	/**
	 * Which entries the catalog offers.
	 *
	 * `"models"` drops the registered-agent and template-instance sections.
	 * The Orchestrator uses it because a registered agent carries
	 * `instructions` and no `modelOverride`: applying those instructions would
	 * replace the orchestrator's own system prompt, which its planning,
	 * delegation and clarification all depend on (#2040). Choosing the model
	 * the orchestrator reasons with is a separate, safe question from
	 * replacing what it is.
	 */
	catalog?: "all" | "models";
}

export function AgentModelPicker({
	selectedAgents,
	onToggleAgent,
	organizationId,
	catalog = "all",
}: AgentModelPickerProps) {
	const modelsOnly = catalog === "models";
	const [agentPickerOpen, setAgentPickerOpen] = useState(false);
	const [agentSearch, setAgentSearch] = useState("");

	// Fetch agents and models for the inline popover
	const { data: agentsData } = useQuery({
		queryKey: ["agents-registry", organizationId, "compose-picker"],
		queryFn: () =>
			orpcClient.agents.registry.list({
				limit: 100,
				organizationId: organizationId ?? null,
			}),
		enabled: agentPickerOpen && !modelsOnly,
		refetchOnWindowFocus: false,
	});

	const { data: instanceAgentsData } = useQuery({
		queryKey: [
			"agent-template-instances",
			organizationId,
			"compose-picker",
		],
		queryFn: () =>
			orpcClient.agentTemplates.instances.list({
				organizationId: organizationId ?? null,
				status: "ACTIVE",
				latestVersionOnly: true,
				limit: 100,
				offset: 0,
			}),
		enabled: agentPickerOpen && !modelsOnly,
		refetchOnWindowFocus: false,
	});

	const { data: modelsData } = useQuery({
		queryKey: ["ai-models-available", organizationId, "compose-picker"],
		queryFn: () =>
			orpcClient.aiConfig.models.listAvailable({
				organizationId: organizationId ?? null,
				taskType: "CHAT",
				// Advisor and ⌘J run tool calling: the plan's "Default" is that
				// task's model, the one that actually runs.
				planTaskType: "TOOL_CALLING",
			}),
		enabled: agentPickerOpen,
		refetchOnWindowFocus: false,
	});

	// Guarded rather than relying on the disabled queries above: both use a
	// query key shared with every other picker instance, so a catalog="all"
	// picker elsewhere on the page populates that cache and React Query hands
	// the cached value to a disabled observer too.
	const availableAgents: AvailableAgent[] = modelsOnly
		? []
		: [
				...(agentsData?.agents ?? []).map((agent) => ({
					agentId: agent.agentId,
					displayName: agent.displayName,
					description: agent.description,
				})),
				...(instanceAgentsData?.instances ?? []).map(
					(instance: any) => {
						const config = buildInstanceAgentConfig(instance);
						return {
							agentId: `template-instance:${instance.id}`,
							displayName: instance.name,
							instanceVersion: instance.version,
							description: instance.description,
							instructions: config.instructions,
							enabledMcpConfigIds: config.enabledMcpConfigIds,
							workspaceIds: config.workspaceIds,
							instanceId: config.instanceId ?? instance.id,
							enabledFabricToolIds: config.enabledFabricToolIds,
							boundProjectId: config.boundProjectId,
							enabledIntegrationProviders:
								config.enabledIntegrationProviders,
						};
					},
				),
			];
	const availableModels = modelsData?.models ?? [];
	// The ChatGPT plan that runs the member's own work here instead of any
	// provider model (Fizzy #2770). Its models replace the provider list: a
	// provider model never runs while a plan serves the chat (F13).
	const chatgptPlan = modelsData?.chatgptPlan ?? null;
	const planModels = (chatgptPlan?.models ?? []).filter(
		(model) =>
			!agentSearch ||
			model.displayName.toLowerCase().includes(agentSearch.toLowerCase()),
	);
	// A chat's plan pick is its own kind of selection (Fizzy #2770 F13): its
	// id never equals a saved provider model's, and its override carries the
	// plan marker, so it runs only on the plan and is never saved.
	const pickedPlanModel = selectedAgents.find(
		(agent) =>
			agent.chatOnly && agent.agentId.startsWith(PLAN_MODEL_AGENT_PREFIX),
	);
	const servedPick =
		pickedPlanModel &&
		chatgptPlan?.models.some(
			(model) =>
				pickedPlanModel.agentId ===
				`${PLAN_MODEL_AGENT_PREFIX}${model.canonicalName}`,
		)
			? pickedPlanModel
			: undefined;
	// A pick the serving plan no longer lists would be ignored by the
	// server; drop it, unsaved, so the chip and the menu agree. A spent plan
	// lists nothing until it resets, and the pick still applies then.
	useEffect(() => {
		if (
			chatgptPlan &&
			!chatgptPlan.spent &&
			pickedPlanModel &&
			!servedPick
		) {
			onToggleAgent?.(pickedPlanModel);
		}
	}, [chatgptPlan, pickedPlanModel, servedPick, onToggleAgent]);
	const handleTogglePlanModel = (
		model: NonNullable<typeof chatgptPlan>["models"][number],
	) => {
		onToggleAgent?.({
			agentId: `${PLAN_MODEL_AGENT_PREFIX}${model.canonicalName}`,
			name: model.displayName,
			modelOverride: `${CHATGPT_PLAN_MODEL_OVERRIDE_PREFIX}${model.canonicalName}`,
			vendor: "OpenAI",
			chatOnly: true,
		});
	};

	const filteredModels = availableModels.filter((m) => {
		if (chatgptPlan) {
			return false;
		}
		if (!agentSearch) {
			return true;
		}
		const q = agentSearch.toLowerCase();
		return (
			m.displayName.toLowerCase().includes(q) ||
			m.vendor.toLowerCase().includes(q)
		);
	});

	const filteredAgents = availableAgents.filter((a) => {
		if (!agentSearch) {
			return true;
		}
		const q = agentSearch.toLowerCase();
		return (
			a.displayName.toLowerCase().includes(q) ||
			(a.description ?? "").toLowerCase().includes(q)
		);
	});

	const selectedAgentIds = selectedAgents.map((a) => a.agentId);

	const handleToggleModelAgent = (model: (typeof availableModels)[0]) => {
		if (!onToggleAgent) {
			return;
		}
		onToggleAgent({
			agentId: `model:${model.canonicalName}`,
			name: model.displayName,
			description: model.description ?? undefined,
			modelOverride: model.canonicalName,
			vendor: model.vendor,
			// Leave `enabledMcpConfigIds` undefined — see the
			// availableModels factory above for the rationale.
		});
	};

	const handleToggleRegisteredAgent = (
		agent: (typeof availableAgents)[0],
	) => {
		if (!onToggleAgent) {
			return;
		}
		onToggleAgent({
			agentId: agent.agentId,
			name: agent.displayName,
			description: agent.description ?? undefined,
			instructions: agent.instructions ?? undefined,
			enabledMcpConfigIds: agent.enabledMcpConfigIds,
			workspaceIds: agent.workspaceIds,
			instanceId: agent.instanceId,
			enabledFabricToolIds: agent.enabledFabricToolIds,
			boundProjectId: agent.boundProjectId,
			enabledIntegrationProviders: agent.enabledIntegrationProviders,
		});
	};

	return (
		<Popover open={agentPickerOpen} onOpenChange={setAgentPickerOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
				>
					<RobotIcon className="size-3.5" />
					<span>{modelsOnly ? "Model" : "Agents"}</span>
					<ChevronDownIcon className="size-3 opacity-60" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" sideOffset={8} className="w-72 p-0">
				{/* Search */}
				<div className="p-2 border-b border-border/60">
					<div className="relative">
						<SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50 pointer-events-none" />
						<input
							type="search"
							autoComplete="off"
							aria-label={
								modelsOnly
									? "Search models"
									: "Search agents and models"
							}
							placeholder={
								modelsOnly
									? "Search models..."
									: "Search agents and models..."
							}
							value={agentSearch}
							onChange={(e) => setAgentSearch(e.target.value)}
							className="w-full pl-7 pr-3 py-1.5 text-xs bg-muted/40 rounded-md border border-border/50 outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40 text-foreground placeholder:text-muted-foreground/50 transition-colors"
						/>
					</div>
				</div>

				{/* Scrollable list */}
				<div className="max-h-72 overflow-y-auto py-1">
					{chatgptPlan && (
						<div data-testid="agent-picker-chatgpt-plan">
							<p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60">
								Runs on your{" "}
								{chatgptPlan.source === "shared"
									? "organization's shared ChatGPT plan"
									: "ChatGPT plan"}
							</p>
							{chatgptPlan.spent && (
								<p
									className="px-3 py-1.5 text-xs text-muted-foreground"
									data-testid="agent-picker-chatgpt-plan-spent"
								>
									{chatgptPlan.spent.until
										? `Spent until ${formatPlanResetTime(new Date(chatgptPlan.spent.until))}`
										: "Spent until its usage resets"}
								</p>
							)}
							{planModels.map((model) => {
								const isSelected = servedPick
									? servedPick.agentId ===
										`${PLAN_MODEL_AGENT_PREFIX}${model.canonicalName}`
									: model.isDefault;
								return (
									<button
										aria-pressed={isSelected}
										className={cn(
											"w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors",
											isSelected && "bg-primary/5",
										)}
										key={model.canonicalName}
										onClick={() => {
											// The default needs no override: picking it
											// clears this chat's choice.
											if (model.isDefault) {
												if (servedPick) {
													onToggleAgent?.(servedPick);
												}
												return;
											}
											handleTogglePlanModel(model);
										}}
										type="button"
									>
										<VendorLogo size={18} vendor="OpenAI" />
										<span className="flex-1 min-w-0 truncate text-foreground text-xs">
											{model.displayName}
										</span>
										{model.isDefault && (
											<span className="shrink-0 text-[10px] text-muted-foreground">
												Default
											</span>
										)}
										{model.newest && (
											<span className="shrink-0 font-mono text-[10px] text-success">
												Newest
											</span>
										)}
										{isSelected && (
											<CheckCircle2Icon className="size-3.5 shrink-0 text-primary" />
										)}
									</button>
								);
							})}
						</div>
					)}
					{/* Models section */}
					{filteredModels.length > 0 && (
						<div>
							{/* Redundant when it is the only section. */}
							{!modelsOnly && (
								<p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60">
									Models
								</p>
							)}
							{filteredModels.map((model) => {
								const modelAgentId = `model:${model.canonicalName}`;
								const isSelected =
									selectedAgentIds.includes(modelAgentId);
								return (
									<button
										key={modelAgentId}
										type="button"
										onClick={() =>
											handleToggleModelAgent(model)
										}
										className={cn(
											"w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors",
											isSelected && "bg-primary/5",
										)}
									>
										<VendorLogo
											vendor={model.vendor}
											size={18}
										/>
										<span className="flex-1 min-w-0 text-xs text-foreground truncate">
											{model.displayName}
										</span>
										{isSelected && (
											<CheckCircle2Icon className="size-3.5 text-primary shrink-0" />
										)}
									</button>
								);
							})}
						</div>
					)}

					{/* Agents section */}
					{filteredAgents.length > 0 && (
						<div>
							<p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60">
								Agents
							</p>
							{filteredAgents.map((agent) => {
								const isSelected = selectedAgentIds.includes(
									agent.agentId,
								);
								return (
									<button
										key={agent.agentId}
										type="button"
										onClick={() =>
											handleToggleRegisteredAgent(agent)
										}
										className={cn(
											"w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors",
											isSelected && "bg-primary/5",
										)}
									>
										<AgentAvatar
											name={agent.displayName}
											size="sm"
										/>
										<span className="flex-1 min-w-0 text-xs text-foreground truncate">
											{agent.displayName}
											{agent.instanceVersion != null
												? ` · v${agent.instanceVersion}`
												: ""}
										</span>
										{isSelected && (
											<CheckCircle2Icon className="size-3.5 text-primary shrink-0" />
										)}
									</button>
								);
							})}
						</div>
					)}

					{/* Empty state */}
					{filteredModels.length === 0 &&
						filteredAgents.length === 0 &&
						!chatgptPlan && (
							<p className="px-3 py-4 text-xs text-muted-foreground text-center">
								{agentSearch
									? "No matches found"
									: modelsOnly
										? "No models configured"
										: "No agents or models configured"}
							</p>
						)}
				</div>

				{/*
				 * Scope note. A pick here is a per-conversation override and
				 * nothing more — it does not change the model behind any other
				 * surface, and on the orchestrator it will not change the model
				 * the specialists it delegates to run on. Without saying so,
				 * picking a model reads as a global setting.
				 *
				 * Deliberately names the destination rather than linking to it:
				 * the href differs between personal and organization context,
				 * the picker only receives an `organizationId`, and following a
				 * link mid-conversation would navigate the chat away.
				 */}
				<div className="border-t border-border/60 px-3 py-2">
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						{chatgptPlan
							? "A model picked here applies to this chat only. The organization's default comes from "
							: "Applies to this chat only. Everywhere else uses your configured defaults in "}
						<span className="text-foreground">
							Settings → AI Models
						</span>
						.
					</p>
				</div>
			</PopoverContent>
		</Popover>
	);
}
