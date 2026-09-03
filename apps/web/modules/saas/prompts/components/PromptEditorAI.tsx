"use client";

import {
	CopilotKit,
	useCopilotAction,
	useCopilotChat,
	useCopilotReadable,
} from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { CopilotAssistantMessageForPromptEnhancer } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import "@copilotkit/react-ui/styles.css";
import { EditorToolbar } from "@saas/projects/components/EditorToolbar";
import {
	createPromptExtensions,
	getFormatDescription,
	getSyntaxExamples,
} from "@saas/projects/lib/tiptap-extensions-prompts-dynamic";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { EditorContent, useEditor } from "@tiptap/react";
import "./PromptEditorAI.css";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	Code2Icon,
	EyeIcon,
	Loader2,
	SaveIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import TurndownService from "turndown";
// @ts-expect-error - turndown-plugin-gfm has no types
import { gfm } from "turndown-plugin-gfm";

type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";
type PromptScope = "SYSTEM" | "ORG" | "USER";

type Props = {
	initialData?: {
		name: string;
		description?: string;
		scope: PromptScope;
		format: PromptFormat;
		category?: string;
		tags: string[];
		isPublic: boolean;
		content?: string;
	};
	onSave: (data: {
		name: string;
		description?: string;
		scope: PromptScope;
		format: PromptFormat;
		category?: string;
		tags: string[];
		isPublic: boolean;
		content?: string;
	}) => void;
	onCancel: () => void;
	isLoading?: boolean;
	canEditScope?: boolean;
	organizationId?: string;
};

// Convert HTML to Markdown
const turndownService = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});
turndownService.use(gfm);

function toMarkdown(html: string): string {
	return turndownService.turndown(html);
}

// Convert Markdown to HTML (simple implementation)
function fromMarkdown(markdown: string): string {
	return `<p>${markdown.replace(/\n/g, "</p><p>")}</p>`;
}

// Helper functions to provide AI context
function getTemplateFormatGuide(format: PromptFormat): string {
	const guides: Record<PromptFormat, string> = {
		PLAIN_TEXT:
			"Plain text format with no special syntax. Use simple {variable} placeholders if needed.",
		MARKDOWN:
			"Markdown format supporting headers, lists, code blocks, and emphasis. Use {variable} for placeholders.",
		HANDLEBARS:
			"Handlebars template syntax: {{variable}} for simple variables, {{#each items}}{{this}}{{/each}} for loops, {{#if condition}}...{{/if}} for conditionals.",
		MUSTACHE:
			"Mustache template syntax: {{variable}} for variables, {{#items}}{{name}}{{/items}} for sections, {{^items}}No items{{/items}} for inverted sections.",
		LIQUID: "Liquid template syntax: {{ variable }} for output, {% if condition %}...{% endif %} for logic, {% for item in items %}...{% endfor %} for loops.",
		JINJA2: "Jinja2 template syntax: {{ variable }} for variables, {% if condition %}...{% endif %} for conditionals, {% for item in items %}...{% endfor %} for loops, {{ variable | filter }} for filters.",
	};
	return guides[format];
}

function getSuggestedVariables(
	category: string | undefined,
	_format: PromptFormat,
): string[] {
	if (!category) {
		return [];
	}

	const categoryLower = category.toLowerCase();

	// Document generation prompts
	if (
		categoryLower.includes("document") ||
		categoryLower.includes("prd") ||
		categoryLower.includes("spec")
	) {
		return [
			"projectName",
			"projectDescription",
			"goals",
			"features",
			"techStack",
			"timeline",
			"stakeholders",
		];
	}

	// Code generation prompts
	if (
		categoryLower.includes("code") ||
		categoryLower.includes("programming")
	) {
		return [
			"language",
			"framework",
			"functionality",
			"requirements",
			"constraints",
			"testCases",
		];
	}

	// Agent instruction prompts
	if (
		categoryLower.includes("agent") ||
		categoryLower.includes("assistant")
	) {
		return [
			"agentName",
			"role",
			"capabilities",
			"constraints",
			"tone",
			"examples",
		];
	}

	// Workflow prompts
	if (
		categoryLower.includes("workflow") ||
		categoryLower.includes("process")
	) {
		return [
			"workflowName",
			"steps",
			"inputs",
			"outputs",
			"conditions",
			"errorHandling",
		];
	}

	return ["title", "description", "context", "requirements"];
}

