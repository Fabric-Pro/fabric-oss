"use client";

/**
 * AgentTile: the one visual for an agent in a grid, shared by system agents
 * (the registry) and the agents people build (template instances).
 *
 * Every attribute has a place and a register:
 * - identity: the hero emoji when there is one, otherwise the agents mark
 * - name, with framework and category in mono beneath it
 * - status as a dot and a word at the top right; a failed health probe says
 *   "Unreachable", not "Error", and carries the probe's reason as a tooltip
 * - description, two lines, never truncated to a single word
 * - capabilities as quiet mono tokens
 * - footer in mono: runs, recency, and the scope when it matters
 *
 * Neutral surfaces from the theme tokens in both modes; the only colour is
 * the status dot. Hover darkens the hairline and reveals the arrow.
 */

import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ArrowRightIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

type AgentStatusTone = "good" | "bad" | "warn" | "busy" | "muted";

export interface AgentTileStatus {
	label: string;
	tone: AgentStatusTone;
	/** Shown in a tooltip and to screen readers, e.g. the health probe error. */
	detail?: string | null;
}

export interface AgentTileProps {
	name: string;
	description?: string | null;
	/** Hero emoji; falls back to the agents mark. */
	emoji?: string | null;
	status: AgentTileStatus;
	/** Mono tokens under the name: framework, category, template. */
	meta?: Array<string | null | undefined>;
	/** Mono tokens in the footer: runs, recency. */
	footer?: Array<string | null | undefined>;
	/** Scope word for the footer's right side, when the list mixes scopes. */
	scope?: string | null;
	/** Capability or skill names, shown as quiet tokens (max three, then +n). */
	chips?: string[];
	/** Opens the agent. The whole tile is the target. */
	onOpen?: () => void;
	/** Top-right controls (a menu). Rendered beside the status. */
	menu?: ReactNode;
	/** A row of buttons under the footer. */
	actions?: ReactNode;
	ariaLabel?: string;
	className?: string;
}

const DOT: Record<AgentStatusTone, string> = {
	good: "bg-success",
	bad: "bg-destructive",
	warn: "bg-[var(--fab-warn)]",
	busy: "bg-[var(--fab-warn)] motion-safe:animate-pulse",
	muted: "bg-muted-foreground/50",
};

const LABEL: Record<AgentStatusTone, string> = {
	good: "text-muted-foreground",
	bad: "text-destructive",
	warn: "text-muted-foreground",
	busy: "text-muted-foreground",
	muted: "text-muted-foreground",
};

const FRAMEWORK_LABELS: Record<string, string> = {
	AI_SDK: "Vercel AI SDK",
	VERCEL_AI_SDK: "Vercel AI SDK",
	VERCEL: "Vercel AI SDK",
	LANGGRAPH: "LangGraph",
	LANGCHAIN: "LangChain",
	CREWAI: "CrewAI",
	AUTOGEN: "AutoGen",
	COPILOTKIT: "CopilotKit",
	FABRIC_NATIVE: "Fabric",
	A2A: "A2A",
	MCP: "MCP",
	CUSTOM: "Custom",
};

