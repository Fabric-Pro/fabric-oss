"use client";

import { downloadHref } from "@saas/frames/lib/download-file";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Skeleton } from "@ui/components/skeleton";
import { useState } from "react";
import { toast } from "sonner";
import {
	CATEGORY_LABEL,
	type ProblemLogCategory,
	type ProblemLogStatus,
	SEVERITY_CONFIG,
	STATUS_LABEL,
} from "./constants";
import {
	buildIncidentReportCsv,
	type IncidentReportRow,
	incidentReportFilename,
	renderIncidentReportPdf,
} from "./incident-report";

type Props = {
	projectId: string;
	organizationId: string | null;
	/** A single-entry report; otherwise the filters and a date range apply. */
	entryId?: string;
	status?: ProblemLogStatus;
	category?: ProblemLogCategory;
	onClose: () => void;
};

/**
 * Incident report (Fizzy #2277): an on-screen preview of the confirmed
 * entries in scope, downloadable as CSV or PDF.
 */
export function IncidentReportDialog({
	projectId,
	organizationId,
	entryId,
	status,
	category,
	onClose,
}: Props) {
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [busy, setBusy] = useState<"csv" | "pdf" | null>(null);
	const rangeInvalid = Boolean(from && to && from > to);

	const reportQuery = useQuery({
		...orpc.problemLog.report.queryOptions({
			input: {
				projectId,
				organizationId,
				...(entryId
					? { entryId }
					: {
							status,
							category,
							// Whole days in the viewer's time zone.
							from: from
								? new Date(`${from}T00:00:00`)
								: undefined,
							to: to ? new Date(`${to}T23:59:59.999`) : undefined,
						}),
			},
		}),
		enabled: !rangeInvalid,
	});

	const rows = (reportQuery.data?.rows ?? []) as IncidentReportRow[];
	const generatedAt = reportQuery.data?.generatedAt ?? new Date();
	const projectName = rows[0]?.projectName ?? "Project";
	const scope = entryId
		? "Single entry"
		: [
				status ? STATUS_LABEL[status] : "All statuses",
				category ? CATEGORY_LABEL[category] : "All categories",
				from || to ? `${from || "…"} – ${to || "…"}` : "All dates",
			].join(" · ");

	const download = async (kind: "csv" | "pdf") => {
		setBusy(kind);
		try {
			const blob =
				kind === "csv"
					? new Blob([buildIncidentReportCsv(rows)], {
							type: "text/csv;charset=utf-8",
						})
					: await renderIncidentReportPdf(rows, {
							projectName,
							generatedAt,
							scope,
						});
			const url = URL.createObjectURL(blob);
			downloadHref(
				url,
				incidentReportFilename(projectName, generatedAt, kind),
			);
			URL.revokeObjectURL(url);
		} catch (error) {
			toast.error(
				`Could not create the ${kind.toUpperCase()}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		} finally {
			setBusy(null);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Incident report</DialogTitle>
					<DialogDescription>{scope}</DialogDescription>
				</DialogHeader>

				{!entryId && (
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="incident-report-from">From</Label>
							<Input
								id="incident-report-from"
								type="date"
								value={from}
								onChange={(e) => setFrom(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="incident-report-to">To</Label>
							<Input
								id="incident-report-to"
								type="date"
								value={to}
								onChange={(e) => setTo(e.target.value)}
								aria-invalid={rangeInvalid}
							/>
						</div>
						{rangeInvalid && (
							<p
								className="text-destructive text-sm sm:col-span-2"
								role="alert"
							>
								The start date must not be after the end date.
							</p>
						)}
					</div>
				)}

				{reportQuery.isPending && !rangeInvalid ? (
					<div className="space-y-2">
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-full" />
					</div>
				) : reportQuery.isError ? (
					<p className="text-destructive text-sm">
						Could not build the report: {reportQuery.error.message}
					</p>
				) : rows.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No confirmed entries in this range.
					</p>
				) : (
					<div className="overflow-x-auto rounded-md border">
						<table className="w-full text-xs">
							<caption className="sr-only">
								Incident report preview
							</caption>
							<thead>
								<tr className="border-b bg-muted/40 text-left text-muted-foreground">
									<th className="px-2 py-1.5 font-medium">
										Last seen
									</th>
									<th className="px-2 py-1.5 font-medium">
										Severity
									</th>
									<th className="px-2 py-1.5 font-medium">
										Problem
									</th>
									<th className="px-2 py-1.5 font-medium">
										Source
									</th>
									<th className="px-2 py-1.5 font-medium">
										Affected user
									</th>
									<th className="px-2 py-1.5 font-medium">
										Status
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<tr
										key={r.id}
										className="border-b align-top last:border-b-0"
									>
										<td className="whitespace-nowrap px-2 py-1.5">
											{new Date(
												r.lastSeenAt,
											).toLocaleString(undefined, {
												dateStyle: "medium",
												timeStyle: "short",
											})}
										</td>
										<td className="px-2 py-1.5">
											{SEVERITY_CONFIG[r.severity].label}
										</td>
										<td className="max-w-[18rem] px-2 py-1.5">
											<div className="break-words font-medium">
												{r.title}
											</div>
											{r.description && (
												<div className="line-clamp-2 break-words text-muted-foreground">
													{r.description}
												</div>
											)}
										</td>
										<td className="break-all px-2 py-1.5 font-mono">
											{r.source}
										</td>
										<td className="px-2 py-1.5">
											{r.affectedUser ?? "—"}
										</td>
										<td className="px-2 py-1.5">
											{STATUS_LABEL[r.status]}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				{reportQuery.data?.truncated && (
					<p className="text-muted-foreground text-xs">
						Showing the {rows.length} most recent entries. Narrow
						the range for the rest.
					</p>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => download("csv")}
						disabled={rows.length === 0 || busy !== null}
						loading={busy === "csv"}
					>
						Download CSV
					</Button>
					<Button
						onClick={() => download("pdf")}
						disabled={rows.length === 0 || busy !== null}
						loading={busy === "pdf"}
					>
						Download PDF
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
