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

import { Button } from "@ui/components/button";
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
		color: "text-secondary",
		bgColor: "bg-secondary/10",
	},
];

/**
 * The marks that drift around the composer. Positions are percentages of
 * the glyph field, which extends past the composer on both sides so the
 * marks sit in the margins, not over the input. Three carry a colour; the
 * rest are ink at low opacity (see .advisor-glyph in globals.css).
 */
const GLYPHS: Array<{
	char: string;
	left: string;
	top: string;
	delay: number;
	duration: number;
	dx: number;
	color?: string;
}> = [
	{ char: ".", left: "5%", top: "-8%", delay: 0, duration: 9, dx: 3 },
	{ char: "/", left: "9%", top: "22%", delay: 1.4, duration: 11, dx: -2 },
	{ char: "@", left: "8%", top: "68%", delay: 2.8, duration: 10, dx: 2 },
	{ char: "=", left: "12%", top: "96%", delay: 0.9, duration: 12, dx: -3 },
	{
		char: "+",
		left: "1%",
		top: "118%",
		delay: 3.6,
		duration: 9.5,
		dx: 2,
		color: "#cf8b17",
	},
	{ char: ":", left: "3%", top: "44%", delay: 5.2, duration: 10.5, dx: -2 },
	{ char: "%", left: "97%", top: "-14%", delay: 2.1, duration: 11, dx: -3 },
	{
		char: "o",
		left: "88%",
		top: "36%",
		delay: 0.4,
		duration: 9,
		dx: 2,
		color: "#208858",
	},
	{ char: "+", left: "85%", top: "62%", delay: 4.4, duration: 12, dx: -2 },
	{ char: ".", left: "86%", top: "78%", delay: 1.9, duration: 8.5, dx: 3 },
	{
		char: "×",
		left: "91%",
		top: "96%",
		delay: 3.1,
		duration: 10,
		dx: -2,
		color: "#dc2828",
	},
	{ char: "*", left: "95%", top: "56%", delay: 6.1, duration: 11.5, dx: 2 },
	{ char: "-", left: "13%", top: "8%", delay: 4.9, duration: 10, dx: 3 },
];

function GlyphField() {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute -inset-x-40 -top-16 -bottom-16 hidden lg:block"
		>
			{GLYPHS.map((g) => (
				<span
					key={`${g.char}-${g.left}-${g.top}`}
					className="advisor-glyph"
					style={
						{
							left: g.left,
							top: g.top,
							color: g.color,
							"--glyph-delay": `${g.delay}s`,
							"--glyph-duration": `${g.duration}s`,
							"--glyph-dx": `${g.dx}px`,
						} as React.CSSProperties
					}
				>
					{g.char}
				</span>
			))}
		</div>
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

	return (
		<div
			className={cn(
				"flex-1 min-h-0 flex flex-col items-center justify-start sm:justify-center overflow-y-auto overflow-x-hidden px-4 py-8 sm:px-6 sm:py-12",
				className,
			)}
		>
			<div
				className={cn(
					"w-full min-w-0 flex flex-col items-center",
					flat ? "max-w-4xl" : "max-w-3xl space-y-8",
				)}
			>
				{/* The heading, alone: no logo tile, no subtitle unless one is given. */}
				<div className="w-full px-0 text-center sm:px-6">
					<h1
						className={cn(
							"text-foreground",
							flat
								? "advisor-title"
								: "text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-[1.1] tracking-[-0.025em]",
						)}
					>
						{title}
					</h1>
					{subtitle && (
						<p className="mx-auto mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
							{subtitle}
						</p>
					)}
				</div>

				{/* Composer, with the glyph field behind it and the last
				    conversation tucked under it. */}
				{composer && (
					<div className="relative mt-10 w-full sm:mt-14 sm:px-6">
						<GlyphField />
						<div className="relative z-10">{composer}</div>
						{resume && (
							<div className="relative z-0 -mt-4 px-3">
								<button
									type="button"
									onClick={resume.onResume}
									className="group flex w-full items-center gap-2 rounded-[6px_6px_16px_16px] bg-muted/50 px-5 pt-7 pb-3 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
								>
									<History className="size-4 shrink-0" />
									<span className="min-w-0 truncate text-foreground">
										{resume.title ||
											"Untitled conversation"}
									</span>
									<span className="hidden shrink-0 text-xs font-normal sm:inline">
										{resume.lastActiveLabel}
									</span>
									<span className="ml-auto flex shrink-0 items-center gap-1 text-xs">
										Resume
										<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
									</span>
								</button>
							</div>
						)}
					</div>
				)}

				{/* Starters */}
				{suggestions.length > 0 &&
					(flat ? (
						<ul
							className={cn(
								"grid w-full gap-x-6 gap-y-0.5 sm:grid-cols-2 sm:px-6",
								composer ? "mt-10 sm:mt-12" : "mt-8",
							)}
						>
							{suggestions.map((suggestion) => (
								<li key={suggestion.value}>
									<button
										type="button"
										onClick={() =>
											onSuggestionClick(suggestion.value)
										}
										className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-2 text-left text-[13px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent"
									>
										<span
											className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4"
											style={{
												color:
													suggestion.color ??
													"var(--fab-accent)",
											}}
										>
											{suggestion.icon}
										</span>
										<span className="min-w-0 truncate">
											<span className="text-foreground">
												{suggestion.label}
											</span>
											{suggestion.description ? (
												<>
													{" "}
													&mdash;{" "}
													{suggestion.description}
												</>
											) : (
												<> &mdash; {suggestion.value}</>
											)}
										</span>
									</button>
								</li>
							))}
						</ul>
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
					<div className="mt-8 space-y-2 py-4 text-center">
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
