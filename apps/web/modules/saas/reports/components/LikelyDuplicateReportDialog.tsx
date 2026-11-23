"use client";

import { useDialogFocusReturn } from "@saas/reports/hooks/use-dialog-focus-return";
import type { LikelyDuplicateReport } from "@saas/reports/hooks/use-likely-duplicate-guard";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { format, formatDistanceToNow } from "date-fns";
import Link from "next/link";

function matchLabel(report: LikelyDuplicateReport): string {
	if (report.sameTitle && report.samePrompt) {
		return "Same title and prompt";
	}
	return report.sameTitle ? "Same title" : "Same prompt";
}

function statusLabel(report: LikelyDuplicateReport): string {
	if (report.status === "DRAFT") {
		return "Draft";
	}
	return report.isActive ? "Active" : "Paused";
}

/** What tells two reports apart: their template, state and owner. */
function describeReport(report: LikelyDuplicateReport): string {
	const owner = report.ownedByCaller ? "Yours" : "Another member's";
	const status = statusLabel(report);
	return `Based on ${report.templateName} · ${status} · ${owner}`;
}

/** When the report was made and last ran. */
function describeHistory(report: LikelyDuplicateReport): string {
	const created = format(new Date(report.createdAt), "MMM d, yyyy");
	if (!report.lastRunAt) {
		return `Created ${created} · Never run`;
	}
	const lastRun = formatDistanceToNow(new Date(report.lastRunAt), {
		addSuffix: true,
	});
	return `Created ${created} · Last run ${lastRun}`;
}

/**
 * Warns, before a report is created, that it would likely duplicate one the
 * person can already open. They may cancel, create it anyway, or open an
 * existing report instead; only continuing creates anything.
 */
export function LikelyDuplicateReportDialog({
	duplicates,
	reportTemplatesPath,
	continueLabel,
	onCancel,
	onContinue,
}: {
	duplicates: LikelyDuplicateReport[] | null;
	/** Where report instance pages live (`…/report-templates`). */
	reportTemplatesPath: string;
	continueLabel: string;
	onCancel: () => void;
	onContinue: () => void;
}) {
	// Opened by a check, not a trigger: return focus to what started it.
	const focusReturn = useDialogFocusReturn();
	return (
		<AlertDialog
			open={duplicates !== null}
			onOpenChange={(open) => {
				if (!open) {
					onCancel();
				}
			}}
		>
			<AlertDialogContent
				className="max-h-[90vh] overflow-y-auto"
				{...focusReturn}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{duplicates?.length === 1
							? "A similar report already exists"
							: "Similar reports already exist"}
					</AlertDialogTitle>
					<AlertDialogDescription>
						These reports have the same title or the same prompt.
						Open one of them, or create a new report anyway.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<ul className="space-y-2" aria-label="Similar reports">
					{duplicates?.map((report) => (
						<li
							key={report.id}
							className="flex items-start justify-between gap-3 rounded-md border p-3"
						>
							<div className="min-w-0 space-y-1">
								<p className="truncate font-medium">
									{report.name}
								</p>
								<p className="text-xs text-muted-foreground">
									{describeReport(report)}
								</p>
								<p className="text-xs text-muted-foreground">
									{describeHistory(report)}
								</p>
								<Badge variant="secondary">
									{matchLabel(report)}
								</Badge>
							</div>
							<Button variant="outline" size="sm" asChild>
								<Link
									href={`${reportTemplatesPath}/instances/${report.id}`}
									aria-label={`Open ${report.name}`}
								>
									Open
								</Link>
							</Button>
						</li>
					))}
				</ul>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<Button onClick={onContinue}>{continueLabel}</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
