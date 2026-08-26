"use client";

import { Badge } from "@ui/components/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
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
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	BrainCircuitIcon,
	ChevronDownIcon,
	HelpCircleIcon,
	MessageSquareTextIcon,
	SparklesIcon,
	WandIcon,
} from "lucide-react";
import { useState } from "react";

export interface FabricConfig {
	strategy?: string;
	context?: string;
	pattern?: string;
	variables?: Record<string, string>;
	enableAutoDetection?: boolean;
	/** Default user prompt for the LLM (defines the task - can be overridden per instance) */
	defaultPrompt?: string;
}

type Props = {
	value: FabricConfig;
	onChange: (config: FabricConfig) => void;
	organizationId?: string;
};

// Common Fabric AI strategies
const STRATEGIES = [
	{ value: "", label: "Auto-detect" },
	{
		value: "chain_of_thought",
		label: "Chain of Thought",
		description: "Step-by-step reasoning",
	},
	{
		value: "tree_of_thought",
		label: "Tree of Thought",
		description: "Explore multiple paths",
	},
	{
		value: "reflexion",
		label: "Reflexion",
		description: "Self-reflection and improvement",
	},
	{
		value: "socratic_method",
		label: "Socratic Method",
		description: "Question-driven analysis",
	},
	{
		value: "first_principles",
		label: "First Principles",
		description: "Break down to fundamentals",
	},
];

// Common Fabric AI contexts (personas/expertise)
const CONTEXTS = [
	{ value: "", label: "Auto-detect" },
	{
		value: "security_expert",
		label: "Security Expert",
		description: "Cybersecurity analysis",
	},
	{
		value: "senior_developer",
		label: "Senior Developer",
		description: "Code review expertise",
	},
	{
		value: "data_analyst",
		label: "Data Analyst",
		description: "Data insights focus",
	},
	{
		value: "project_manager",
		label: "Project Manager",
		description: "Project coordination",
	},
	{
		value: "technical_writer",
		label: "Technical Writer",
		description: "Documentation focus",
	},
	{
		value: "business_analyst",
		label: "Business Analyst",
		description: "Business insights",
	},
];

// Common Fabric AI patterns for reports
const PATTERNS = [
	{ value: "", label: "Auto-detect" },
	{
		value: "summarize",
		label: "Summarize",
		description: "Create concise summaries",
	},
	{
		value: "extract_wisdom",
		label: "Extract Wisdom",
		description: "Key insights and takeaways",
	},
	{
		value: "analyze_claims",
		label: "Analyze Claims",
		description: "Fact-check and verify",
	},
	{
		value: "extract_insights",
		label: "Extract Insights",
		description: "Business intelligence",
	},
	{
		value: "create_summary",
		label: "Create Summary",
		description: "Executive summary",
	},
	{
		value: "rate_content",
		label: "Rate Content",
		description: "Quality assessment",
	},
	{
		value: "extract_action_items",
		label: "Extract Action Items",
		description: "Actionable tasks",
	},
	{
		value: "summarize_meeting",
		label: "Summarize Meeting",
		description: "Meeting notes",
	},
];

