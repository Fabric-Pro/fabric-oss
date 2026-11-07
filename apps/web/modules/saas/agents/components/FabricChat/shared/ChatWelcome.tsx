"use client";

/**
 * ChatWelcome - the empty state of a chat surface.
 *
 * On the Advisor it is the Cosmos-style landing: a centred heading, the
 * composer directly under it with a few mono glyphs drifting around it,
 * the most recent conversation tucked under the composer with a Resume
 * link, and a flat list of starters, each an icon in its own colour, a
 * label and a one-line description. Starters put their prompt in the
 * composer; they do not send.
 *
 * Other surfaces (the orchestrator, agent instances) use the same layout
 * without a composer slot, and may still pass example categories.
 *
 * Used by both Direct and Orchestrator chat modes.
 */

import { SparklesIcon } from "@saas/shared/components/icons/SparklesIcon";
import { cn } from "@ui/lib";
import {
	ArrowRight,
	Code2,
	FileText,
	History,
	Lightbulb,
	ListTodo,
	MessageSquareText,
	NotebookPen,
	Sparkles,
	SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ExampleCategory, QuickSuggestion } from "./types";

interface ChatWelcomeResume {
	/** Conversation title; falls back to "Untitled conversation". */
	title: string | null;
	/** Human-readable recency, e.g. "Last active 6 hours ago". */
	lastActiveLabel: string;
	onResume: () => void;
}

export interface ChatWelcomeProps {
	/** Main title text */
	title?: string;
	/** Subtitle/description */
	subtitle?: string;
	/** Starters listed under the composer */
	suggestions?: QuickSuggestion[];
	/** Example categories with longer prompts */
	categories?: ExampleCategory[];
	/** Callback when user clicks a suggestion */
	onSuggestionClick: (message: string) => void;
	/** The composer, rendered under the heading (Advisor landing). */
	composer?: ReactNode;
	/** The most recent conversation, tucked under the composer. */
	resume?: ChatWelcomeResume | null;
	/** Additional tips to show at bottom */
	tips?: Array<{ icon?: ReactNode; text: ReactNode }>;
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
		color: "text-primary",
		bgColor: "bg-primary/10",
	},
];

function ResumeLink({ resume }: { resume: ChatWelcomeResume }) {
	return (
		<button
			type="button"
			onClick={resume.onResume}
			className="group flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/50 px-5 py-3 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
		>
			<History className="size-4 shrink-0" />
			<span className="min-w-0 truncate text-foreground">
				{resume.title || "Untitled conversation"}
			</span>
			<span className="hidden shrink-0 text-xs font-normal sm:inline">
				{resume.lastActiveLabel}
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-1 text-xs">
				Resume
				<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
			</span>
		</button>
	);
}

export function ChatWelcome({
	title = "What can I help you build?",
	subtitle,
	suggestions = DEFAULT_SUGGESTIONS,
	categories = DEFAULT_CATEGORIES,
	onSuggestionClick,
	composer,
	resume,
	tips,
	className,
}: ChatWelcomeProps) {
	const flat = categories.length === 0;
	const resolvedSubtitle =
		subtitle === undefined
			? "Research and analyze your workspace with AI agents"
			: subtitle;

	return (
		<div
			className={cn(
				"flex-1 min-h-0 flex flex-col items-center justify-start overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6 sm:py-6",
				className,
			)}
		>
			<div
				className={cn(
					"w-full min-w-0 flex flex-col items-center sm:my-auto",
					flat ? "max-w-2xl" : "max-w-2xl space-y-6",
				)}
			>
				{/* Centered Genie emblem + heading + subtitle */}
				<div className="w-full px-0 text-center">
					<div className="mb-3 flex items-center justify-center">
						<SparklesIcon className="size-9" aria-hidden="true" />
					</div>
					<h1
						className={cn(
							"text-foreground",
							flat
								? "advisor-title"
								: "text-2xl font-semibold leading-8 tracking-[-0.015em]",
						)}
					>
						{title}
					</h1>
					{resolvedSubtitle && (
						<p className="mx-auto mt-1.5 max-w-xl text-sm leading-5 text-muted-foreground">
							{resolvedSubtitle}
						</p>
					)}
				</div>

				{/* Composer directly under the heading, with accuracy caption and recent conversation */}
				{composer && (
					<div className="relative mt-6 w-full">
						<div>{composer}</div>
						<p className="mt-2 px-1 text-center text-xs text-muted-foreground">
							Always review the accuracy of responses.
						</p>
						{resume && (
							<div className="mt-3">
								<ResumeLink resume={resume} />
							</div>
						)}
					</div>
				)}

				{/* Without a composer, the last conversation stands on its own. */}
				{!composer && resume && (
					<div className="mt-6 w-full">
						<ResumeLink resume={resume} />
					</div>
				)}

				{/* Starters — Databricks Genie Agents full-width divider rows */}
				{suggestions.length > 0 && (
					<ul className="mt-6 w-full divide-y divide-border border-b border-border">
						{suggestions.map((suggestion) => (
							<li key={suggestion.value}>
								<button
									type="button"
									onClick={() =>
										onSuggestionClick(suggestion.value)
									}
									className="flex w-full items-start gap-2.5 px-2 py-2.5 text-left text-sm leading-5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
								>
									{suggestion.icon && (
										<span
											className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
											style={
												suggestion.color
													? {
															color: suggestion.color,
														}
													: undefined
											}
										>
											{suggestion.icon}
										</span>
									)}
									<span className="min-w-0 break-words">
										<span className="font-medium text-foreground">
											{suggestion.label}
										</span>
										{suggestion.description ? (
											<>
												{" "}
												&mdash;{" "}
												<span className="text-muted-foreground">
													{suggestion.description}
												</span>
											</>
										) : suggestion.value !==
											suggestion.label ? (
											<>
												{" "}
												&mdash;{" "}
												<span className="text-muted-foreground">
													{suggestion.value}
												</span>
											</>
										) : null}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}

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
					<div className="mt-6 space-y-2 py-2 text-center">
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
			</div>
		</div>
	);
}
