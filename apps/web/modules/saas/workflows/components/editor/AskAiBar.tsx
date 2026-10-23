"use client";

import { cn } from "@ui/lib";
import { SparklesIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { TextToWorkflow } from "../TextToWorkflow";

type TextToWorkflowProps = ComponentProps<typeof TextToWorkflow>;

interface AskAiBarProps
	extends Pick<
		TextToWorkflowProps,
		| "organizationId"
		| "currentNodes"
		| "currentEdges"
		| "onWorkflowGenerated"
	> {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	hasSteps: boolean;
}

const BAR_CLASS =
	"pointer-events-auto flex h-11 w-full max-w-[520px] items-center gap-2.5 rounded-xl border border-input bg-card pl-3.5 pr-2";

function ShortcutHint() {
	return (
		<kbd className="pointer-events-none shrink-0 rounded border border-input px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
			⌘K
		</kbd>
	);
}

/**
 * The canvas's "Ask AI" bar, centred at the bottom. Closed, it is a button
 * that opens the prompt (as ⌘K does); open, it holds the inline
 * TextToWorkflow prompt.
 */
export function AskAiBar({
	open,
	onOpenChange,
	hasSteps,
	...prompt
}: AskAiBarProps) {
	return (
		// The left padding keeps the bar clear of the zoom pill, which sits at the
		// bottom left of the same canvas.
		<div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center pl-[232px] pr-4">
			{open ? (
				<div className={BAR_CLASS}>
					<SparklesIcon
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<TextToWorkflow inline {...prompt} />
					<button
						type="button"
						aria-label="Close Ask AI"
						onClick={() => onOpenChange(false)}
						className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					>
						<XIcon className="size-3.5" aria-hidden="true" />
					</button>
				</div>
			) : (
				<button
					type="button"
					onClick={() => onOpenChange(true)}
					aria-keyshortcuts="Meta+K Control+K"
					className={cn(
						BAR_CLASS,
						"cursor-text text-left hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors",
					)}
				>
					<SparklesIcon
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<span className="flex-1 truncate text-sm text-muted-foreground">
						{hasSteps
							? "Ask AI to change this workflow…"
							: "Ask AI to build a workflow…"}
					</span>
					<ShortcutHint />
				</button>
			)}
		</div>
	);
}
