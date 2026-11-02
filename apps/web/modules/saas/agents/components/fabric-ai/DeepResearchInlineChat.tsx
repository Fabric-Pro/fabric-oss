"use client";

import { ChatInput } from "@saas/agents/components/FabricChat/shared/ChatInput";
import type { ReasoningMode } from "@saas/agents/components/ReasoningModeSelector";
import type { useResearchRunStream } from "@saas/agents/hooks/useResearchRunStream";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { Globe, Scale, ScanSearch, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const WorkflowProgressPanel = dynamic(
	() =>
		import(
			"@saas/agents/components/WorkflowTemplateChat/WorkflowProgressPanel"
		).then((mod) => ({ default: mod.WorkflowProgressPanel })),
	{ ssr: false },
);

const WorkflowResultViewer = dynamic(
	() =>
		import(
			"@saas/agents/components/WorkflowTemplateChat/WorkflowResultViewer"
		).then((mod) => ({ default: mod.WorkflowResultViewer })),
	{ ssr: false },
);

/** Inline research chat with durable runtime restoration and cancellation. */
const DEEP_RESEARCH_SUGGESTIONS = [
	{
		label: "AI agents & autonomous systems",
		description:
			"Multi-agent orchestration, tool use & memory architectures",
		icon: RobotIcon,
		iconTone: "border-primary/20 bg-primary/10 text-primary",
		prompt: "What are the latest developments in AI agents and autonomous systems?",
	},
	{
		label: "RAG application approaches",
		description: "Hybrid retrieval, reranking & agentic context pipelines",
		icon: ScanSearch,
		iconTone:
			"border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400",
		prompt: "Compare different approaches to building RAG applications",
	},
	{
		label: "Open source vs proprietary LLMs",
		description:
			"Cost, latency, reasoning benchmarks & governance trade-offs",
		icon: Scale,
		iconTone:
			"border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
		prompt: "Analyze the current state of open source LLMs vs proprietary models",
	},
	{
		label: "Prompt engineering best practices",
		description: "Structured outputs, evaluation harnesses & guardrails",
		icon: Sparkles,
		iconTone:
			"border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
		prompt: "Research best practices for prompt engineering in production systems",
	},
];

interface DeepResearchInlineChatProps {
	stream: ReturnType<typeof useResearchRunStream>;
	onSend: (query: string) => void;
	onReset: () => void;
	organizationId?: string;
	reasoningMode?: ReasoningMode;
}

export function DeepResearchInlineChat({
	stream,
	onSend,
	onReset,
	organizationId,
	reasoningMode,
}: DeepResearchInlineChatProps) {
	const [inputValue, setInputValue] = useState("");
	const hasInteracted = stream.query !== "";
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const handleSend = useCallback(() => {
		const text = inputValue.trim();
		if (!text || stream.isLoading) {
			return;
		}
		setInputValue("");
		onSend(text);
	}, [inputValue, stream.isLoading, onSend]);

	// Auto-scroll to bottom when new content appears
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [
		stream.state.phase,
		stream.state.subAgentResults.length,
		stream.hasResults,
	]);

	return (
		<div className="flex flex-col h-full">
			{/* Scrollable message area — same structure as Direct/Orchestrator */}
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl px-4 py-6">
					{/* Welcome state — matching Orchestrator's hero layout */}
					{!hasInteracted && (
						<div className="flex flex-col items-center justify-center pt-12 pb-8">
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 shadow-2xs">
								<Globe className="h-6 w-6 text-primary" />
							</div>
							<h2 className="text-2xl font-semibold tracking-tight text-foreground mb-1.5">
								Deep Research
							</h2>
							<p className="text-sm text-muted-foreground max-w-md text-center mb-8">
								Ask a research question. It will be decomposed,
								investigated in parallel, and synthesized into a
								structured report.
							</p>

							{/* Starter messages — modern vector icons + subtle descriptions */}
							<div className="grid w-full max-w-2xl gap-2.5 sm:grid-cols-2">
								{DEEP_RESEARCH_SUGGESTIONS.map((s) => {
									const SuggestionIcon = s.icon;
									return (
										<button
											key={s.prompt}
											type="button"
											onClick={() => {
												setInputValue("");
												onSend(s.prompt);
											}}
											className="group flex items-start gap-3 rounded-lg border border-border/70 bg-card p-3.5 text-left text-sm shadow-2xs transition-colors hover:border-primary/30 hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span
												className={cn(
													"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
													s.iconTone,
												)}
											>
												<SuggestionIcon className="size-4" />
											</span>
											<span className="min-w-0 flex-1">
												<span className="block font-medium text-foreground group-hover:text-primary transition-colors leading-snug">
													{s.label}
												</span>
												<span className="mt-0.5 block text-xs text-muted-foreground line-clamp-1">
													{s.description}
												</span>
											</span>
										</button>
									);
								})}
							</div>
						</div>
					)}

					{/* Chat-style messages once research starts */}
					{hasInteracted && (
						<div className="space-y-4">
							{/* User query — styled like a user message bubble */}
							{stream.query && (
								<div className="flex justify-end">
									<div className="max-w-[80%] rounded-lg rounded-tr-md bg-primary/10 px-4 py-3">
										<p className="text-sm whitespace-pre-wrap">
											{stream.query}
										</p>
									</div>
								</div>
							)}

							{/* Assistant response area */}
							<div className="flex gap-3">
								<div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
									<Globe className="h-4 w-4 text-primary" />
								</div>
								<div className="min-w-0 flex-1 space-y-4">
									{/* Progress panel */}
									{!stream.isComplete && (
										<WorkflowProgressPanel
											state={stream.state}
											progressPercentage={
												stream.progress.percentage
											}
											onClarificationResponse={
												stream.sendClarificationResponse
											}
										/>
									)}

									{/* Error */}
									{stream.state.error && (
										<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
											<p className="text-sm text-destructive">
												{stream.state.error}
											</p>
										</div>
									)}

									{/* Results */}
									{stream.hasResults &&
										stream.state.result && (
											<WorkflowResultViewer
												result={stream.state.result}
												instanceId="deep-research-inline"
												organizationId={organizationId}
												// A reopened result was saved when it first showed.
												persistArtifact={
													!stream.resultRestored
												}
											/>
										)}

									{/* New Research button after completion */}
									{stream.isComplete && (
										<Button
											variant="outline"
											size="sm"
											onClick={onReset}
											className="mt-2"
										>
											<Sparkles className="h-4 w-4 mr-2" />
											New Research
										</Button>
									)}
								</div>
							</div>
						</div>
					)}

					<div ref={messagesEndRef} />
				</div>
			</div>

			{/* Shared ChatInput — same component used by Direct/Orchestrator */}
			<div className="border-t border-border/60 bg-background/80 px-4 py-3">
				<div className="mx-auto max-w-3xl space-y-2">
					<ChatInput
						value={inputValue}
						onChange={setInputValue}
						onSend={handleSend}
						onStop={
							stream.transport === "runtime"
								? () => void stream.cancel()
								: undefined
						}
						isLoading={stream.isLoading}
						disabled={stream.isRunning}
						placeholder={
							stream.isRunning
								? "Research in progress..."
								: "Ask a research question..."
						}
						showAttachButton={false}
					/>
					{reasoningMode && reasoningMode !== "balanced" && (
						<p className="text-[11px] text-muted-foreground text-center">
							{reasoningMode === "lite" &&
								"Fast mode — minimal reasoning"}
							{reasoningMode === "deep" &&
								"Thorough mode — deep reasoning enabled"}
							{reasoningMode === "planner" &&
								"Planner mode — high reasoning enabled"}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
