"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { useRef } from "react";

export type DuplicateScanCompletionResult = {
	/** Distinct active stories currently flagged as a possible duplicate
	 * (response `flaggedItems`) — the same set the roadmap "Possible duplicates"
	 * filter shows. Drives both the found/zero variant and the headline count. */
	flaggedItems: number;
	/** Active stories with detection text that were scanned (response `scanned`). */
	scanned: number;
	/** Candidate pairs the cosine pre-filter produced this run (response
	 * `candidates`). With `verifierFailures`, tells whether a "0 confirmed"
	 * result is a clean scan or one that couldn't verify. */
	candidates: number;
	/** Verifier calls that errored this run (response `verifierFailures`). Their
	 * pairs stay unverified and are retried next scan. `>= candidates` (with
	 * `candidates > 0`) means NOTHING could be checked — a wholesale AI outage,
	 * not a clean scan. */
	verifierFailures: number;
};

export interface DuplicateScanCompletionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Latest scan result; `null` before the first completed scan. */
	result: DuplicateScanCompletionResult | null;
	/** Invoked when the user chooses "View Duplicates" (before the dialog closes). */
	onViewDuplicates: () => void;
	/** Re-run the scan (used by "Scan again" when verification couldn't finish). */
	onRetry?: () => void;
}

/**
 * Required-dismiss summary shown when a duplicate scan finishes.
 *
 * Found variant (`flaggedItems > 0`) reports how many items carry a
 * "Possible duplicate" chip (matching the roadmap filter), and offers a
 * one-click jump into the duplicates-only roadmap filter. Zero variant
 * reports how many items were scanned and that nothing was tagged.
 *
 * Incomplete variant (`verifierFailures >= candidates > 0`) fires when the
 * AI reviewer couldn't check a single candidate pair — a transient outage,
 * not a clean scan. It leads with "couldn't finish", makes clear nothing was
 * changed, and offers "Scan again". A PARTIAL failure (some pairs checked,
 * some not) keeps the found/zero variant but adds a warning line so the count
 * isn't mistaken for the whole picture.
 *
 * Backdrop clicks are blocked so the result cannot be dismissed by
 * accident; Escape and the default X close behave like "Done". Because
 * the dialog opens programmatically (no trigger element), it remembers
 * the element that had focus and restores it on close.
 */
export function DuplicateScanCompletionDialog({
	open,
	onOpenChange,
	result,
	onViewDuplicates,
	onRetry,
}: DuplicateScanCompletionDialogProps) {
	const t = useTranslations("projects.stories.duplicates");
	const initialFocusRef = useRef<HTMLButtonElement>(null);
	const openerElementRef = useRef<HTMLElement | null>(null);

	if (!result) {
		return null;
	}
	// Every candidate pair failed verification ⇒ the scan couldn't actually
	// check anything (the manual path returns "0 confirmed" for this exactly as
	// it does for a genuinely clean scan). This takes precedence over the
	// found/zero split so a failed scan never reads as a result.
	const verificationIncomplete =
		result.candidates > 0 && result.verifierFailures >= result.candidates;
	// Some — but not all — pairs failed: the shown count is real but partial.
	const partialFailure =
		result.verifierFailures > 0 && !verificationIncomplete;
	const canRetry = verificationIncomplete && typeof onRetry === "function";
	const hasDuplicates = !verificationIncomplete && result.flaggedItems > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-md"
				onInteractOutside={(event) => event.preventDefault()}
				onOpenAutoFocus={(event) => {
					// Radix's default auto-focus lands on the first focusable
					// element in the DOM; the expected initial focus is the
					// primary action for the variant instead. The previously
					// focused element is captured first so close can restore it.
					openerElementRef.current =
						document.activeElement instanceof HTMLElement
							? document.activeElement
							: null;
					event.preventDefault();
					initialFocusRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					// With no trigger element, Radix would drop focus to the
					// document body on close; send it back to where it was.
					event.preventDefault();
					openerElementRef.current?.focus();
					openerElementRef.current = null;
				}}
			>
				<DialogHeader>
					<DialogTitle
						className="font-normal text-xl"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						{verificationIncomplete
							? t("scanIncompleteTitle")
							: hasDuplicates
								? t("scanCompleteTitle")
								: t("scanNoneTitle")}
					</DialogTitle>
					{/* asChild so both lines are part of the dialog's
					    aria-describedby and announced together on open. */}
					<DialogDescription asChild>
						<div className="space-y-1.5">
							{verificationIncomplete ? (
								<>
									<p>
										{t("scanIncompleteDescription", {
											count: result.verifierFailures,
										})}
									</p>
									<p>{t("scanIncompleteUnchanged")}</p>
								</>
							) : (
								<>
									<p>
										{hasDuplicates
											? t("scanCompleteItems", {
													count: result.flaggedItems,
												})
											: t("scanNoneDescription", {
													count: result.scanned,
												})}
									</p>
									<p>
										{hasDuplicates
											? t("scanCompleteTagged")
											: t("scanNoneTagged")}
									</p>
									{partialFailure ? (
										<p className="text-highlight-foreground">
											{t("scanPartialWarning", {
												count: result.verifierFailures,
											})}
										</p>
									) : null}
								</>
							)}
						</div>
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						aria-label={t("doneAria")}
						// The primary action (Scan again / View Duplicates) takes
						// initial focus; Done only does so when it is the sole
						// action (clean zero variant, or incomplete with no retry).
						ref={
							canRetry || hasDuplicates
								? undefined
								: initialFocusRef
						}
						onClick={() => onOpenChange(false)}
					>
						{t("done")}
					</Button>
					{canRetry ? (
						<Button
							type="button"
							variant="primary"
							aria-label={t("scanAgainAria")}
							ref={initialFocusRef}
							onClick={() => {
								onOpenChange(false);
								onRetry?.();
							}}
						>
							{t("scanAgain")}
						</Button>
					) : hasDuplicates ? (
						<Button
							type="button"
							variant="primary"
							aria-label={t("viewDuplicatesAria")}
							ref={initialFocusRef}
							onClick={() => {
								onViewDuplicates();
								onOpenChange(false);
							}}
						>
							{t("viewDuplicates")}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
