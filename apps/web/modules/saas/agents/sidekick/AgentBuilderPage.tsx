"use client";

import { NEW_AGENT_ID } from "@repo/ai/sidekick/constants";
import {
	getProviderDisplayName,
	useAvailableModels,
} from "@shared/hooks/use-available-models";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentBuilderSidekick } from "./AgentBuilderSidekick";
import { InstructionsEditor } from "./editor/InstructionsEditor";
import type { PendingSuggestionSummary } from "./SidekickFormContext";
import { SidekickFormProvider } from "./SidekickFormContext";
import {
	SidekickSuggestionsProvider,
	useSidekickSuggestions,
} from "./SidekickSuggestionsContext";

// ---- Types ----

interface AgentBuilderPageProps {
	agentId?: string;
}

interface BuilderFormData {
	name: string;
	description: string;
	systemPromptMarkdown: string;
	systemPromptHtml: string;
	model: string;
	tools: Array<{ id: string; name: string }>;
	skills: string[];
}

const DEFAULT_FORM_DATA: BuilderFormData = {
	name: "",
	description: "",
	systemPromptMarkdown: "",
	systemPromptHtml: "",
	model: "groq/llama-3.3-70b-versatile",
	tools: [],
	skills: [],
};

// ---- Inner layout (needs suggestions context) ----