export function FabricAiConfigSection({
	value,
	onChange,
	organizationId: _organizationId,
}: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const [showVariables, setShowVariables] = useState(false);
	const [variableKey, setVariableKey] = useState("");
	const [variableValue, setVariableValue] = useState("");

	const handleChange = (field: keyof FabricConfig, newValue: unknown) => {
		onChange({ ...value, [field]: newValue });
	};

	const addVariable = () => {
		if (variableKey && variableValue) {
			const newVars = {
				...(value.variables || {}),
				[variableKey]: variableValue,
			};
			onChange({ ...value, variables: newVars });
			setVariableKey("");
			setVariableValue("");
		}
	};

	const removeVariable = (key: string) => {
		const newVars = { ...value.variables };
		delete newVars[key];
		onChange({
			...value,
			variables: Object.keys(newVars).length > 0 ? newVars : undefined,
		});
	};

	const hasConfig =
		value.strategy ||
		value.context ||
		value.pattern ||
		value.enableAutoDetection === false ||
		value.defaultPrompt;

	return (
		<Card className="border-dashed">
			<Collapsible open={isOpen} onOpenChange={setIsOpen}>
				<CollapsibleTrigger asChild>
					<CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<SparklesIcon className="h-5 w-5 text-purple-500" />
								<CardTitle className="text-base">
									Fabric AI Enhancement
								</CardTitle>
								<Badge
									variant="outline"
									className="text-xs text-muted-foreground"
								>
									Coming Soon
								</Badge>
								{hasConfig && (
									<Badge
										variant="secondary"
										className="text-xs"
									>
										Configured
									</Badge>
								)}
							</div>
							<ChevronDownIcon
								className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
							/>
						</div>
						<CardDescription>
							Enhance report generation with Fabric AI's Strategy
							→ Context → Pattern system
						</CardDescription>
					</CardHeader>
				</CollapsibleTrigger>

				<CollapsibleContent>
					<CardContent className="space-y-6 pt-0">
						{/* Auto-detection toggle */}
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label className="flex items-center gap-2">
									<WandIcon className="h-4 w-4" />
									Auto-detect from Content
								</Label>
								<p className="text-xs text-muted-foreground">
									Automatically detect appropriate strategy,
									context, and pattern
								</p>
							</div>
							<Switch
								checked={value.enableAutoDetection !== false}
								onCheckedChange={(checked) =>
									handleChange("enableAutoDetection", checked)
								}
							/>
						</div>

						<div className="grid gap-4 md:grid-cols-3">
							{/* Strategy */}
							<div className="space-y-2">
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<Label className="flex items-center gap-1">
												<BrainCircuitIcon className="h-4 w-4" />
												Strategy
												<HelpCircleIcon className="h-3 w-3 text-muted-foreground" />
											</Label>
										</TooltipTrigger>
										<TooltipContent className="max-w-xs">
											<p>
												Reasoning methodology - HOW the
												AI should think about the task.
												Examples: Chain of Thought, Tree
												of Thought.
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
								<Select
									value={value.strategy || ""}
									onValueChange={(v) =>
										handleChange("strategy", v || undefined)
									}
								>
									<SelectTrigger>
										<SelectValue placeholder="Auto-detect" />
									</SelectTrigger>
									<SelectContent>
										{STRATEGIES.map((s) => (
											<SelectItem
												key={s.value}
												value={s.value || "auto"}
											>
												<div className="flex flex-col">
													<span>{s.label}</span>
													{s.description && (
														<span className="text-xs text-muted-foreground">
															{s.description}
														</span>
													)}
												</div>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{/* Context */}
							<div className="space-y-2">
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<Label className="flex items-center gap-1">
												Context/Persona
												<HelpCircleIcon className="h-3 w-3 text-muted-foreground" />
											</Label>
										</TooltipTrigger>
										<TooltipContent className="max-w-xs">
											<p>
												Domain expertise or persona -
												WHO the AI should be. Provides
												background knowledge and
												perspective.
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
								<Select
									value={value.context || ""}
									onValueChange={(v) =>
										handleChange("context", v || undefined)
									}
								>
									<SelectTrigger>
										<SelectValue placeholder="Auto-detect" />
									</SelectTrigger>
									<SelectContent>
										{CONTEXTS.map((c) => (
											<SelectItem
												key={c.value}
												value={c.value || "auto"}
											>
												<div className="flex flex-col">
													<span>{c.label}</span>
													{c.description && (
														<span className="text-xs text-muted-foreground">
															{c.description}
														</span>
													)}
												</div>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{/* Pattern */}
							<div className="space-y-2">
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<Label className="flex items-center gap-1">
												Pattern
												<HelpCircleIcon className="h-3 w-3 text-muted-foreground" />
											</Label>
										</TooltipTrigger>
										<TooltipContent className="max-w-xs">
											<p>
												Task execution template - WHAT
												the AI should produce. Defines
												output structure and focus.
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
								<Select
									value={value.pattern || ""}
									onValueChange={(v) =>
										handleChange("pattern", v || undefined)
									}
								>
									<SelectTrigger>
										<SelectValue placeholder="Auto-detect" />
									</SelectTrigger>
									<SelectContent>
										{PATTERNS.map((p) => (
											<SelectItem
												key={p.value}
												value={p.value || "auto"}
											>
												<div className="flex flex-col">
													<span>{p.label}</span>
													{p.description && (
														<span className="text-xs text-muted-foreground">
															{p.description}
														</span>
													)}
												</div>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						{/* Default Prompt (User Message) */}
						<div className="space-y-2">
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Label className="flex items-center gap-1">
											<MessageSquareTextIcon className="h-4 w-4" />
											Default Prompt
											<HelpCircleIcon className="h-3 w-3 text-muted-foreground" />
										</Label>
									</TooltipTrigger>
									<TooltipContent className="max-w-xs">
										<p>
											The task prompt sent to the AI.
											Defines what the AI should do with
											the data. Can be overridden per
											instance.
										</p>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<Textarea
								placeholder="Enter the task prompt for report generation. E.g., 'Analyze the sprint data and generate a comprehensive report covering: progress, blockers, and recommendations...'"
								value={value.defaultPrompt || ""}
								onChange={(e) =>
									handleChange(
										"defaultPrompt",
										e.target.value || undefined,
									)
								}
								rows={4}
								className="font-mono text-sm"
							/>
							<p className="text-xs text-muted-foreground">
								This is sent as the user message to the AI.
								Fabric AI strategy/context/pattern provide the
								system instructions. Can be overridden per
								instance.
							</p>
						</div>

						{/* Template Variables */}
						<Collapsible
							open={showVariables}
							onOpenChange={setShowVariables}
						>
							<CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
								<ChevronDownIcon
									className={`h-4 w-4 transition-transform ${showVariables ? "rotate-180" : ""}`}
								/>
								Template Variables
								{value.variables &&
									Object.keys(value.variables).length > 0 && (
										<Badge
											variant="outline"
											className="text-xs"
										>
											{
												Object.keys(value.variables)
													.length
											}
										</Badge>
									)}
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-3 space-y-3">
								<p className="text-xs text-muted-foreground">
									Variables can be used in patterns with{" "}
									{"{{variableName}}"} syntax
								</p>

								{/* Existing variables */}
								{value.variables &&
									Object.keys(value.variables).length > 0 && (
										<div className="space-y-2">
											{Object.entries(
												value.variables,
											).map(([key, val]) => (
												<div
													key={key}
													className="flex items-center gap-2 text-sm bg-muted/50 rounded px-2 py-1"
												>
													<code className="font-mono text-xs">
														{key}
													</code>
													<span className="text-muted-foreground">
														=
													</span>
													<span className="flex-1 truncate">
														{val}
													</span>
													<button
														type="button"
														onClick={() =>
															removeVariable(key)
														}
														className="text-muted-foreground hover:text-destructive"
													>
														×
													</button>
												</div>
											))}
										</div>
									)}

								{/* Add new variable */}
								<div className="flex gap-2">
									<Input
										placeholder="Variable name"
										value={variableKey}
										onChange={(e) =>
											setVariableKey(e.target.value)
										}
										className="w-32"
									/>
									<Input
										placeholder="Value"
										value={variableValue}
										onChange={(e) =>
											setVariableValue(e.target.value)
										}
										className="flex-1"
									/>
									<button
										type="button"
										onClick={addVariable}
										disabled={
											!variableKey || !variableValue
										}
										className="px-3 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
									>
										Add
									</button>
								</div>
							</CollapsibleContent>
						</Collapsible>

						{/* Info box */}
						<div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground">
							<p className="font-medium mb-1">
								How Fabric AI Enhancement Works:
							</p>
							<ul className="list-disc list-inside space-y-0.5">
								<li>
									<strong>Strategy</strong> defines the
									reasoning approach (e.g., Chain of Thought
									for step-by-step analysis)
								</li>
								<li>
									<strong>Context</strong> provides domain
									expertise and perspective
								</li>
								<li>
									<strong>Pattern</strong> shapes the output
									structure and content focus
								</li>
								<li>
									Use{" "}
									<code>{"{{plugin:datetime:today}}"}</code>{" "}
									for dynamic dates
								</li>
								<li>
									Use <code>{"{{pattern:summarize}}"}</code>{" "}
									to apply patterns inline
								</li>
							</ul>
						</div>
					</CardContent>
				</CollapsibleContent>
			</Collapsible>
		</Card>
	);
}