/** "VERCEL_AI_SDK" → "Vercel AI SDK", unknown keys → Title Case. */
export function frameworkLabel(framework?: string | null): string | null {
	if (!framework) {
		return null;
	}
	const key = framework.toUpperCase().replace(/[\s-]+/g, "_");
	if (FRAMEWORK_LABELS[key]) {
		return FRAMEWORK_LABELS[key];
	}
	return framework
		.toLowerCase()
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

/**
 * Scope as the reader understands it: a built-in agent, one the team made,
 * or one of their own. "SYSTEM", "ORGANIZATION" and "USER" are storage words.
 */
export function kindLabel(scope?: string | null): string | null {
	switch ((scope ?? "").toUpperCase()) {
		case "SYSTEM":
			return "Built-in";
		case "ORGANIZATION":
			return "Team";
		case "USER":
		case "PERSONAL":
			return "Yours";
		default:
			return null;
	}
}

/** "SYSTEM" → "System", "ORGANIZATION" → "Organization". */
export function scopeLabel(scope?: string | null): string | null {
	if (!scope) {
		return null;
	}
	const s = scope.toLowerCase();
	if (s === "user") {
		return "Personal";
	}
	return s[0].toUpperCase() + s.slice(1);
}

function Mark({ emoji }: { emoji?: string | null }) {
	return (
		<div
			aria-hidden="true"
			className="flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-border bg-muted text-foreground/80"
		>
			{emoji ? (
				<span className="text-[18px] leading-none">{emoji}</span>
			) : (
				<RobotIcon className="size-4" />
			)}
		</div>
	);
}

export function AgentTile({
	name,
	description,
	emoji,
	status,
	meta = [],
	footer = [],
	scope,
	chips = [],
	onOpen,
	menu,
	actions,
	ariaLabel,
	className,
}: AgentTileProps) {
	const metaTokens = meta.filter((m): m is string => Boolean(m));
	const footerTokens = footer.filter((f): f is string => Boolean(f));
	const visibleChips = chips.slice(0, 3);
	const hiddenChips = chips.length - visibleChips.length;

	// The tile is one big target, but its menu and action buttons are
	// targets of their own: a click that started on a button or a link
	// inside the tile is theirs, not the tile's.
	const isNestedControl = (target: EventTarget | null) =>
		target instanceof Element &&
		target.closest("button, a, [role='menuitem']") !== null;

	const onClick = (e: MouseEvent<HTMLDivElement>) => {
		if (!onOpen || isNestedControl(e.target)) {
			return;
		}
		onOpen();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (!onOpen || e.target !== e.currentTarget) {
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onOpen();
		}
	};

	const statusNode = (
		<span
			className={cn(
				"flex items-center gap-1.5 font-mono text-[11px]",
				LABEL[status.tone],
			)}
		>
			<span className={cn("size-1.5 rounded-full", DOT[status.tone])} />
			{status.label}
			{status.detail ? (
				<span className="sr-only">{status.detail}</span>
			) : null}
		</span>
	);

	return (
		<div
			{...(onOpen
				? {
						role: "button",
						tabIndex: 0,
						"aria-label": ariaLabel ?? `Open ${name}`,
						onClick,
						onKeyDown,
					}
				: {})}
			className={cn(
				"group relative flex flex-col rounded-[8px] border border-border bg-card text-left transition-colors",
				onOpen && "cursor-pointer hover:border-foreground/25",
				className,
			)}
		>
			<div className="flex items-start gap-3 p-4 pb-3">
				<Mark emoji={emoji} />
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-[14px] font-medium leading-5 text-foreground">
						{name}
					</h3>
					{metaTokens.length > 0 ? (
						<p className="mt-0.5 truncate font-mono text-[11px] leading-4 text-muted-foreground">
							{metaTokens.join(" · ")}
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-1 pt-0.5">
					{status.detail ? (
						<Tooltip>
							<TooltipTrigger asChild>
								{statusNode}
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								{status.detail}
							</TooltipContent>
						</Tooltip>
					) : (
						statusNode
					)}
					{menu}
				</div>
			</div>

			<p className="line-clamp-2 min-h-[40px] px-4 text-[13px] leading-5 text-muted-foreground">
				{description || "No description yet."}
			</p>

			{visibleChips.length > 0 ? (
				<div className="flex flex-wrap gap-1 px-4 pt-3">
					{visibleChips.map((chip) => (
						<span
							key={chip}
							className="rounded-[4px] border border-border px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground"
						>
							{chip}
						</span>
					))}
					{hiddenChips > 0 ? (
						<span className="px-1 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
							+{hiddenChips}
						</span>
					) : null}
				</div>
			) : null}

			<div className="mt-auto flex items-center justify-between gap-3 px-4 pt-3 pb-3.5">
				<p className="truncate font-mono text-[11px] leading-4 text-muted-foreground">
					{footerTokens.join(" · ")}
				</p>
				<div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
					{scope ? <span>{scope}</span> : null}
					{onOpen ? (
						<ArrowRightIcon className="size-3.5 text-foreground opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100" />
					) : null}
				</div>
			</div>

			{actions ? (
				<div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
					{actions}
				</div>
			) : null}
		</div>
	);
}
