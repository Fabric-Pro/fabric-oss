"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Loader2Icon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

// Schema for node updates (preserves ID, changes config)
interface NodeUpdate {
	nodeId: string;
	newLabel?: string;
	newConfig?: Record<string, unknown>;
}

// Enhanced response supporting both create and modify modes
export interface GeneratedWorkflowResponse {
	action: "replace" | "update" | "append";
	updates?: NodeUpdate[];
	nodes?: Array<{
		id: string;
		type: string;
		position: { x: number; y: number };
		data: {
			label: string;
			config?: Record<string, unknown>;
		};
	}>;
	edges?: Array<{
		id: string;
		source: string;
		target: string;
		sourceHandle?: string;
		targetHandle?: string;
	}>;
	removals?: string[];
	description?: string;
}

// Existing workflow structure for context
interface ExistingWorkflow {
	nodes: Array<{
		id: string;
		type: string;
		position: { x: number; y: number };
		data: Record<string, unknown>;
	}>;
	edges: Array<{
		id: string;
		source: string;
		target: string;
		sourceHandle?: string | null;
		targetHandle?: string | null;
	}>;
}

interface TextToWorkflowProps {
	organizationId?: string | null;
	currentNodes?: ExistingWorkflow["nodes"];
	currentEdges?: ExistingWorkflow["edges"];
	onWorkflowGenerated: (workflow: GeneratedWorkflowResponse) => void;
	/** If true, renders as inline input without popover */
	inline?: boolean;
}

export function TextToWorkflow({
	organizationId,
	currentNodes = [],
	currentEdges = [],
	onWorkflowGenerated,
	inline = false,
}: TextToWorkflowProps) {
	const [open, setOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);

	// Determine if we have an existing workflow (excluding placeholder nodes)
	const hasExistingWorkflow = currentNodes.some(
		(n) => n.type !== "add" && n.type !== "empty-action",
	);

	const handleGenerate = async () => {
		if (!prompt.trim()) {
			toast.error("Please enter a workflow description");
			return;
		}

		if (prompt.trim().length < 10) {
			toast.error(
				"Please provide a more detailed description (at least 10 characters)",
			);
			return;
		}

		setIsGenerating(true);

		try {
			// Build request body - include existing workflow for modify mode
			const requestBody: {
				prompt: string;
				organizationId?: string;
				mode: "create" | "modify";
				existingWorkflow?: ExistingWorkflow;
			} = {
				prompt: prompt.trim(),
				organizationId: organizationId ?? undefined,
				mode: hasExistingWorkflow ? "modify" : "create",
			};

			// Include existing workflow context when in modify mode
			if (hasExistingWorkflow) {
				// Filter out placeholder nodes before sending
				const realNodes = currentNodes.filter(
					(n) => n.type !== "add" && n.type !== "empty-action",
				);
				requestBody.existingWorkflow = {
					nodes: realNodes,
					edges: currentEdges,
				};
			}

			const response = await fetch("/api/ai/generate-workflow", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to generate workflow");
			}

			const workflow: GeneratedWorkflowResponse = await response.json();

			// Notify parent component
			onWorkflowGenerated(workflow);

			// Show success message based on action
			const actionMessages = {
				replace: "Workflow created successfully!",
				update: "Workflow updated successfully!",
				append: "Nodes added to workflow!",
			};
			toast.success(
				workflow.description || actionMessages[workflow.action],
			);

			// Reset and close
			setPrompt("");
			setOpen(false);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error
					? error.message
					: "Failed to generate workflow";
			console.error("Error generating workflow:", error);
			toast.error(errorMessage);
		} finally {
			setIsGenerating(false);
		}
	};

	const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && !isGenerating) {
			handleGenerate();
		}
	};

	// Inline version for bottom canvas
	if (inline) {
		return (
			<div className="space-y-3">
				<div className="flex gap-2">
					<Input
						id="workflow-prompt-inline"
						placeholder={
							hasExistingWorkflow
								? "Describe your workflow with natural language..."
								: "Describe your workflow with natural language..."
						}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyPress={handleKeyPress}
						disabled={isGenerating}
						className="flex-1"
					/>
					<Button
						onClick={handleGenerate}
						disabled={isGenerating || !prompt.trim()}
						className="gap-2"
					>
						{isGenerating ? (
							<>
								<Loader2Icon className="h-4 w-4 animate-spin" />
								Generating...
							</>
						) : (
							<>
								<SparklesIcon className="h-4 w-4" />
								Generate
							</>
						)}
					</Button>
				</div>
			</div>
		);
	}

	// Popover version for toolbar
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="gap-2"
					disabled={isGenerating}
				>
					<SparklesIcon className="h-4 w-4" />
					Generate with AI
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-[calc(100vw-1.5rem)] max-w-[400px]"
				align="end"
			>
				<div className="space-y-4">
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<Label
								htmlFor="workflow-prompt"
								className="text-sm font-medium"
							>
								{hasExistingWorkflow
									? "Describe changes to your workflow"
									: "Describe your workflow"}
							</Label>
							{open && (
								<Button
									variant="ghost"
									size="icon"
									className="h-6 w-6"
									onClick={() => setOpen(false)}
								>
									<XIcon className="h-4 w-4" />
								</Button>
							)}
						</div>
						<Input
							id="workflow-prompt"
							placeholder={
								hasExistingWorkflow
									? "E.g., Change the email recipient to sales@company.com..."
									: "E.g., Send me an email every time a new ticket is created in Linear..."
							}
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							onKeyPress={handleKeyPress}
							disabled={isGenerating}
							className="w-full"
						/>
						<p className="text-xs text-muted-foreground">
							{hasExistingWorkflow
								? "Describe what you want to change. AI will update existing nodes when possible."
								: "Describe what you want the workflow to do. AI will generate the nodes and connections."}
						</p>
					</div>

					<div className="flex gap-2">
						<Button
							onClick={handleGenerate}
							disabled={isGenerating || !prompt.trim()}
							className="flex-1 gap-2"
						>
							{isGenerating ? (
								<>
									<Loader2Icon className="h-4 w-4 animate-spin" />
									Generating...
								</>
							) : (
								<>
									<SparklesIcon className="h-4 w-4" />
									Generate Workflow
								</>
							)}
						</Button>
					</div>

					{/* Example prompts - different for create vs modify mode */}
					<div className="space-y-2 border-t pt-3">
						<p className="text-xs font-medium text-muted-foreground">
							Example prompts:
						</p>
						<div className="space-y-1">
							{(hasExistingWorkflow
								? [
										"Change the email recipient to support@company.com",
										"Add a delay of 5 minutes before the notification",
										"Remove the Slack notification step",
										"Update the AI prompt to include more details",
									]
								: [
										"Send me an email when a new Linear ticket is created",
										"Scrape a website and create a summary using AI",
										"Search the web and send results to Slack",
										"Generate a report and save it as a Linear ticket",
									]
							).map((example) => (
								<button
									key={example}
									type="button"
									onClick={() => setPrompt(example)}
									disabled={isGenerating}
									className="text-xs text-left text-primary hover:underline block w-full"
								>
									• {example}
								</button>
							))}
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
