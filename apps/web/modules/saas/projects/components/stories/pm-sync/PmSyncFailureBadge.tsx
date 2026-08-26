"use client";

import { cn } from "@ui/lib";
import { CloudOffIcon } from "lucide-react";
import { forwardRef } from "react";

/**
 * Whether a PM-sync error means the linked card was deleted on its server
 * (a push surfaced "Resource not found" / 404 / "does not exist"). This is NOT
 * surfaced as a separate chip — a deleted card shows the same "PM sync failed"
 * badge as any other failure, with the 404 detail inside the failure panel.
 * It is used only to decide, under the hood, whether the panel's Retry should
 * re-create the card (unlink + fresh push) rather than run a plain retry that
 * would just hit the same 404. Vetoes permission shapes ("not found: access
 * denied" is a permission problem, not a deleted card), mirroring the backend
 * humanizer + classifier. Presentation-only — no schema/data change.
 */
export function isPmTicketMissingError(
	error: string | null | undefined,
): boolean {
	if (!error) {
		return false;
	}
	if (
		/permission|forbidden|unauthor|\b401\b|\b403\b|access denied/i.test(
			error,
		)
	) {
		return false;
	}
	return /no longer exists|resource not found|\bnot found\b|does not exist|\b404\b/i.test(
		error,
	);
}

/**
 * Whether a PM-sync error means the item is linked to a DIFFERENT PM tool than
 * the project's current one (the backend `PM_TOOL_MISMATCH` — "synced to a
 * different PM tool"). A plain retry can never clear this: it just pushes to the
 * current tool again and re-hits the mismatch. The failure panel uses this to
 * offer "Push & relink" (an override push that drops the old link and creates a
 * fresh card in the current tool) instead of a dead Retry. Presentation-only.
 */
export function isPmToolMismatchError(
	error: string | null | undefined,
): boolean {
	if (!error) {
		return false;
	}
	return /different pm tool|different tool|PM_TOOL_MISMATCH/i.test(error);
}

type Props = {
	onClick?: () => void;
	className?: string;
	pmToolName?: string;
};

/**
 * The single PM-sync failure chip. Every failure — including a deleted-card
 * 404 — renders this one red "PM sync failed" badge; the specifics (the 404,
 * the rejection reason) live inside the failure panel it opens on click.
 */
export const PmSyncFailureBadge = forwardRef<HTMLButtonElement, Props>(
	function PmSyncFailureBadge({ onClick, className, pmToolName }, ref) {
		const ariaLabel = pmToolName
			? `PM sync failed — open ${pmToolName} sync error details`
			: "PM sync failed — open error details";

		return (
			<button
				ref={ref}
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onClick?.();
				}}
				aria-label={ariaLabel}
				className={cn(
					"inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-0.5",
					"text-[10px] font-medium uppercase tracking-[0.18em]",
					"transition-colors focus-visible:outline-none focus-visible:ring-2",
					"border-destructive/30 text-destructive hover:border-destructive/50 hover:bg-destructive/5 focus-visible:ring-destructive/50",
					className,
				)}
			>
				<CloudOffIcon className="size-3" aria-hidden="true" />
				PM sync failed
			</button>
		);
	},
);
