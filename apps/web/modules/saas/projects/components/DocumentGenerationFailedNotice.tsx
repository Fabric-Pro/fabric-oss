"use client";

import { Button } from "@ui/components/button";
import { AlertTriangle, Loader2, RefreshCcwDotIcon } from "lucide-react";

/**
 * Surfaces a failed AI document generation to the user.
 *
 * Background (Business Case QA, AC-7): when generation fails the document row
 * is persisted with `status = "FAILED"` and a `generationError`, but the editor
 * previously rendered the (empty) content as a normal saved document with no
 * indication anything went wrong. This notice makes the failure visible and
 * offers an actionable retry, instead of a silent empty document.
 */
export function DocumentGenerationFailedNotice({
	error,
	onRetry,
	isRetrying = false,
}: {
	/** Server-provided failure reason (`document.generationError`), if any. */
	error?: string | null;
	/** Trigger a fresh regeneration of the document. */
	onRetry: () => void;
	/** Whether a regeneration is already in flight. */
	isRetrying?: boolean;
}) {
	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm">
			<div className="max-w-md rounded-lg border border-border bg-card p-8 shadow-2xl">
				<div className="flex flex-col items-center gap-4 text-center">
					<AlertTriangle className="h-12 w-12 text-destructive" />
					<div>
						<h3 className="mb-2 text-lg font-semibold">
							Generation failed
						</h3>
						<p className="text-sm text-muted-foreground">
							{error
								? error
								: "We couldn't generate this document. No content was produced."}
						</p>
					</div>
					<Button onClick={onRetry} disabled={isRetrying}>
						{isRetrying ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<RefreshCcwDotIcon className="mr-2 h-4 w-4" />
						)}
						Regenerate
					</Button>
				</div>
			</div>
		</div>
	);
}
