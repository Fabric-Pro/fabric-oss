"use client";

/**
 * ChatWelcome - Welcome screen for chat interfaces
 *
 * Displays:
 * - Agent branding with modern design
 * - Quick suggestion chips with emojis
 * - Example categories for inspiration
 *
 * Used by both Direct and Orchestrator chat modes.
 */

import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	ArrowRight,
	Code2,
	FileText,
	Lightbulb,
	ListTodo,
	MessageSquareText,
	NotebookPen,
	Sparkles,
	SquareTerminal,
} from "lucide-react";
import type { ExampleCategory, QuickSuggestion } from "./types";

export interface ChatWelcomeProps {
	/** Main title text */
	title?: string;
	/** Subtitle/description */
	subtitle?: string;
	/** Quick suggestion chips */
	suggestions?: QuickSuggestion[];
	/** Example categories with longer prompts */
	categories?: ExampleCategory[];
	/** Callback when user clicks a suggestion */
	onSuggestionClick: (message: string) => void;
	/** Custom logo component */
	logo?: React.ReactNode;
	/** Additional tips to show at bottom */
	tips?: Array<{ icon?: React.ReactNode; text: React.ReactNode }>;
	className?: string;
}

/** Default quick suggestions */
const DEFAULT_SUGGESTIONS: QuickSuggestion[] = [
	{
		label: "Plan",
		icon: <NotebookPen className="h-4 w-4" />,
		value: "Help me plan a new feature",
	},
	{
		label: "Code",
		icon: <SquareTerminal className="h-4 w-4" />,
		value: "Write code to implement this",
	},
	{
		label: "Document",
		icon: <FileText className="h-4 w-4" />,
		value: "Generate documentation",
	},
	{
		label: "Debug",
		icon: <MessageSquareText className="h-4 w-4" />,
		value: "Help me debug this issue",
	},
	{
		label: "Optimize",
		icon: <Sparkles className="h-4 w-4" />,
		value: "Optimize this code for performance",
	},
];

/** Default example categories */
const DEFAULT_CATEGORIES: ExampleCategory[] = [
	{
		icon: Lightbulb,
		title: "Plan & Design",
		examples: [
			"Help me plan a new authentication system",
			"Design the database schema for a blog platform",
		],
		color: "text-highlight dark:text-yellow-400",
		bgColor: "bg-yellow-500/10",
	},
	{
		icon: Code2,
		title: "Write Code",
		examples: [
			"Create a React hook for form validation",
			"Write a REST API endpoint for user registration",
		],
		color: "text-muted-foreground",
		bgColor: "bg-muted",
	},
	{
		icon: FileText,
		title: "Generate Docs",
		examples: [
			"Write API documentation for my endpoints",
			"Create a technical specification document",
		],
		color: "text-success dark:text-green-400",
		bgColor: "bg-green-500/10",
	},
	{
		icon: ListTodo,
		title: "Break Down Tasks",
		examples: [
			"Break this feature into implementation tasks",
			"Create a sprint plan for the MVP release",
		],
		color: "text-secondary",
		bgColor: "bg-secondary/10",
	},
];

