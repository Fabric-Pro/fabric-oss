"use client";

import { Button } from "@ui/components/button";
import { Check, X } from "lucide-react";

/**
 * Visual state styles shared across all suggestion card types.
 */
export const suggestionStateStyles = {
	pending:
		"border-primary/30 bg-card hover:border-primary/50 transition-colors duration-150",
	approved: "border-secondary/40 bg-secondary/5",
	rejected: "border-destructive/30 bg-destructive/5 opacity-60",
	outdated: "border-muted bg-muted/50 opacity-50",
} as const;

/**
 * Shared accept/reject action buttons for suggestion cards and bubble menu.
 */
export function SuggestionActionButtons({
	onAccept,
	onReject,
}: {
	onAccept: () => void;
	onReject: () => void;
}) {
	return (
		<>
			<Button
				size="sm"
				variant="ghost"
				className="h-7 w-7 p-0 text-secondary hover:bg-secondary/10 hover:text-secondary"
				onClick={onAccept}
				aria-label="Accept suggestion"
			>
				<Check className="h-3.5 w-3.5" />
			</Button>
			<Button
				size="sm"
				variant="ghost"
				className="h-7 w-7 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
				onClick={onReject}
				aria-label="Reject suggestion"
			>
				<X className="h-3.5 w-3.5" />
			</Button>
		</>
	);
}

/**
 * Strip HTML tags from a string and optionally truncate.
 */
export function stripHtml(html: string, maxLength?: number): string {
	const text = html.replace(/<[^>]*>/g, "").trim();
	if (maxLength && text.length > maxLength) {
		return `${text.slice(0, maxLength)}...`;
	}
	return text;
}
