"use client";

/**
 * `DiffOutcomeChip` — spec 2026-05-19-ai-assistant-document-chat-history
 * §3.8 FR-23, AC-2 (Group G.2).
 *
 * Renders the persisted accept/reject outcome for a single
 * `write_document_local` tool-call. Used by BOTH the History drawer's
 * read-only viewer pane AND the live `CopilotAssistantMessage` bubble,
 * so the outcome UX is consistent across the two surfaces. Reads from
 * `acceptedAt` / `rejectedAt` directly — never re-derives, so the chip
 * always matches what the server stamped via
 * `agents.conversations.recordDiffOutcome`.
 *
 * Three states (variant + accessible label):
 *   - `acceptedAt` set   → "Accepted" (Badge `default`  — primary fill)
 *                          + inline "View version" link that opens the
 *                          editor's Version History dialog
 *   - `rejectedAt` set   → "Rejected" (Badge `outline` — destructive border)
 *                          + same "View version" link so the user can see
 *                          what the document looked like at the time of
 *                          rejection (the change was never applied, but
 *                          version history still lets them inspect the
 *                          surrounding state).
 *   - neither set        → "Pending"  (Badge `secondary` — muted fill)
 *                          while the chat waits on the call: its confirm
 *                          card is live in the editor (Fizzy #2946)
 *   - neither set, and the chat waits on nothing for it
 *                        → "No decision recorded" (Badge `outline`, muted):
 *                          an old proposal nobody answered, or one answered
 *                          without a stamp. It used to read "Pending"
 *                          forever, with no review to answer in the editor.
 *
 * The chip itself is purely informational (no role, no tabIndex). The
 * adjacent "View version" affordance IS a proper `<button>` so keyboard
 * users can activate it via Tab + Enter.
 */

import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { useContext } from "react";

export interface DiffOutcomeChipToolCall {
	/** The tool call's id, matched against the calls the chat waits on. */
	id?: string | null;
	acceptedAt?: string | null;
	rejectedAt?: string | null;
}

/**
 * The tool calls whose accept or reject the editors stamp — the proposals
 * the chip speaks for. Any other tool the assistant calls has no decision
 * to show.
 */
const REVIEWED_TOOL_NAMES: ReadonlySet<string> = new Set([
	"write_document_local",
	"confirm_changes",
]);

/**
 * Whether a tool call named `name` gets an outcome chip: a proposal the
 * editors stamp, or a call whose name was not kept.
 */
export function hasDiffOutcome(name: string | null | undefined): boolean {
	return typeof name !== "string" || REVIEWED_TOOL_NAMES.has(name);
}

const NO_TOOL_CALLS: ReadonlySet<string> = new Set();

/**
 * The tool calls the chat waits on for an answer right now — a proposal's
 * confirm card is live while its call is among them (Fizzy #2946). None
 * outside a CopilotKit provider, as in the History drawer of a page without
 * one.
 */
function useAwaitedToolCallIds(): ReadonlySet<string> {
	return useContext(CopilotKitContext)?.executingToolCallIds ?? NO_TOOL_CALLS;
}

/**
 * Trigger the editor's existing "Version history" dialog. Both
 * DocumentEditor and StoryWorkspace render the trigger button in the
 * page masthead with `aria-label="Version history, current v…"`. Looking
 * it up by aria-label avoids threading a callback through ConversationViewer
 * → CopilotHistoryDrawer → DocumentEditor's `showVersionHistory` state
 * across multiple component boundaries. The matching button is always
 * present in the same shell that mounts the History drawer, so the
 * lookup is local and reliable.
 *
 * If the masthead button isn't on screen (e.g. an out-of-context render
 * during tests), we no-op silently — the chip is still rendered with a
 * descriptive label, and the test surface doesn't try to assert the dialog.
 */
function openVersionHistoryDialog(): void {
	if (typeof document === "undefined") {
		return;
	}
	const trigger = document.querySelector<HTMLButtonElement>(
		'button[aria-label^="Version history, current v"]',
	);
	if (trigger) {
		trigger.click();
	}
}

/**
 * Format an ISO timestamp as a compact relative phrase ("3m ago",
 * "yesterday", "Mar 4"). Used on the chip's hover tooltip so the user
 * can see WHEN a change was applied without leaving the chat. Errors
 * (malformed input, missing Intl) return an empty string so the badge
 * still renders with just the action label.
 */
function formatRelativeTimestamp(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) {
		return "";
	}
	const deltaMs = Date.now() - t;
	const seconds = Math.round(deltaMs / 1000);
	if (seconds < 60) {
		return "just now";
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.round(hours / 24);
	if (days < 7) {
		return `${days}d ago`;
	}
	try {
		const date = new Date(t);
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	} catch {
		return "";
	}
}

export function DiffOutcomeChip({
	toolCall,
}: {
	toolCall: DiffOutcomeChipToolCall;
}) {
	const tTooltips = useTranslations("tooltips.common");
	const awaited = useAwaitedToolCallIds();
	if (toolCall.acceptedAt) {
		const when = formatRelativeTimestamp(toolCall.acceptedAt);
		const badgeTooltip = when ? `Accepted ${when}` : "Accepted";
		return (
			<span className="inline-flex items-center gap-1.5">
				<Badge
					variant="default"
					className="font-normal"
					title={badgeTooltip}
				>
					Accepted{when ? ` · ${when}` : ""}
				</Badge>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={openVersionHistoryDialog}
							className="inline-flex items-center gap-1 rounded text-[11px] text-primary underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
							aria-label="Open version history to view the applied change"
						>
							<History className="size-3" aria-hidden="true" />
							View version
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{tTooltips("openVersionHistory")}
					</TooltipContent>
				</Tooltip>
			</span>
		);
	}
	if (toolCall.rejectedAt) {
		const when = formatRelativeTimestamp(toolCall.rejectedAt);
		const badgeTooltip = when ? `Rejected ${when}` : "Rejected";
		return (
			<span className="inline-flex items-center gap-1.5">
				<Badge
					variant="outline"
					className="border-destructive/40 font-normal text-destructive"
					title={badgeTooltip}
				>
					Rejected{when ? ` · ${when}` : ""}
				</Badge>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={openVersionHistoryDialog}
							className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
							aria-label="Open version history to view the document state at the time of rejection"
						>
							<History className="size-3" aria-hidden="true" />
							View version
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{tTooltips("openVersionHistory")}
					</TooltipContent>
				</Tooltip>
			</span>
		);
	}
	if (toolCall.id && awaited.has(toolCall.id)) {
		return (
			<Badge
				variant="secondary"
				className="font-normal"
				title="Awaiting user decision — open the document to accept or reject this change"
			>
				Pending
			</Badge>
		);
	}
	return (
		<Badge
			variant="outline"
			className="font-normal text-muted-foreground"
			title="No longer awaiting a decision — no accept or reject was recorded for this change"
		>
			No decision recorded
		</Badge>
	);
}