function AgentBuilderInner({
	agentId,
	formData,
	setFormData,
}: {
	agentId: string;
	formData: BuilderFormData;
	setFormData: React.Dispatch<React.SetStateAction<BuilderFormData>>;
}) {
	const { pendingSuggestions } = useSidekickSuggestions();
	const [activeTab, setActiveTab] = useState<"sidekick" | "preview">(
		"sidekick",
	);

	const pendingSummaries = useMemo<PendingSuggestionSummary[]>(
		() =>
			pendingSuggestions.map((s) => ({
				sId: s.id,
				kind: s.kind,
			})),
		[pendingSuggestions],
	);

	const handleSetFormField = useCallback(
		(field: string, updater: (prev: unknown) => unknown) => {
			setFormData((prev) => ({
				...prev,
				[field]: updater(prev[field as keyof BuilderFormData]),
			}));
		},
		[setFormData],
	);

	// Load available models
	const { modelsByProvider, sortedProviders } = useAvailableModels();

	return (
		<SidekickFormProvider
			formValues={{
				...formData,
				systemPromptHtml: formData.systemPromptHtml || undefined,
			}}
			pendingSuggestions={pendingSummaries}
			onSetFormField={handleSetFormField}
		>
			<div className="flex h-[calc(100vh-53px)] overflow-hidden">
				{/* Left column: Agent configuration form */}
				<div className="flex w-[60%] flex-col overflow-y-auto border-r border-border">
					<div className="p-6">
						{/* Section label */}
						<div className="mb-6 flex items-center gap-2">
							<div className="h-4 w-0.5 bg-primary" />
							<span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
								Agent Configuration
							</span>
						</div>

						<h1 className="mb-8 font-serif text-2xl font-normal text-foreground">
							Agent Builder
						</h1>

						<div className="space-y-6">
							{/* Name */}
							<div className="space-y-2">
								<Label htmlFor="agent-name">Name</Label>
								<Input
									id="agent-name"
									value={formData.name}
									onChange={(e) =>
										setFormData((prev) => ({
											...prev,
											name: e.target.value,
										}))
									}
									placeholder="My Agent"
									className="max-w-md"
								/>
							</div>

							{/* Description */}
							<div className="space-y-2">
								<Label htmlFor="agent-description">
									Description
								</Label>
								<Input
									id="agent-description"
									value={formData.description}
									onChange={(e) =>
										setFormData((prev) => ({
											...prev,
											description: e.target.value,
										}))
									}
									placeholder="Describe what this agent does..."
									className="max-w-lg"
								/>
							</div>

							{/* Instructions */}
							<div className="space-y-2">
								<Label htmlFor="agent-instructions">
									Instructions
								</Label>
								<p className="text-xs text-muted-foreground">
									System prompt that defines how the agent
									behaves. Edit below using the rich text
									editor.
								</p>
								<InstructionsEditor
									content={formData.systemPromptHtml}
									onChange={(plainText, html) =>
										setFormData((prev) => ({
											...prev,
											systemPromptMarkdown: plainText,
											systemPromptHtml: html,
										}))
									}
								/>
							</div>

							{/* Model selector */}
							<div className="space-y-2">
								<Label htmlFor="agent-model">Model</Label>
								<Select
									value={formData.model}
									onValueChange={(value) =>
										setFormData((prev) => ({
											...prev,
											model: value,
										}))
									}
								>
									<SelectTrigger
										id="agent-model"
										className="max-w-md"
									>
										<SelectValue placeholder="Select a model" />
									</SelectTrigger>
									<SelectContent>
										{sortedProviders.map((provider) => {
											const models =
												modelsByProvider[provider] ??
												[];
											if (models.length === 0) {
												return null;
											}
											return models.map((model) => (
												<SelectItem
													key={model.id}
													value={model.id}
												>
													{model.displayName}
													<span className="ml-2 text-xs text-muted-foreground">
														(
														{getProviderDisplayName(
															provider,
														)}
														)
													</span>
												</SelectItem>
											));
										})}
									</SelectContent>
								</Select>
							</div>
						</div>
					</div>
				</div>

				{/* Right column: Sidekick panel */}
				<div className="flex w-[40%] flex-col bg-muted/30">
					{/* Tab bar */}
					<div className="flex border-b border-border">
						<button
							type="button"
							onClick={() => setActiveTab("sidekick")}
							className={cn(
								"px-4 py-2.5 text-sm font-medium transition-colors",
								activeTab === "sidekick"
									? "border-b-2 border-primary text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							Sidekick
						</button>
						<button
							type="button"
							onClick={() => setActiveTab("preview")}
							className={cn(
								"px-4 py-2.5 text-sm font-medium transition-colors",
								activeTab === "preview"
									? "border-b-2 border-primary text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							Preview
						</button>
					</div>

					{/* Tab content */}
					<div className="flex-1 overflow-hidden">
						{activeTab === "sidekick" ? (
							<AgentBuilderSidekick
								agentId={agentId}
								entityType="registered"
							/>
						) : (
							<div className="flex h-full items-center justify-center p-6">
								<p className="text-sm text-muted-foreground">
									Preview will be available in a future
									update.
								</p>
							</div>
						)}
					</div>
				</div>
			</div>
		</SidekickFormProvider>
	);
}

// ---- Main page component ----

export function AgentBuilderPage({ agentId }: AgentBuilderPageProps) {
	const isNewAgent = !agentId;
	const [formData, setFormData] =
		useState<BuilderFormData>(DEFAULT_FORM_DATA);

	// Load agent data (skip for new agents)
	const { data: agent, isLoading } = useQuery({
		queryKey: ["agent", "registry", "builder", agentId],
		queryFn: async () => {
			try {
				return await orpcClient.agents.registry.get({ id: agentId! });
			} catch {
				return null;
			}
		},
		enabled: !!agentId,
	});

	// Populate form when agent data loads
	useEffect(() => {
		if (!agent) {
			return;
		}

		const promptText =
			(
				agent.config as Record<string, unknown>
			)?.systemPromptKey?.toString() ?? "";

		// Escape HTML entities before wrapping in tags so angle-bracket
		// placeholders and XML-like tags in prompts aren't parsed as markup.
		const escaped = promptText
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
		const promptHtml = escaped
			? `<p>${escaped.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`
			: "";

		setFormData({
			name: agent.displayName ?? "",
			description: agent.description ?? "",
			systemPromptMarkdown: promptText,
			systemPromptHtml: promptHtml,
			model:
				(agent.config as Record<string, unknown>)?.model?.toString() ??
				"groq/llama-3.3-70b-versatile",
			tools: [],
			skills: [],
		});
	}, [agent]);

	if (!isNewAgent && isLoading) {
		return (
			<div className="flex h-[calc(100vh-53px)] items-center justify-center">
				<div className="flex flex-col items-center gap-3">
					<Loader2Icon className="size-6 animate-spin text-muted-foreground" />
					<p className="text-sm text-muted-foreground">
						Loading agent...
					</p>
				</div>
			</div>
		);
	}

	if (!isNewAgent && !agent) {
		return (
			<div className="flex h-[calc(100vh-53px)] items-center justify-center">
				<div className="text-center">
					<h2 className="font-serif text-xl text-foreground">
						Agent not found
					</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						The agent you are looking for does not exist or you do
						not have access.
					</p>
				</div>
			</div>
		);
	}

	// For new agents, use a temporary ID; for existing, use the real one
	const effectiveAgentId = agentId ?? NEW_AGENT_ID;

	return (
		<SidekickSuggestionsProvider
			agentId={effectiveAgentId}
			entityType="registered"
		>
			<AgentBuilderInner
				agentId={effectiveAgentId}
				formData={formData}
				setFormData={setFormData}
			/>
		</SidekickSuggestionsProvider>
	);
}
