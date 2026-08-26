"use client";

import { Markdown } from "@copilotkit/react-ui";
import {
	AlertCircle,
	Check,
	ChevronDown,
	ChevronRight,
	Clock,
	Loader2,
} from "lucide-react";
import { useState } from "react";

export interface ToolCallEntry {
	id: string;
	name: string;
	status: "pending" | "success" | "error";
	startedAt?: number;
	durationMs?: number;
	errorMessage?: string;
}

interface ReasoningCollapsibleProps {
	text: string;
	durationMs?: number;
	toolCalls?: ToolCallEntry[];
	/**
	 * True while this turn is still being generated (the agent is actively
	 * thinking / calling tools, before the reply streams in). Renders a live
	 * spinner next to the header label so the "Thinking · Xs" trace reads as
	 * active motion instead of a static, jumpy duration. Leave false/undefined
	 * for completed turns — historical traces show no spinner.
	 */
	inProgress?: boolean;
}

/**
 * Inline collapsible reasoning + tool-call trace, rendered above the
 * assistant's markdown reply in the AI Assistant (Documents + Features).
 * Mirrors the Claude.ai / ChatGPT-o1 "Thinking" affordance and extends it
 * with a per-turn list of tool invocations (write_document_local,
 * apply_document_patches, search_*, etc.).
 *
 * Source of data:
 *   agents/langchain/project-document-generator/state/index.ts
 *     → state.reasoningByTurn[turnIndex]  → `text`/`durationMs`
 *     → state.toolCallsByTurn[turnIndex]  → `toolCalls`
 *   → AG-UI STATE_SNAPSHOT
 *   → useCoAgent({ name: "project_document_generator" }).state
 *   → CopilotAssistantMessage looks up by turnIndex (count of human
 *     messages preceding this assistant message in visibleMessages)
 *   → this component renders the result.
 *
 * Renders nothing when both `text` is empty AND `toolCalls` is empty/undefined.
 * When only one of the two is present, only that section appears in the body
 * and the header label adapts accordingly.
 */
export function ReasoningCollapsible({
	text,
	durationMs,
	toolCalls,
	inProgress,
}: ReasoningCollapsibleProps) {
	const [expanded, setExpanded] = useState(false);

	const hasText = !!text?.trim();
	const hasToolCalls = !!toolCalls && toolCalls.length > 0;
	if (!hasText && !hasToolCalls) {
		return null;
	}

	const hasDuration =
		typeof durationMs === "number" && Number.isFinite(durationMs);
	const durationLabel = hasDuration
		? ` · ${(durationMs / 1000).toFixed(1)}s`
		: "";

	let label: string;
	if (hasText && hasToolCalls) {
		label = `Thinking & Tools${durationLabel}`;
	} else if (hasText) {
		label = `Thinking${durationLabel}`;
	} else {
		// Only tools, no thinking. Show count instead of duration.
		const count = toolCalls?.length ?? 0;
		label = `Tools · ${count}`;
	}

	return (
		<div className="text-xs text-muted-foreground border-l-2 border-border pl-3 mb-2">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
				aria-expanded={expanded}
			>
				{expanded ? (
					<ChevronDown className="h-3 w-3" />
				) : (
					<ChevronRight className="h-3 w-3" />
				)}
				{inProgress && (
					<Loader2
						className="h-3 w-3 motion-safe:animate-spin"
						aria-hidden="true"
						data-testid="reasoning-inprogress-spinner"
					/>
				)}
				<span>{label}</span>
			</button>
			{expanded && (
				<div className="mt-2">
					{hasText && (
						<div className="text-foreground/80 max-h-[40vh] overflow-y-auto">
							<Markdown content={text} components={{}} />
						</div>
					)}
					{hasText && hasToolCalls && (
						<div
							className="my-2 border-t border-border"
							aria-hidden="true"
						/>
					)}
					{hasToolCalls && (
						<ul
							className="space-y-1 text-foreground/80"
							aria-label="Tool calls"
						>
							{toolCalls?.map((tc) => (
								<ToolCallRow key={tc.id} entry={tc} />
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

interface ToolCallRowProps {
	entry: ToolCallEntry;
}

/**
 * Tools that don't fire on the server immediately — they synthesize a
 * matching ToolMessage via `buildConfirmChangesCommand` and stay
 * `pending` in `state.toolCallsByTurn` until the user accepts the
 * confirm_changes modal. Backend semantic (`agents/.../chat-node.ts`):
 * pending = awaiting user, NOT in-flight. Render them with a
 * non-spinning clock so the trace stops lying about state ("Calling X…"
 * implied the server was working; in reality the agent is parked,
 * waiting for the human). Match on canonical tool name only.
 *
 * Keep in sync with `INLINE_TOOLS` in chat-node.ts. Adding a tool that
 * does round-trip through `tool_node` (e.g. `write_document_asset`)
 * here would mask real in-flight failures as "awaiting confirmation"
 * — do not add server-side tools to this set.
 */
const AWAITING_CONFIRMATION_TOOLS = new Set([
	"write_document_local",
	"apply_document_patches",
]);

/**
 * Single row in the tool-calls list. Compact layout:
 *   [icon] [name]                                            [duration|...]
 *
 * - `pending` (inline confirmation tool) → static Clock + name +
 *   "awaiting" hint; trace stays honest while the user reviews the
 *   confirm_changes modal (no spinner means no false "in flight").
 * - `pending` (other tools) → animated Loader2 spinner + name + "…"
 * - `success`  → green Check + name + duration (e.g. "0.4s")
 * - `error`    → amber AlertCircle + name + duration; tooltip carries the
 *                error message (kept compact in the list to preserve
 *                vertical density when many tools are called).
 */
function ToolCallRow({ entry }: ToolCallRowProps) {
	const { name, status, durationMs, errorMessage } = entry;
	const hasDuration =
		typeof durationMs === "number" && Number.isFinite(durationMs);
	const durationText = hasDuration
		? `${(durationMs / 1000).toFixed(1)}s`
		: "";

	let icon: React.ReactNode;
	let trailing: string;
	let title: string | undefined;
	let dataPendingKind: string | undefined;

	if (status === "pending") {
		if (AWAITING_CONFIRMATION_TOOLS.has(name)) {
			icon = (
				<Clock
					className="h-3 w-3 text-muted-foreground"
					aria-label="Awaiting confirmation"
				/>
			);
			trailing = "awaiting";
			title = `${name} — awaiting your confirmation`;
			dataPendingKind = "awaiting-confirmation";
		} else {
			icon = (
				<Loader2
					className="h-3 w-3 animate-spin text-muted-foreground"
					aria-label="In progress"
				/>
			);
			trailing = "…";
			title = `Calling ${name}…`;
			dataPendingKind = "in-flight";
		}
	} else if (status === "error") {
		icon = (
			<AlertCircle
				className="h-3 w-3 text-destructive"
				aria-label="Error"
			/>
		);
		trailing = durationText;
		title = errorMessage ? `${name}: ${errorMessage}` : `${name} failed`;
	} else {
		icon = (
			<Check
				className="h-3 w-3 text-emerald-600 dark:text-emerald-400"
				aria-label="Success"
			/>
		);
		trailing = durationText;
		title = name;
	}

	return (
		<li
			className="flex items-center gap-2 text-[11px]"
			title={title}
			data-testid="tool-call-row"
			data-tool-status={status}
			data-pending-kind={dataPendingKind}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate font-mono">{name}</span>
			<span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
				{trailing}
			</span>
		</li>
	);
}
