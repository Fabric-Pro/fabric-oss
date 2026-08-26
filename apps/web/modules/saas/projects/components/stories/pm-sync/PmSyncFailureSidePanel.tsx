"use client";

import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import {
	ArrowUpFromLineIcon,
	Loader2Icon,
	RotateCcwIcon,
	SettingsIcon,
} from "lucide-react";
import {
	isPmTicketMissingError,
	isPmToolMismatchError,
} from "./PmSyncFailureBadge";

const ERROR_DISPLAY_LIMIT = 500;

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pmToolName: string;
	error?: string | null;
	attemptedAt?: Date | string | null;
	onRetry: () => void;
	isRetrying?: boolean;
	/**
	 * Re-create handler for a deleted-card (404) failure. When wired and the
	 * error is a not-found, the single "Retry sync" button uses THIS under the
	 * hood (unlink the dead card + create a fresh one) instead of a plain retry
	 * — a plain retry would just hit the same 404. There is no separate button
	 * and no separate chip: every failure shows as "Sync failed"; the 404 detail
	 * lives in the error block below and Retry just does the right thing.
	 */
	onUnlinkRecreate?: () => void;
	isUnlinking?: boolean;
	/**
	 * Relink handler for a "synced to a different PM tool" (PM_TOOL_MISMATCH)
	 * failure. When wired and the error is a mismatch, the primary button becomes
	 * "Push & relink" — an override push that drops the old link and creates a
	 * fresh card in {pmToolName} — instead of a plain Retry, which would just
	 * re-hit the mismatch. Mirrors the roadmap's migrate flow.
	 */
	onRelink?: () => void;
	isRelinking?: boolean;
	/**
	 * Link to the project's PM-tool settings (Project Management section). When
	 * set, a "PM settings" action is shown so a user hitting a stale-board /
	 * site-access failure can re-select the board without hunting for it.
	 */
	settingsHref?: string;
};

export function PmSyncFailureSidePanel({
	open,
	onOpenChange,
	pmToolName,
	error,
	attemptedAt,
	onRetry,
	isRetrying,
	onUnlinkRecreate,
	isUnlinking,
	onRelink,
	isRelinking,
	settingsHref,
}: Props) {
	const attemptedDisplay = attemptedAt
		? formatAttemptedAt(attemptedAt)
		: null;
	const truncatedError = truncateError(error);

	// Both stay "Sync failed" — no special title or chip. We classify the error
	// only to pick the primary action: a deleted-card 404 re-creates under the
	// hood (a plain retry would re-hit the 404); a tool mismatch relinks (a plain
	// retry can never clear it). Everything else is a plain retry.
	const missing = isPmTicketMissingError(error);
	const mismatch = !missing && isPmToolMismatchError(error);
	const recreating = missing && !!onUnlinkRecreate;
	const relinking = mismatch && !!onRelink;
	const primaryBusy = recreating
		? !!isUnlinking
		: relinking
			? !!isRelinking
			: !!isRetrying;
	const primaryLabel = relinking ? "Push & relink" : "Retry sync";
	const onPrimary = () =>
		recreating
			? onUnlinkRecreate?.()
			: relinking
				? onRelink?.()
				: onRetry();

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full bg-card border-l border-border sm:max-w-md p-6 motion-safe:transition-transform"
			>
				<SheetHeader className="space-y-2">
					<span className="editorial-label">SYNC FAILED</span>
					<SheetTitle
						className="font-normal text-2xl"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						Sync failed
					</SheetTitle>
					<SheetDescription>
						{missing
							? `The last sync failed — the linked ${pmToolName} card no longer exists (it was deleted or can no longer be found). Retry to re-create it in ${pmToolName}.`
							: mismatch
								? `This item is linked to a different PM tool than ${pmToolName}. Push & relink creates a fresh ${pmToolName} item and drops the old link (the previous item isn't deleted) — a plain retry can't clear this.`
								: `${pmToolName} rejected the latest update. Review the error and retry when ready.`}
					</SheetDescription>
				</SheetHeader>

				<div className="mt-6 space-y-4">
					{attemptedDisplay && (
						<div className="space-y-1">
							<span className="block text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
								Attempted
							</span>
							<p className="text-sm text-foreground">
								{attemptedDisplay}
							</p>
						</div>
					)}

					{/* The error is always shown — including the raw 404 for a
					    deleted card — so the failure detail lives here rather than
					    being encoded into a separate chip. */}
					<div className="space-y-1">
						<span className="block text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
							Error
						</span>
						<pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground font-mono">
							{truncatedError ?? "No error details available."}
						</pre>
					</div>
				</div>

				<div className="mt-6 flex items-center justify-end gap-2">
					{settingsHref && (
						<Button
							asChild
							type="button"
							size="sm"
							variant="outline"
							className="mr-auto"
						>
							<a href={settingsHref}>
								<SettingsIcon
									className="size-3.5 mr-1.5"
									aria-hidden="true"
								/>
								PM settings
							</a>
						</Button>
					)}
					<Button
						type="button"
						size="sm"
						onClick={onPrimary}
						disabled={primaryBusy}
						title={
							recreating
								? `Retry — unlinks the missing card and re-creates it in ${pmToolName}`
								: relinking
									? `Drops the old link and creates a fresh ${pmToolName} item`
									: undefined
						}
					>
						{primaryBusy ? (
							<Loader2Icon
								className="size-3.5 mr-1.5 animate-spin"
								aria-hidden="true"
							/>
						) : relinking ? (
							<ArrowUpFromLineIcon
								className="size-3.5 mr-1.5"
								aria-hidden="true"
							/>
						) : (
							<RotateCcwIcon
								className="size-3.5 mr-1.5"
								aria-hidden="true"
							/>
						)}
						{primaryLabel}
					</Button>
				</div>
			</SheetContent>
		</Sheet>
	);
}

function truncateError(error: string | null | undefined): string | null {
	if (!error) {
		return null;
	}
	if (error.length <= ERROR_DISPLAY_LIMIT) {
		return error;
	}
	return `${error.slice(0, ERROR_DISPLAY_LIMIT)}…`;
}

function formatAttemptedAt(value: Date | string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return date.toLocaleString();
}
