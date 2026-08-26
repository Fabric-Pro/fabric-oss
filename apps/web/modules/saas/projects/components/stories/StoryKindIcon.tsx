import { cn } from "@ui/lib";
import { BugIcon, PuzzleIcon } from "lucide-react";
import { getPriorityColor, type StoryPriority } from "../../lib/stories/types";

/**
 * The leading work-item indicator, shared across the roadmap, board, kanban and
 * editors so a Feature/Bug always reads the same way:
 *  - Feature → a Puzzle-piece glyph tinted by priority (Critical red · High orange ·
 *    Medium yellow · Low green) via the single `getPriorityColor` source of truth.
 *  - Bug → the destructive-red bug glyph (bugs are not priority-tinted).
 *
 * Purely presentational; wrap in a <Tooltip> at the call site when a label is
 * wanted. `aria-hidden` because the adjacent identifier/title already name the item.
 */
export function StoryKindIcon({
	kind,
	priority,
	className,
}: {
	kind: string;
	priority: string;
	className?: string;
}) {
	if (kind === "BUG") {
		return (
			<BugIcon
				aria-hidden
				className={cn("shrink-0 text-destructive", className)}
			/>
		);
	}
	return (
		<PuzzleIcon
			aria-hidden
			className={cn("shrink-0", className)}
			style={{ color: getPriorityColor(priority as StoryPriority) }}
		/>
	);
}
