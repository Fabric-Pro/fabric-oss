"use client";

/**
 * Sticky bulk-action bar (G8) — the manual counterpart of the AI review. Shown
 * when one or more findings are selected; lets the user change severity, mark
 * resolved, or dismiss across the whole selection in one call. Every action is
 * confirmed first (it edits many findings at once), then applied via
 * `scan.findings.bulkUpdate` by the parent.
 *
 * Accessibility: the bar is a labelled `role="region"` so screen readers can
 * jump to it; the selection count is announced via an `aria-live` status; all
 * controls are keyboard reachable and icon-only controls carry `aria-label`.
 */

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	CheckCircle2Icon,
	ChevronDownIcon,
	Loader2Icon,
	SlidersHorizontalIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import {
	type FindingStatus,
	RULE_SEVERITY_OPTIONS,
	type ScanSeverity,
	SEVERITY_LABEL,
} from "./lib";

/** A pending bulk action awaiting confirmation. */
type PendingAction =
	| { kind: "status"; status: FindingStatus }
	| { kind: "severity"; severity: ScanSeverity };

export type BulkChange = { status?: FindingStatus; severity?: ScanSeverity };

export function FindingsBulkBar({
	selectedCount,
	isApplying,
	onApply,
	onClear,
}: {
	selectedCount: number;
	isApplying: boolean;
	/** Apply the change to every selected finding. */
	onApply: (change: BulkChange) => void;
	onClear: () => void;
}) {
	const [pending, setPending] = useState<PendingAction | null>(null);

	if (selectedCount === 0) {
		return null;
	}

	const noun = selectedCount === 1 ? "finding" : "findings";

	const confirmCopy = pending
		? pending.kind === "status"
			? pending.status === "RESOLVED"
				? {
						title: `Mark ${selectedCount} ${noun} resolved?`,
						body: `This marks the selected ${noun} as resolved. They stay on record and drop out of the Open view. You can reopen them later.`,
						action: "Mark resolved",
					}
				: {
						title: `Dismiss ${selectedCount} ${noun}?`,
						body: `This dismisses the selected ${noun} as not applicable. They're hidden from the default view and can be reopened later.`,
						action: "Dismiss",
					}
			: {
					title: `Change severity of ${selectedCount} ${noun}?`,
					body: `This sets the selected ${noun} to ${
						SEVERITY_LABEL[pending.severity]
					}. The change applies now and doesn't re-run the scan.`,
					action: "Change severity",
				}
		: null;

	const runPending = () => {
		if (!pending) {
			return;
		}
		if (pending.kind === "status") {
			onApply({ status: pending.status });
		} else {
			onApply({ severity: pending.severity });
		}
		setPending(null);
	};

	return (
		<>
			<section
				aria-label="Bulk actions for selected findings"
				className="sticky bottom-4 z-20 mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 shadow-lg"
			>
				<p
					className="font-medium text-foreground text-sm"
					aria-live="polite"
				>
					<span className="tabular-nums">{selectedCount}</span>{" "}
					selected
				</p>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								disabled={isApplying}
								className="gap-1.5"
							>
								<SlidersHorizontalIcon
									aria-hidden="true"
									className="size-4"
								/>
								Set severity
								<ChevronDownIcon
									aria-hidden="true"
									className="size-3.5"
								/>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuLabel>
								Set severity to
							</DropdownMenuLabel>
							<DropdownMenuSeparator />
							{RULE_SEVERITY_OPTIONS.map((opt) => (
								<DropdownMenuItem
									key={opt.value}
									onSelect={() =>
										setPending({
											kind: "severity",
											severity: opt.value,
										})
									}
								>
									{opt.label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>

					<Button
						variant="outline"
						size="sm"
						disabled={isApplying}
						onClick={() =>
							setPending({ kind: "status", status: "RESOLVED" })
						}
						className="gap-1.5"
					>
						{isApplying ? (
							<Loader2Icon
								aria-hidden="true"
								className="size-4 motion-safe:animate-spin"
							/>
						) : (
							<CheckCircle2Icon
								aria-hidden="true"
								className="size-4 text-secondary"
							/>
						)}
						Mark resolved
					</Button>

					<Button
						variant="ghost"
						size="sm"
						disabled={isApplying}
						onClick={() =>
							setPending({ kind: "status", status: "DISMISSED" })
						}
						className="gap-1.5"
					>
						<XCircleIcon aria-hidden="true" className="size-4" />
						Dismiss
					</Button>

					<Button
						variant="ghost"
						size="icon"
						onClick={onClear}
						disabled={isApplying}
						aria-label="Clear selection"
					>
						<XIcon aria-hidden="true" className="size-4" />
					</Button>
				</div>
			</section>

			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPending(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirmCopy?.title}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirmCopy?.body}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={runPending}>
							{confirmCopy?.action}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