function getBestPractices(
	category: string | undefined,
	format: PromptFormat,
): string[] {
	const practices: string[] = [];

	// Format-specific practices
	if (
		format === "HANDLEBARS" ||
		format === "MUSTACHE" ||
		format === "LIQUID" ||
		format === "JINJA2"
	) {
		practices.push("Use template variables for dynamic content");
		practices.push(
			"Include default values or fallbacks for optional variables",
		);
		practices.push(
			"Document required vs optional variables in the description",
		);
	}

	// Category-specific practices
	if (category) {
		const categoryLower = category.toLowerCase();

		if (categoryLower.includes("document")) {
			practices.push(
				"Structure content with clear sections and headings",
			);
			practices.push("Include examples or templates for each section");
			practices.push("Specify the expected output format and length");
		}

		if (categoryLower.includes("code")) {
			practices.push("Specify programming language and framework");
			practices.push("Include code style and formatting requirements");
			practices.push("Request error handling and edge cases");
		}

		if (categoryLower.includes("agent")) {
			practices.push("Define the agent's role and personality clearly");
			practices.push("Specify capabilities and limitations");
			practices.push("Include example interactions");
		}
	}

	// General practices
	practices.push("Be specific and clear about the desired output");
	practices.push("Use examples to illustrate expectations");
	practices.push("Keep prompts focused on a single task or purpose");

	return practices;
}

function getExamplePrompts(category: string | undefined): string[] {
	if (!category) {
		return [];
	}

	const categoryLower = category.toLowerCase();

	if (categoryLower.includes("document") || categoryLower.includes("prd")) {
		return [
			"Generate a Product Requirements Document for {{projectName}}. Include: Overview, Goals, Features, Success Metrics, and Timeline.",
			"Create a Technical Specification for {{projectName}}. Cover: Architecture, Tech Stack, API Design, Data Models, and Security Considerations.",
		];
	}

	if (categoryLower.includes("code")) {
		return [
			"Generate {{language}} code for {{functionality}}. Requirements: {{requirements}}. Include error handling and unit tests.",
			"Create a {{framework}} component that {{description}}. Follow best practices and include TypeScript types.",
		];
	}

	if (categoryLower.includes("agent")) {
		return [
			"You are {{agentName}}, a {{role}}. Your capabilities include: {{capabilities}}. Help users with {{tasks}}.",
			"Act as {{role}}. Your goal is to {{goal}}. Use a {{tone}} tone and provide {{outputFormat}} responses.",
		];
	}

	return [];
}

export function PromptEditorAI(props: Props) {
	const { organizationId } = props;
	const onError = useCopilotErrorHandler();

	return (
		<CopilotKit
			runtimeUrl={
				organizationId
					? `/api/copilotkit?organizationId=${organizationId}`
					: "/api/copilotkit"
			}
			useSingleEndpoint
			agent="prompt_enhancer"
			showDevConsole={false}
			onError={onError}
		>
			<PromptEditorAIInner {...props} />
		</CopilotKit>
	);
}