export function ChatWelcome({
	title = "What can I help you build?",
	subtitle,
	suggestions = DEFAULT_SUGGESTIONS,
	categories = DEFAULT_CATEGORIES,
	onSuggestionClick,
	logo,
	tips,
	className,
}: ChatWelcomeProps) {
	return (
		<div
			className={cn(
				"flex-1 min-h-0 flex flex-col items-center justify-start sm:justify-center p-3 sm:p-8 overflow-y-auto overflow-x-hidden",
				className,
			)}
		>
			<div
				className={cn(
					"w-full space-y-4 min-w-0 sm:space-y-8",
					categories.length === 0 ? "max-w-5xl" : "max-w-3xl",
				)}
			>
				{/* Hero Section */}
				<div className="text-center space-y-3 sm:space-y-5">
					<div className="hidden sm:inline-flex items-center justify-center h-16 w-16 sm:h-20 sm:w-20 rounded-xl border border-primary/15 bg-gradient-to-br from-primary/16 to-primary/5 mx-auto shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
						{logo || (
							<FabricLogo
								className="h-9 w-9 sm:h-12 sm:w-12"
								size={48}
							/>
						)}
					</div>
					<div className="space-y-3">
						<h1
							className="text-2xl sm:text-[2.6rem] tracking-tight text-foreground/90"
							style={{
								fontFamily:
									"var(--font-sans, 'EB Garamond', Georgia, serif)",
								fontWeight: 400,
							}}
						>
							{title}
						</h1>
						{subtitle && (
							<p className="mx-auto max-w-2xl text-muted-foreground text-base sm:text-lg leading-8">
								{subtitle}
							</p>
						)}
					</div>
				</div>

				{/* Quick Suggestions */}
				{suggestions.length > 0 &&
					(categories.length === 0 ? (
						<div className="flex flex-wrap justify-center gap-2 sm:gap-3">
							{suggestions.map((chip, index) => (
								<button
									key={`suggestion-${index}`}
									type="button"
									onClick={() =>
										onSuggestionClick(chip.value)
									}
									className="group w-full min-h-28 rounded-md border border-border/60 bg-card/35 p-3 text-left transition-all hover:border-primary/35 hover:bg-card/55 hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)] dark:hover:shadow-[0_8px_24px_rgba(0,0,0,0.28)] sm:min-h-32 sm:w-[200px] sm:p-4"
								>
									<div className="flex items-start gap-2.5 min-w-0 sm:gap-3">
										<div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary/8 text-primary/80 dark:border-primary/20 dark:bg-primary/10 dark:text-primary/75">
											<span className="flex items-center justify-center">
												{chip.icon}
											</span>
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-base font-medium text-foreground">
												{chip.label}
											</p>
											<p className="mt-1 line-clamp-3 text-sm leading-6 text-muted-foreground">
												{chip.value}
											</p>
										</div>
									</div>
								</button>
							))}
						</div>
					) : (
						<div className="space-y-4">
							<div className="flex flex-wrap items-center justify-center gap-2">
								{suggestions.slice(0, 3).map((chip, index) => (
									<Button
										key={`suggestion-top-${index}`}
										variant="outline"
										className="rounded-md border-border/60 bg-card/35 px-4 py-2.5 h-auto text-sm font-medium hover:bg-accent hover:border-primary/40 transition-all"
										onClick={() =>
											onSuggestionClick(chip.value)
										}
									>
										<span className="mr-2 flex items-center justify-center text-primary/75">
											{chip.icon}
										</span>
										{chip.label}
									</Button>
								))}
							</div>
							{suggestions.length > 3 && (
								<div className="flex flex-wrap items-center justify-center gap-2">
									{suggestions.slice(3).map((chip, index) => (
										<Button
											key={`suggestion-bottom-${index}`}
											variant="outline"
											className="rounded-md border-border/60 bg-card/35 px-4 py-2.5 h-auto text-sm font-medium hover:bg-accent hover:border-primary/40 transition-all"
											onClick={() =>
												onSuggestionClick(chip.value)
											}
										>
											<span className="mr-2 flex items-center justify-center text-primary/75">
												{chip.icon}
											</span>
											{chip.label}
										</Button>
									))}
								</div>
							)}
						</div>
					))}

				{/* Example Categories */}
				{categories.length > 0 && (
					<div className="space-y-4">
						<h2 className="text-sm font-medium text-muted-foreground text-center">
							Or explore these examples
						</h2>
						<div className="grid sm:grid-cols-2 gap-3 sm:gap-4">
							{categories.map((category) => (
								<div
									key={category.title}
									className="rounded-md border bg-card/50 p-3 sm:p-4 space-y-3 hover:bg-card hover:shadow-sm transition-all overflow-hidden"
								>
									<div className="flex items-center gap-2">
										<div
											className={cn(
												"h-9 w-9 rounded-md flex items-center justify-center",
												category.bgColor,
											)}
										>
											<category.icon
												className={cn(
													"h-5 w-5",
													category.color,
												)}
											/>
										</div>
										<span className="font-medium">
											{category.title}
										</span>
									</div>
									<div className="space-y-1">
										{category.examples.map(
											(example, idx) => (
												<button
													key={`${category.title}-example-${idx}`}
													type="button"
													onClick={() =>
														onSuggestionClick(
															example,
														)
													}
													className={cn(
														"w-full text-left text-sm text-muted-foreground p-2.5 rounded-md group",
														"hover:bg-muted hover:text-foreground transition-all",
													)}
												>
													<span className="flex items-center gap-2">
														{example}
														<ArrowRight className="h-3 w-3 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all shrink-0" />
													</span>
												</button>
											),
										)}
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Tips */}
				{tips && tips.length > 0 && (
					<div className="text-center space-y-2 py-4">
						{tips.map((tip, idx) => (
							<p
								key={`tip-${idx}`}
								className="mx-auto flex max-w-2xl items-center justify-center gap-1.5 text-sm text-muted-foreground"
							>
								{tip.icon}
								<span>{tip.text}</span>
							</p>
						))}
					</div>
				)}

				{/* Default tips if none provided */}
				{(!tips || tips.length === 0) && (
					<div className="text-center space-y-2 py-4">
						<p className="text-sm text-muted-foreground flex items-center justify-center gap-1.5">
							<Sparkles className="h-4 w-4 text-primary/60" />
							<span>
								Use{" "}
								<kbd className="px-1.5 py-0.5 bg-muted border rounded text-xs font-mono">
									@
								</kbd>{" "}
								to reference files from your workspace
							</span>
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
