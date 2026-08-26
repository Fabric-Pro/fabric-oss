"use client";

import {
	useCoAgent,
	useCopilotAction,
	useCopilotChat,
	useCopilotReadable,
} from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { CopilotAssistantMessageForPromptEnhancer } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import "@copilotkit/react-ui/styles.css";
import "./PromptContentEnhancer.css";
import { diffPartialText, diffToHtml } from "@saas/projects/lib/diff-utils";
import {
	getFormatDescription,
	getSyntaxExamples,
} from "@saas/projects/lib/tiptap-extensions-prompts-dynamic";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { Loader2, SaveIcon, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

type Props = {
	promptId: string;
	promptName: string;
	promptDescription?: string;
	format: PromptFormat;
	category?: string;
	tags: string[];
	initialContent?: string;
	onSave: (content: string) => void;
	onCancel: () => void;
	isLoading?: boolean;
	showTitle?: boolean;
};

// Agent state interface matching the LangGraph agent's state annotation
interface AgentState {
	promptId: string;
	promptName: string;
	promptDescription?: string;
	format: PromptFormat;
	category?: string;
	tags: string[];
	currentContent: string;
	enhancementType: string;
	userInstructions?: string;
	enhancedContent: string;
	streamingContent: string;
	explanation?: string;
	focusAnchor?: string;
	error?: string;
	retryCount?: number;
	/**
	 * Per-turn reasoning trace populated by enhance-node.ts. Declared here
	 * AND seeded in `useCoAgent`'s `initialState` for STATE_SNAPSHOT events
	 * to survive CopilotKit's key filter.
	 */
	reasoningByTurn?: Record<
		number,
		{
			text: string;
			durationMs: number;
			startedAt: number;
			completedAt: number;
		}
	>;
}

// Get format display name
function getFormatDisplayName(format: PromptFormat): string {
	const formatNames: Record<PromptFormat, string> = {
		PLAIN_TEXT: "Plain Text",
		MARKDOWN: "Markdown",
		HANDLEBARS: "Handlebars",
		MUSTACHE: "Mustache",
		LIQUID: "Liquid",
		JINJA2: "Jinja2",
	};
	return formatNames[format];
}

// Helper functions to provide AI context
function getTemplateFormatGuide(format: PromptFormat): string {
	const guides: Record<PromptFormat, string> = {
		PLAIN_TEXT:
			"Plain text format with no special syntax. Use simple {variable} placeholders if needed.",
		MARKDOWN:
			"Markdown format supporting headers, lists, code blocks, and emphasis. Use {variable} for placeholders.",
		HANDLEBARS:
			"⚠️ HANDLEBARS TEMPLATE - MUST preserve exactly: {{variable}} for simple variables, {{#each items}}{{this}}{{/each}} for loops, {{#if condition}}...{{/if}} for conditionals. NEVER change {{var}} to [var] or {var}!",
		MUSTACHE:
			"⚠️ MUSTACHE TEMPLATE - MUST preserve exactly: {{variable}} for variables, {{#items}}{{name}}{{/items}} for sections. NEVER change {{var}} to [var] or {var}!",
		LIQUID: "⚠️ LIQUID TEMPLATE - MUST preserve exactly: {{ variable }} for output (WITH spaces), {% if %}...{% endif %} for logic. NEVER change {{ var }} to [var] or {var}!",
		JINJA2: "⚠️ JINJA2 TEMPLATE - MUST preserve exactly: {{ variable }} for variables (WITH spaces), {% if %}...{% endif %} for conditionals, {{ var | filter }} for filters. NEVER change {{ var }} to [var] or {var}!",
	};
	return guides[format];
}

export function PromptContentEnhancer({
	promptId,
	promptName,
	promptDescription,
	format,
	category,
	tags,
	initialContent = "",
	onSave,
	onCancel,
	isLoading = false,
	showTitle = true,
}: Props) {
	// State for editor content
	const [currentContent, setCurrentContent] = useState(initialContent);
	const [displayContent, setDisplayContent] = useState(initialContent);
	const { isLoading: isAILoading } = useCopilotChat();

	// Refs to store latest values for callbacks
	const currentContentRef = useRef<string>(currentContent);
	const agentStateRef = useRef<AgentState | null>(null);

	// Keep refs in sync
	useEffect(() => {
		currentContentRef.current = currentContent;
	}, [currentContent]);

	// Initialize CopilotKit agent state
	const {
		state: agentState,
		setState: setAgentState,
		nodeName,
	} = useCoAgent<AgentState>({
		name: "prompt_enhancer",
		initialState: {
			promptId,
			promptName,
			promptDescription,
			format,
			category,
			tags,
			currentContent: initialContent,
			enhancementType: "general",
			userInstructions: undefined,
			enhancedContent: initialContent,
			streamingContent: initialContent,
			explanation: undefined,
			focusAnchor: undefined,
			error: undefined,
			retryCount: 0,
			// Declare reasoningByTurn in initialState so CopilotKit's
			// useCoAgent doesn't filter it out of STATE_SNAPSHOT updates.
			// Same rationale as DocumentEditor.tsx:1286.
			reasoningByTurn: {},
		},
	});

	// Keep agentStateRef in sync
	useEffect(() => {
		agentStateRef.current = agentState;
	}, [agentState]);

	// Track whether we've initialized the agent state
	const agentStateInitializedRef = useRef(false);

	// Initialize agent state with content on mount
	useEffect(() => {
		if (initialContent && !agentStateInitializedRef.current) {
			console.log("[PromptContentEnhancer] Initializing agent state", {
				contentLength: initialContent.length,
			});
			agentStateInitializedRef.current = true;
			setAgentState({
				...agentState,
				currentContent: initialContent,
				enhancedContent: initialContent,
				streamingContent: initialContent,
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialContent]);

	// === STREAMING PATTERN - RAW TEXT WITH DIFF HIGHLIGHTING ===
	// Matches DocumentEditor pattern from ag-ui-demo

	// Track previous loading state to detect transition from loading to not loading
	const wasLoadingRef = useRef(false);
	// Track if we're showing diff (post-streaming state)
	const showingDiffRef = useRef(false);
	// Track baseline content captured when loading starts
	const baselineRef = useRef<string>("");

	// 1. Capture baseline when loading starts
	useEffect(() => {
		if (isAILoading && !wasLoadingRef.current) {
			// Just started loading - capture baseline
			baselineRef.current = currentContent;
			showingDiffRef.current = false;
			console.log(
				"[PromptContentEnhancer] Loading started, baseline captured:",
				{
					baselineLength: currentContent.length,
				},
			);
		}
		wasLoadingRef.current = isAILoading;
	}, [isAILoading, currentContent]);

	// 2. Handle final update when agent completes (nodeName == "end")
	// IMPORTANT: Also depend on agentState?.streamingContent to ensure we have the final content
	// before calculating the diff. This prevents race conditions where the effect runs
	// before the state update is applied.
	useEffect(() => {
		if (nodeName === "end" && !isAILoading) {
			const baseline = baselineRef.current;
			const newContent = agentState?.streamingContent || "";

			// Only show diff if we have BOTH baseline AND new content
			if (
				baseline.trim().length > 0 &&
				newContent.trim().length > 0 &&
				baseline !== newContent
			) {
				// Final diff with isComplete=true to show full changes including trailing deletions
				const diff = diffPartialText(baseline, newContent, true);
				// Convert placeholder tokens to HTML for display
				const diffHtml = diffToHtml(diff);
				setDisplayContent(diffHtml);
				showingDiffRef.current = true;
				console.log("[PromptContentEnhancer] Final diff set:", {
					baselineLength: baseline.length,
					newContentLength: newContent.length,
					diffLength: diffHtml.length,
				});
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeName, isAILoading, agentState?.streamingContent]);

	// 3. Handle streaming updates
	useEffect(() => {
		if (isAILoading) {
			const baseline = baselineRef.current;
			const newContent = agentState?.streamingContent || "";

			// Skip if content is empty or unchanged from baseline
			if (newContent.trim().length === 0 || newContent === baseline) {
				return;
			}

			if (baseline.trim().length > 0) {
				// Has baseline - show diff highlighting (isComplete=false during streaming)
				const diff = diffPartialText(baseline, newContent, false);
				// Convert placeholder tokens to HTML for display
				const diffHtml = diffToHtml(diff);
				setDisplayContent(diffHtml);
			} else {
				// No baseline - just show content (escaped for HTML display)
				const escapedContent = newContent
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;");
				setDisplayContent(escapedContent);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentState?.streamingContent, isAILoading]);

	// 4. Sync content when user is editing (not during/after AI streaming)
	// This should NOT run when streaming just ended - only when user actually types
	useEffect(() => {
		// Skip if we're loading or showing diff from a completed stream
		if (isAILoading || showingDiffRef.current) {
			return;
		}
		// Only sync when user is actually editing
		setDisplayContent(currentContent);
		setAgentState({
			...agentState,
			streamingContent: currentContent,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentContent]);

	// Handle content changes from textarea
	const handleContentChange = (value: string) => {
		// User is editing - reset diff state
		showingDiffRef.current = false;
		setCurrentContent(value);
		setDisplayContent(value);
	};

	// Extract current template variables from content for preservation
	const extractedVariables = useMemo(() => {
		const vars = new Set<string>();
		if (currentContent) {
			// Extract various template patterns
			const patterns = [
				/\{\{[#/]?([^}]+)\}\}/g, // Handlebars/Mustache
				/\{%[^%]+%\}/g, // Liquid/Jinja2 blocks
				/\{\{[^}]+\}\}/g, // Template variables
			];
			for (const pattern of patterns) {
				const matches = currentContent.match(pattern);
				if (matches) {
					for (const match of matches) {
						vars.add(match);
					}
				}
			}
		}
		return Array.from(vars);
	}, [currentContent]);

	// Expose prompt context to CopilotKit
	useCopilotReadable({
		description: "The current prompt being enhanced",
		value: {
			promptId,
			name: promptName,
			description: promptDescription,
			format,
			category,
			tags,
			content: currentContent,
			templateFormatGuide:
				format !== "PLAIN_TEXT" && format !== "MARKDOWN"
					? getTemplateFormatGuide(format)
					: undefined,
			existingTemplateVariables:
				extractedVariables.length > 0 ? extractedVariables : undefined,
			templatePreservationWarning:
				extractedVariables.length > 0
					? `CRITICAL: Preserve these exact template expressions: ${extractedVariables.join(", ")}`
					: undefined,
			enhancementGuidelines:
				"Focus on improving clarity, structure, and effectiveness. Do NOT add template variables unless the user specifically asks for them.",
		},
	});

	// Confirmation action
	useCopilotAction(
		{
			name: "confirm_changes",
			renderAndWaitForResponse: ({ args, respond, status }) => (
				<ConfirmChanges
					args={args}
					respond={respond}
					status={status}
					onConfirm={() => {
						// Reset diff state - user accepted changes
						showingDiffRef.current = false;
						const newContent =
							agentStateRef.current?.streamingContent || "";
						setCurrentContent(newContent);
						setDisplayContent(newContent);
						// Update baseline to new content
						baselineRef.current = newContent;
						if (agentStateRef.current) {
							setAgentState({
								...agentStateRef.current,
								currentContent: newContent,
								enhancedContent: newContent,
								streamingContent: newContent,
							} as AgentState);
						}
						onSave(newContent);
					}}
					onReject={() => {
						// Reset diff state - user rejected changes
						showingDiffRef.current = false;
						const oldContent = currentContentRef.current;
						setDisplayContent(oldContent);
						if (agentStateRef.current) {
							setAgentState({
								...agentStateRef.current,
								streamingContent: oldContent,
								enhancedContent: oldContent,
							} as AgentState);
						}
					}}
				/>
			),
		},
		[agentState?.streamingContent],
	);

	const handleSave = () => {
		onSave(currentContent);
	};

	// Determine if we should show diff highlighting (during/after AI streaming)
	// Use the ref to track post-streaming diff state
	const showDiffHighlighting = isAILoading || showingDiffRef.current;

	return (
		<CopilotSidebar
			AssistantMessage={CopilotAssistantMessageForPromptEnhancer}
			defaultOpen={true}
			clickOutsideToClose={false}
			labels={{
				title: "AI Assistant",
				initial:
					"Hi! I can help you enhance and improve your prompt.\n\nTry asking me to:\n• Rewrite for clarity and professionalism\n• Add template variables in the correct format\n• Expand sections with more detail\n• Restructure content for better flow",
			}}
			suggestions={[
				{
					title: "Rewrite for clarity",
					message:
						"Rewrite this prompt to be more clear and professional",
				},
				{
					title: "Add template variables",
					message: `Add appropriate template variables in ${format} format`,
				},
				{
					title: "Expand with examples",
					message: "Expand this prompt with concrete examples",
				},
				{
					title: "Apply best practices",
					message: `Apply best practices for ${category || "this type of"} prompts`,
				},
			]}
		>
			<div className="flex flex-col h-screen bg-background">
				{/* Top Bar with Actions */}
				<div className="flex items-center justify-between px-6 py-3 border-b bg-background gap-4">
					{/* AI Generating Indicator - Centered when active */}
					{isAILoading ? (
						<>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={onCancel}
								className="shrink-0"
							>
								<X className="h-4 w-4" />
							</Button>
							<div className="flex-1 flex justify-center">
								<div className="relative flex items-center gap-3 px-5 py-2 rounded-full bg-gradient-to-r from-violet-500/20 via-purple-500/20 to-fuchsia-500/20 border border-purple-500/40 shadow-lg shadow-purple-500/20">
									<div className="absolute inset-0 rounded-full bg-gradient-to-r from-violet-500/30 via-purple-500/30 to-fuchsia-500/30 animate-pulse" />
									<div
										className="absolute inset-0 rounded-full bg-purple-500/20 animate-ping opacity-50"
										style={{ animationDuration: "1.5s" }}
									/>
									<div className="relative">
										<FabricLogo
											className="h-5 w-5 opacity-90"
											size={20}
											variant="dark"
										/>
									</div>
									<span className="relative text-base font-semibold bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500 bg-clip-text text-transparent">
										AI is enhancing...
									</span>
								</div>
							</div>
							<div className="w-[40px]" />{" "}
							{/* Spacer to balance the close button */}
						</>
					) : (
						<>
							<div className="flex items-center gap-3 min-w-0 flex-1">
								{showTitle && (
									<>
										<h2 className="text-lg font-semibold truncate">
											{promptName}
										</h2>
										<Badge
											variant="secondary"
											className="text-xs shrink-0"
										>
											{getFormatDisplayName(format)}
										</Badge>
									</>
								)}
								{showTitle && promptDescription && (
									<span className="text-sm text-muted-foreground truncate hidden xl:inline">
										{promptDescription}
									</span>
								)}
							</div>
							<div className="flex items-center gap-2 shrink-0">
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={onCancel}
									disabled={isLoading}
								>
									<X className="h-4 w-4" />
								</Button>
								<Button
									onClick={handleSave}
									disabled={isLoading}
									size="sm"
								>
									{isLoading ? (
										<>
											<Loader2 className="h-4 w-4 animate-spin" />
											<span className="ml-2 hidden sm:inline">
												Saving...
											</span>
										</>
									) : (
										<>
											<SaveIcon className="h-4 w-4" />
											<span className="ml-2 hidden sm:inline">
												Save
											</span>
										</>
									)}
								</Button>
							</div>
						</>
					)}
				</div>

				{/* Editor Area */}
				<div className="flex-1 overflow-hidden bg-background p-6 flex flex-col">
					{showDiffHighlighting ? (
						// Show diff-highlighted content during AI streaming
						// displayContent already contains <em> and <s> tags from diffPartialText
						<div
							className="prompt-diff-display font-mono text-sm whitespace-pre-wrap flex-1 min-h-0 w-full p-4 border rounded-md bg-muted/30 overflow-auto"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: Diff HTML is generated internally from diffPartialText, not user input
							dangerouslySetInnerHTML={{ __html: displayContent }}
						/>
					) : (
						// Show editable textarea when not streaming
						<Textarea
							value={currentContent}
							onChange={(e) =>
								handleContentChange(e.target.value)
							}
							placeholder={`Enter your ${format.toLowerCase().replace("_", " ")} prompt here...`}
							className="font-mono text-sm resize-none flex-1 min-h-0 w-full"
							disabled={isAILoading}
						/>
					)}
					<div className="mt-4 space-y-2 shrink-0">
						<p className="text-xs text-muted-foreground">
							{getFormatDescription(format)}
						</p>
						{format !== "PLAIN_TEXT" && (
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
									View syntax examples for {format}
								</summary>
								<div className="mt-2 p-3 bg-muted/50 rounded-md space-y-1">
									{getSyntaxExamples(format).map(
										(example, index) => (
											<div
												key={index}
												className="font-mono text-xs"
											>
												{example}
											</div>
										),
									)}
								</div>
							</details>
						)}
					</div>
				</div>
			</div>
		</CopilotSidebar>
	);
}

interface ConfirmChangesProps {
	args: any;
	respond: any;
	status: any;
	onReject: () => void;
	onConfirm: () => void;
}

function ConfirmChanges({
	respond,
	status,
	onReject,
	onConfirm,
}: ConfirmChangesProps) {
	const [userChoice, setUserChoice] = useState<
		"accepted" | "rejected" | null
	>(null);
	const [hidden, setHidden] = useState(false);

	// Auto-dismiss after user makes a choice
	useEffect(() => {
		if (userChoice !== null) {
			const timer = setTimeout(() => setHidden(true), 2000);
			return () => clearTimeout(timer);
		}
	}, [userChoice]);

	const isCompleted = status !== "executing";

	if (isCompleted && userChoice === null) {
		return null;
	}

	if (hidden) {
		return null;
	}

	if (userChoice !== null) {
		return (
			<div
				data-testid="confirm-changes-modal"
				className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
			>
				<h2 className="text-lg font-bold mb-4 text-foreground">
					Confirm Changes
				</h2>
				<div className="flex justify-end">
					<div
						data-testid="status-display"
						className="mt-4 bg-muted text-muted-foreground py-2 px-4 rounded inline-block"
					>
						{userChoice === "accepted"
							? "✓ Changes accepted"
							: "✗ Changes discarded"}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			data-testid="confirm-changes-modal"
			className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
		>
			<h2 className="text-lg font-bold mb-4 text-foreground">
				Confirm Changes
			</h2>
			<p className="mb-6 text-foreground">
				Do you want to accept the enhanced prompt?
			</p>
			<div className="flex justify-end space-x-4">
				<button
					type="button"
					data-testid="reject-button"
					className="bg-muted text-muted-foreground py-2 px-4 rounded cursor-pointer hover:bg-muted/80"
					onClick={() => {
						if (respond) {
							setUserChoice("rejected");
							onReject();
							respond({ accepted: false });
						}
					}}
				>
					Reject
				</button>
				<button
					type="button"
					data-testid="confirm-button"
					className="bg-primary text-primary-foreground py-2 px-4 rounded cursor-pointer hover:bg-primary/90"
					onClick={() => {
						if (respond) {
							setUserChoice("accepted");
							onConfirm();
							respond({ accepted: true });
						}
					}}
				>
					Confirm
				</button>
			</div>
		</div>
	);
}
