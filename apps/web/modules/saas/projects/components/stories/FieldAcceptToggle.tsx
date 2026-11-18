"use client";

import { cn } from "@ui/lib";
import { CheckIcon, XIcon } from "lucide-react";

/**
 * Inline accept/reject control for one proposed change: a diffed field in
 * the detail dialog, or one line hunk in its line-by-line review. Mirrors
 * the document editor's per-mark accept/reject.
 *
 * "Accepted" is the default; one click flips it to "Rejected", which keeps
 * the current text for that change when the item is applied. Click again to
 * flip back.
 */
export function FieldAcceptToggle({
	isRejected,
	onToggle,
	subject,
	disabled = false,
}: {
	isRejected: boolean;
	onToggle: () => void;
	/** What the control decides, e.g. "Description change". */
	subject: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			disabled={disabled}
			aria-label={isRejected ? `Restore ${subject}` : `Reject ${subject}`}
			aria-pressed={isRejected}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:pointer-events-none disabled:opacity-50",
				isRejected
					? "border-muted-foreground/30 bg-muted/40 text-muted-foreground hover:bg-muted/60"
					: "border-success/30 bg-success/10 text-success hover:bg-success/20",
			)}
		>
			{isRejected ? (
				<>
					<XIcon className="size-3" aria-hidden="true" />
					Rejected
				</>
			) : (
				<>
					<CheckIcon className="size-3" aria-hidden="true" />
					Accepted
				</>
			)}
		</button>
	);
}