function PromptEditorAIInner({
	initialData,
	onSave,
	onCancel,
	isLoading = false,
	canEditScope = true,
	organizationId,
}: Props) {
	const [name, setName] = useState(initialData?.name ?? "");
	const [description, setDescription] = useState(
		initialData?.description ?? "",
	);
	const [scope, setScope] = useState<PromptScope>(
		initialData?.scope ?? (organizationId ? "ORG" : "USER"),
	);
	const [format, setFormat] = useState<PromptFormat>(
		initialData?.format ?? "PLAIN_TEXT",
	);
	const [category, setCategory] = useState(initialData?.category ?? "");
	const [tags, setTags] = useState<string[]>(initialData?.tags ?? []);
	const [tagInput, setTagInput] = useState("");
	const [isPublic] = useState(initialData?.isPublic ?? false);
	const [currentContent, setCurrentContent] = useState(
		initialData?.content ?? "",
	);
	const [isMetadataOpen, setIsMetadataOpen] = useState(true);
	const [viewMode, setViewMode] = useState<"rich" | "raw">("raw");
	const [rawContent, setRawContent] = useState(initialData?.content ?? "");

	const { isLoading: isAILoading } = useCopilotChat();

	// Initialize TipTap editor with format-specific extensions
	const editor = useEditor({
		extensions: createPromptExtensions(format),
		immediatelyRender: false,
		editorProps: {
			attributes: { class: "min-h-[400px] p-4 tiptap" },
		},
		content: initialData?.content ? fromMarkdown(initialData.content) : "",
		onUpdate: ({ editor }) => {
			if (editor.isEditable && !isAILoading) {
				const html = editor.getHTML();
				const markdown = toMarkdown(html);
				setCurrentContent(markdown);
			}
		},
	});

	// Initialize content
	useEffect(() => {
		if (initialData?.content && currentContent.length === 0) {
			setCurrentContent(initialData.content);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor]);

	// Make editor read-only during AI updates
	useEffect(() => {
		if (isAILoading) {
			editor?.setEditable(false);
		} else {
			editor?.setEditable(true);
		}
	}, [isAILoading, editor]);

	// Update editor extensions when format changes
	useEffect(() => {
		if (editor) {
			// Recreate editor with new extensions for the selected format
			const content = editor.getHTML();
			editor.commands.clearContent();
			editor.extensionManager.extensions.forEach((ext) => {
				if (ext.name === "placeholder") {
					editor.extensionManager.extensions.splice(
						editor.extensionManager.extensions.indexOf(ext),
						1,
					);
				}
			});
			// Update extensions configuration
			editor.setOptions({
				extensions: createPromptExtensions(format),
			});
			editor.commands.setContent(content);
		}
	}, [format, editor]);

	// Sync raw content when currentContent changes (from editor updates)
	useEffect(() => {
		if (viewMode === "rich") {
			setRawContent(currentContent);
		}
	}, [currentContent, viewMode]);

	// Handle switching from raw to rich view
	const handleViewModeToggle = () => {
		if (viewMode === "raw") {
			// Switching from raw to rich - update editor with raw content
			setCurrentContent(rawContent);
			if (editor) {
				editor.commands.setContent(fromMarkdown(rawContent));
			}
			setViewMode("rich");
		} else {
			// Switching from rich to raw - already synced
			setViewMode("raw");
		}
	};

	// Handle raw content changes
	const handleRawContentChange = (value: string) => {
		setRawContent(value);
		setCurrentContent(value);
	};

	// Keyboard shortcut for toggling view mode (Ctrl+Shift+V or Cmd+Shift+V)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "V") {
				e.preventDefault();
				handleViewModeToggle();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewMode, rawContent]);

	// Expose comprehensive prompt context to CopilotKit for better AI assistance
	useCopilotReadable({
		description: "The current prompt being edited with full context",
		value: {
			// Basic metadata
			name,
			description,
			format,
			category,
			tags,
			content: currentContent,
			scope,

			// Purpose and usage context
			purpose: category
				? `This prompt is used for ${category.toLowerCase()} tasks`
				: "General purpose prompt",
			usageContext: `This prompt will be used by ${scope === "SYSTEM" ? "system-level operations" : scope === "ORG" ? "organization members" : "individual users"}`,

			// Template format guidance
			templateFormatGuide: getTemplateFormatGuide(format),

			// Common variables for this category
			suggestedVariables: getSuggestedVariables(category, format),

			// Best practices for this prompt type
			bestPractices: getBestPractices(category, format),

			// Example prompts in the same category
			examplePrompts: getExamplePrompts(category),
		},
	});

	// AI action to update prompt content
	useCopilotAction({
		name: "update_prompt_content",
		description:
			"Update the prompt content. Use this to rewrite, enhance, expand, clarify, or restructure the prompt based on user instructions.",
		parameters: [
			{
				name: "content",
				type: "string",
				description: "The updated prompt content",
				required: true,
			},
		],
		handler: async ({ content }) => {
			setCurrentContent(content);
			editor?.commands.setContent(fromMarkdown(content));
			return "Prompt content updated successfully";
		},
	});

	// AI action to add template variables
	useCopilotAction({
		name: "add_template_variables",
		description:
			"Add template variable placeholders to the prompt based on the selected format (Handlebars, Mustache, Liquid, Jinja2).",
		parameters: [
			{
				name: "variables",
				type: "string",
				description: "Comma-separated list of variable names to add",
				required: true,
			},
		],
		handler: async ({ variables }) => {
			const varList = variables.split(",").map((v) => v.trim());
			let variableSyntax = "";

			switch (format) {
				case "HANDLEBARS":
					variableSyntax = varList.map((v) => `{{${v}}}`).join(", ");
					break;
				case "MUSTACHE":
					variableSyntax = varList.map((v) => `{{${v}}}`).join(", ");
					break;
				case "LIQUID":
					variableSyntax = varList
						.map((v) => `{{ ${v} }}`)
						.join(", ");
					break;
				case "JINJA2":
					variableSyntax = varList
						.map((v) => `{{ ${v} }}`)
						.join(", ");
					break;
				default:
					variableSyntax = varList.map((v) => `{${v}}`).join(", ");
			}

			const updatedContent = `${currentContent}\n\nVariables: ${variableSyntax}`;
			setCurrentContent(updatedContent);
			editor?.commands.setContent(fromMarkdown(updatedContent));
			return `Added template variables: ${variableSyntax}`;
		},
	});

	const handleAddTag = () => {
		const trimmedTag = tagInput.trim();
		if (trimmedTag && !tags.includes(trimmedTag)) {
			setTags([...tags, trimmedTag]);
			setTagInput("");
		}
	};

	const handleRemoveTag = (tagToRemove: string) => {
		setTags(tags.filter((tag) => tag !== tagToRemove));
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		onSave({
			name,
			description: description || undefined,
			scope,
			format,
			category: category || undefined,
			tags,
			isPublic,
			content: currentContent || undefined,
		});
	};

	return (
		<div className="flex gap-6">
			<div className="flex-1">
				<form onSubmit={handleSubmit} className="space-y-6">
					<Collapsible
						open={isMetadataOpen}
						onOpenChange={setIsMetadataOpen}
					>
						<Card className="p-6">
							<CollapsibleTrigger asChild>
								<button
									type="button"
									className="flex items-center justify-between w-full text-left"
								>
									<div>
										<h2 className="text-xl font-semibold">
											Prompt Details
										</h2>
										<p className="text-sm text-muted-foreground mt-1">
											{name || "Untitled Prompt"} •{" "}
											{format} • {scope}
										</p>
									</div>
									{isMetadataOpen ? (
										<ChevronUpIcon className="h-5 w-5 text-muted-foreground" />
									) : (
										<ChevronDownIcon className="h-5 w-5 text-muted-foreground" />
									)}
								</button>
							</CollapsibleTrigger>

							<CollapsibleContent className="mt-6">
								<div className="space-y-4">
									{/* Name */}
									<div className="grid grid-cols-[200px_1fr] gap-4 items-start">
										<Label htmlFor="name" className="pt-2">
											Name{" "}
											<span className="text-destructive">
												*
											</span>
										</Label>
										<Input
											id="name"
											value={name}
											onChange={(e) =>
												setName(e.target.value)
											}
											placeholder="Enter prompt name"
											required
										/>
									</div>

									{/* Description */}
									<div className="grid grid-cols-[200px_1fr] gap-4 items-start">
										<Label
											htmlFor="description"
											className="pt-2"
										>
											Description
										</Label>
										<Input
											id="description"
											value={description}
											onChange={(e) =>
												setDescription(e.target.value)
											}
											placeholder="Describe what this prompt does"
										/>
									</div>

									{/* Scope */}
									<div className="grid grid-cols-[200px_1fr] gap-4 items-start">
										<Label htmlFor="scope" className="pt-2">
											Scope{" "}
											<span className="text-destructive">
												*
											</span>
										</Label>
										<Select
											value={scope}
											onValueChange={(value) =>
												setScope(value as PromptScope)
											}
											disabled={!canEditScope}
										>
											<SelectTrigger id="scope">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{!organizationId && (
													<SelectItem value="USER">
														Personal
													</SelectItem>
												)}
												{organizationId && (
													<SelectItem value="ORG">
														Organization
													</SelectItem>
												)}
												<SelectItem value="SYSTEM">
													System
												</SelectItem>
											</SelectContent>
										</Select>
									</div>

									{/* Format */}
									<div className="grid grid-cols-[200px_1fr] gap-4 items-start">
										<Label
											htmlFor="format"
											className="pt-2"
										>
											Format{" "}
											<span className="text-destructive">
												*
											</span>
										</Label>
										<Select
											value={format}
											onValueChange={(value) =>
												setFormat(value as PromptFormat)
											}
										>
											<SelectTrigger id="format">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="PLAIN_TEXT">
													Plain Text
												</SelectItem>
												<SelectItem value="MARKDOWN">
													Markdown
												</SelectItem>
												<SelectItem value="HANDLEBARS">
													Handlebars
												</SelectItem>
												<SelectItem value="MUSTACHE">
													Mustache
												</SelectItem>
												<SelectItem value="LIQUID">
													Liquid
												</SelectItem>
												<SelectItem value="JINJA2">
													Jinja2
												</SelectItem>
											</SelectContent>
										</Select>
									</div>

									{/* Category */}
									<div className="grid grid-cols-[200px_1fr] gap-4 items-start">
										<Label
											htmlFor="category"
											className="pt-2"
										>
											Category
										</Label>
										<Input
											id="category"
											value={category}
											onChange={(e) =>
												setCategory(e.target.value)
											}
											placeholder="e.g., Documentation, Code Generation"
										/>
									</div>

									{/* Tags */}
									<div className="grid grid-cols-[200px_1fr] gap-4 items-start">
										<Label htmlFor="tags" className="pt-2">
											Tags
										</Label>
										<div className="space-y-2">
											<div className="flex gap-2">
												<Input
													id="tags"
													value={tagInput}
													onChange={(e) =>
														setTagInput(
															e.target.value,
														)
													}
													onKeyDown={(e) => {
														if (e.key === "Enter") {
															e.preventDefault();
															handleAddTag();
														}
													}}
													placeholder="Add tags (press Enter)"
												/>
												<Button
													type="button"
													onClick={handleAddTag}
													variant="secondary"
												>
													Add
												</Button>
											</div>
											{tags.length > 0 && (
												<div className="flex flex-wrap gap-2">
													{tags.map((tag) => (
														<Badge
															key={tag}
															variant="secondary"
														>
															{tag}
															<button
																type="button"
																onClick={() =>
																	handleRemoveTag(
																		tag,
																	)
																}
																className="ml-1 hover:text-destructive"
															>
																<XIcon className="h-3 w-3" />
															</button>
														</Badge>
													))}
												</div>
											)}
										</div>
									</div>
								</div>
							</CollapsibleContent>
						</Card>
					</Collapsible>

					{/* Content Editor */}
					<Card className="overflow-hidden">
						<div className="flex items-center justify-between p-6 pb-4">
							<div className="flex items-center gap-3">
								<h2 className="text-xl font-semibold">
									Prompt Content
								</h2>
								<Badge variant="secondary" className="text-xs">
									{format === "PLAIN_TEXT"
										? "Plain Text"
										: format === "MARKDOWN"
											? "Markdown"
											: format === "HANDLEBARS"
												? "Handlebars"
												: format === "MUSTACHE"
													? "Mustache"
													: format === "LIQUID"
														? "Liquid"
														: "Jinja2"}
								</Badge>
							</div>
							<div className="flex items-center gap-3">
								{isAILoading && (
									<div className="flex items-center gap-2 text-sm text-muted-foreground">
										<FabricLogo
											className="h-4 w-4 opacity-80"
											size={16}
										/>
										AI is enhancing your prompt...
									</div>
								)}
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant={
													viewMode === "raw"
														? "default"
														: "outline"
												}
												size="sm"
												onClick={handleViewModeToggle}
												disabled={isAILoading}
											>
												{viewMode === "rich" ? (
													<>
														<Code2Icon className="h-4 w-4 mr-2" />
														Raw
													</>
												) : (
													<>
														<EyeIcon className="h-4 w-4 mr-2" />
														Rich
													</>
												)}
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											<p>
												{viewMode === "rich"
													? "Switch to raw text view"
													: "Switch to rich editor"}
											</p>
											<p className="text-xs text-muted-foreground">
												{navigator.platform.includes(
													"Mac",
												)
													? "⌘"
													: "Ctrl"}
												+Shift+V
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							</div>
						</div>

						{viewMode === "rich" ? (
							<>
								{/* Editor Toolbar */}
								<EditorToolbar editor={editor} />

								<div className="p-6 pt-4">
									<EditorContent editor={editor} />
									<div className="mt-4 space-y-2">
										<p className="text-xs text-muted-foreground">
											{getFormatDescription(format)}
										</p>
										{format !== "PLAIN_TEXT" && (
											<details className="text-xs">
												<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
													View syntax examples for{" "}
													{format}
												</summary>
												<div className="mt-2 p-3 bg-muted/50 rounded-md space-y-1">
													{getSyntaxExamples(
														format,
													).map((example, index) => (
														<div
															key={index}
															className="font-mono text-xs"
														>
															{example}
														</div>
													))}
												</div>
											</details>
										)}
									</div>
								</div>
							</>
						) : (
							<div className="p-6">
								<Textarea
									value={rawContent}
									onChange={(e) =>
										handleRawContentChange(e.target.value)
									}
									placeholder={`Enter your ${format.toLowerCase().replace("_", " ")} prompt here...`}
									rows={20}
									className="font-mono text-sm resize-none"
									disabled={isAILoading}
								/>
								<div className="mt-4 space-y-2">
									<p className="text-xs text-muted-foreground">
										Raw{" "}
										{format.toLowerCase().replace("_", " ")}{" "}
										view. Edit the template directly.
									</p>
									{format !== "PLAIN_TEXT" && (
										<details className="text-xs">
											<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
												View syntax examples for{" "}
												{format}
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
						)}
					</Card>

					{/* Actions */}
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={onCancel}
							disabled={isLoading}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={isLoading || !name}>
							{isLoading ? (
								<>
									<Loader2 className="h-4 w-4 mr-2 animate-spin" />
									Saving...
								</>
							) : (
								<>
									<SaveIcon className="h-4 w-4 mr-2" />
									Save Prompt
								</>
							)}
						</Button>
					</div>
				</form>
			</div>

			{/* AI Sidebar */}
			<CopilotSidebar
				AssistantMessage={CopilotAssistantMessageForPromptEnhancer}
				defaultOpen={false}
				clickOutsideToClose={false}
				labels={{
					title: "AI Assistant",
					initial:
						"Hi! I can help you enhance and improve your prompt. I understand the context, format, and best practices for your prompt type.\n\nTry asking me to:\n• Rewrite for clarity and professionalism\n• Add template variables in the correct format\n• Expand sections with more detail\n• Restructure content for better flow\n• Apply best practices for this prompt category",
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
			/>
		</div>
	);
}
