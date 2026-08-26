"use client";

/**
 * WorkflowTemplateChat Component
 *
 * Main chat interface for agent templates with dedicated Temporal workflows.
 * Provides:
 * - Query input with suggestions
 * - Real-time progress tracking
 * - Result display with export options
 */

import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { Textarea } from "@ui/components/textarea";
import { ArrowLeft, Send, Sparkles, Square } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useWorkflowTemplateStream } from "../../hooks/useWorkflowTemplateStream";
import { WorkflowProgressPanel } from "./WorkflowProgressPanel";
import { WorkflowResultViewer } from "./WorkflowResultViewer";

export interface WorkflowTemplateChatProps {
	templateSlug: string;
	instanceId: string;
	instanceName: string;
	instanceDescription?: string;
	organizationId?: string | null;
	projectId?: string;
	backUrl?: string;
	/** Suggested queries to show before first interaction */
	suggestions?: string[];
	starterMessages?: Array<{ label: string; emoji?: string; prompt: string }>;
}

const DEFAULT_SUGGESTIONS = [
	"What are the latest developments in AI agents and autonomous systems?",
	"Compare different approaches to building RAG applications",
	"Analyze the current state of open source LLMs vs proprietary models",
	"Research best practices for prompt engineering in production systems",
];

export function WorkflowTemplateChat({
	templateSlug,
	instanceId,
	instanceName,
	instanceDescription,
	organizationId,
	projectId,
	backUrl = "/app/agents",
	suggestions = DEFAULT_SUGGESTIONS,
	starterMessages,
}: WorkflowTemplateChatProps) {
	const [inputValue, setInputValue] = useState("");
	const [hasInteracted, setHasInteracted] = useState(false);

	const {
		state,
		query,
		isLoading,
		isRunning,
		isComplete,
		hasResults,
		progress,
		sendQuery,
		sendClarificationResponse,
		cancel,
		reset,
	} = useWorkflowTemplateStream({
		templateSlug,
		instanceId,
		organizationId: organizationId ?? undefined,
	});

	const handleSubmit = useCallback(
		async (queryText?: string) => {
			const text = queryText || inputValue;
			if (!text.trim() || isLoading) {
				return;
			}

			setHasInteracted(true);
			setInputValue("");
			await sendQuery(text);
		},
		[inputValue, isLoading, sendQuery],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit],
	);

	const handleSuggestionClick = useCallback(
		(suggestion: string) => {
			handleSubmit(suggestion);
		},
		[handleSubmit],
	);

	const handleNewResearch = useCallback(() => {
		reset();
		setHasInteracted(false);
	}, [reset]);

	const effectiveSuggestions =
		starterMessages && starterMessages.length > 0
			? starterMessages.map((message) => message.prompt)
			: suggestions;

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
				<div className="container flex items-center gap-4 h-14 px-4">
					<Link href={backUrl}>
						<Button variant="ghost" size="sm">
							<ArrowLeft className="h-4 w-4 mr-2" />
							Back
						</Button>
					</Link>
					<div className="flex-1">
						<h1 className="font-semibold">{instanceName}</h1>
						{instanceDescription && (
							<p className="text-xs text-muted-foreground truncate max-w-md">
								{instanceDescription}
							</p>
						)}
					</div>
					{hasInteracted && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleNewResearch}
						>
							<Sparkles className="h-4 w-4 mr-2" />
							New Research
						</Button>
					)}
				</div>
			</header>

			{/* Main content */}
			<div className="flex-1 overflow-auto">
				<div className="container max-w-4xl mx-auto px-4 py-6 space-y-6">
					{/* Welcome state */}
					{!hasInteracted && (
						<div className="space-y-6">
							<div className="text-center py-8">
								<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
									<Sparkles className="h-8 w-8 text-primary" />
								</div>
								<h2 className="text-2xl font-bold mb-2">
									{instanceName}
								</h2>
								<p className="text-muted-foreground max-w-md mx-auto">
									Enter a research question below. The Deep
									Researcher will break it into sub-tasks,
									investigate in parallel, and synthesize the
									findings.
								</p>
							</div>

							{/* Suggestions */}
							<div className="space-y-2">
								<h3 className="text-sm font-medium text-muted-foreground text-center">
									Try one of these queries
								</h3>
								<div className="grid gap-2 sm:grid-cols-2">
									{effectiveSuggestions.map(
										(suggestion, index) => (
											<Card
												key={index}
												className="cursor-pointer hover:bg-muted/50 transition-colors"
												onClick={() =>
													handleSuggestionClick(
														suggestion,
													)
												}
											>
												<CardContent className="p-3 text-sm">
													{suggestion}
												</CardContent>
											</Card>
										),
									)}
								</div>
							</div>
						</div>
					)}

					{/* Active query display */}
					{hasInteracted && query && (
						<Card className="bg-muted/50">
							<CardContent className="p-4">
								<div className="text-xs font-medium text-muted-foreground mb-1">
									Research Query
								</div>
								<p className="text-sm whitespace-pre-wrap">
									{query}
								</p>
							</CardContent>
						</Card>
					)}

					{/* Progress panel */}
					{hasInteracted && !isComplete && (
						<WorkflowProgressPanel
							state={state}
							progressPercentage={progress.percentage}
							onClarificationResponse={sendClarificationResponse}
						/>
					)}

					{/* Error state */}
					{state.error && (
						<Card className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950">
							<CardContent className="p-4">
								<div className="text-sm text-destructive/80">
									{state.error}
								</div>
							</CardContent>
						</Card>
					)}

					{/* Results */}
					{hasResults && state.result && (
						<WorkflowResultViewer
							result={state.result}
							instanceId={instanceId}
							organizationId={organizationId}
							projectId={projectId}
						/>
					)}
				</div>
			</div>

			{/* Input area */}
			<footer className="border-t bg-background p-4">
				<div className="container max-w-4xl mx-auto">
					<div className="flex gap-2">
						<Textarea
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Enter your research question..."
							className="min-h-[60px] max-h-[200px] resize-none"
							disabled={isLoading}
						/>
						<div className="flex flex-col gap-2">
							{isRunning ? (
								<Button
									variant="destructive"
									size="icon"
									onClick={cancel}
									className="h-[60px] w-[60px]"
								>
									<Square className="h-5 w-5" />
								</Button>
							) : (
								<Button
									size="icon"
									onClick={() => handleSubmit()}
									disabled={!inputValue.trim() || isLoading}
									className="h-[60px] w-[60px]"
								>
									<Send className="h-5 w-5" />
								</Button>
							)}
						</div>
					</div>
					<p className="text-xs text-muted-foreground mt-2 text-center">
						Press Enter to send, Shift+Enter for new line
					</p>
				</div>
			</footer>
		</div>
	);
}
