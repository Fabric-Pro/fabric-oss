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
	Link2Icon,
	Loader2Icon,
	RotateCcwIcon,
	SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import { LinkPmItemDialog } from "./LinkPmItemDialog";
import {
	isPmCreateUnconfirmedError,
	isPmLegacyOtherToolLinkError,
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
	 *
	 * Also the primary action, labelled "Unlink & re-create", for a create that
	 * may already have landed in the PM tool unlinked: there a plain retry is
	 * refused, and re-creating is the user's call after checking the PM tool.
	 * Likewise for a legacy link to a ticket in a different PM tool, which no
	 * sync replaces on its own.
	 */
	onUnlinkRecreate?: () => void;
	isUnlinking?: boolean;
	/**
	 * "Link to existing item" for a create that may already have landed in
	 * the PM tool unlinked: links the item to the PM item the user names,
	 * instead of creating another. Wired by a caller only while the item has
	 * no PM link; offered beside Unlink & re-create for that failure only.
	 * Resolves when linked (the panel then closes); rejects with the server's
	 * reason, which the dialog shows.
	 */
	onLinkExisting?: (externalId: string) => Promise<unknown>;
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
	onLinkExisting,
	onRelink,
	isRelinking,
	settingsHref,
}: Props) {
	const attemptedDisplay = attemptedAt
		? formatAttemptedAt(attemptedAt)
		: null;
	const truncatedError = truncateError(error);
	const [linkDialogOpen, setLinkDialogOpen] = useState(false);

	// Both stay "Sync failed" — no special title or chip. We classify the error
	// only to pick the primary action: a deleted-card 404 re-creates under the
	// hood (a plain retry would re-hit the 404); a tool mismatch relinks (a plain
	// retry can never clear it). Everything else is a plain retry.
	// A legacy link to another PM tool: checked first, because its message
	// also names Unlink & re-create and a "different PM tool", and a "Push &
	// relink" cannot migrate an unstamped link.
	// A create that may already have landed unlinked: every push refuses to
	// create again until the user re-creates on purpose, after checking the PM
	// tool. Checked before a not-found: its message can quote a transport
	// error that reads like one.
	const legacyOtherTool = isPmLegacyOtherToolLinkError(error);
	const unconfirmed = !legacyOtherTool && isPmCreateUnconfirmedError(error);
	const missing =
		!legacyOtherTool && !unconfirmed && isPmTicketMissingError(error);
	const mismatch =
		!legacyOtherTool &&
		!unconfirmed &&
		!missing &&
		isPmToolMismatchError(error);
	const explicitRecreate =
		(unconfirmed || legacyOtherTool) && !!onUnlinkRecreate;
	const offerLinkExisting = unconfirmed && !!onLinkExisting;
	const recreating =
		(missing || unconfirmed || legacyOtherTool) && !!onUnlinkRecreate;
	const relinking = mismatch && !!onRelink;
	const primaryBusy = recreating
		? !!isUnlinking
		: relinking
			? !!isRelinking
			: !!isRetrying;
	const primaryLabel = relinking
		? "Push & relink"
		: explicitRecreate
			? "Unlink & re-create"
			: "Retry sync";
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
						{legacyOtherTool
							? `This item is linked to a ticket in a different PM tool than ${pmToolName}, saved before Fabric recorded which tool a link belongs to, so Fabric won't replace it on its own. Unlink & re-create drops the old link and makes a new ${pmToolName} item (the old ticket isn't deleted).`
							: unconfirmed
								? `${pmToolName} may already have this item: Fabric sent a create it could not confirm or link, so it won't create another on its own. Check ${pmToolName} first — ${
										offerLinkExisting
											? "if the item is there, Link to existing item links this one to it; if it isn't"
											: "if the item isn't there"
									}, Unlink & re-create makes a new one.`
								: missing
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
					{offerLinkExisting && onLinkExisting && (
						<LinkPmItemDialog
							open={linkDialogOpen}
							onOpenChange={setLinkDialogOpen}
							onSubmit={async (externalId) => {
								await onLinkExisting(externalId);
								onOpenChange(false);
							}}
							copy={{
								title: "Link to existing item",
								description: `Enter the ID or key of the ${pmToolName} item Fabric's create made. Fabric checks it in ${pmToolName}, links this item to it and creates nothing; the next push updates it.`,
								label: `${pmToolName} item ID or key`,
								placeholder: "e.g. 1234 or PROJ-12",
								submit: "Link item",
								cancel: "Cancel",
							}}
							trigger={
								<Button
									type="button"
									size="sm"
									variant="outline"
								>
									<Link2Icon
										className="size-3.5 mr-1.5"
										aria-hidden="true"
									/>
									Link to existing item
								</Button>
							}
						/>
					)}
					<Button
						type="button"
						size="sm"
						onClick={onPrimary}
						disabled={primaryBusy}
						title={
							legacyOtherTool && explicitRecreate
								? `Drops the old link and creates a new item in ${pmToolName}`
								: explicitRecreate
									? `Creates a new item in ${pmToolName} — check ${pmToolName} first for an existing one`
									: recreating
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
