"use client";

import type { InstructionRejection } from "@repo/database";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

const RECEIVING_STATUSES = new Set(["RECEIVING", "VALIDATING"]);

/**
 * Delete is offered only for a snapshot whose workflow has finished.
 *
 * Deleting a RECEIVING/VALIDATING row mid-run removes the row the next
 * activity reads, so `loadVerifiedSnapshot`
 * (`packages/temporal/src/activities/project-instructions.ts`) finds nothing
 * and raises a non-retryable `INSTRUCTION_SNAPSHOT_TENANT_MISMATCH` — a
 * tenancy-shaped failure for what was really a self-inflicted, avoidable
 * click. The published snapshot is excluded separately: the server refuses
 * that one with its own CONFLICT.
 */
const DELETABLE_STATUSES = new Set(["READY", "REJECTED", "FAILED"]);

// `capRejections` (packages/temporal/src/activities/project-instructions.ts)
// caps a gate's rejection list at 100 and appends this sentinel row instead
// of an unbounded array — recognizable by `reason`, never a real file.
const TRUNCATED_REASON = "truncated";

export type HistorySnapshot = {
	id: string;
	version: number;
	status: string;
	source: string;
	fileCount: number;
	createdAt: string | Date;
	rejection?: InstructionRejection[] | null;
	user?: { name: string | null } | null;
};

/**
 * Every upload kept for the project, newest first. Publish/Download act on
 * the same `publish`/`createDownloadUrl` procedures the header buttons use;
 * a CONFLICT from either (a newer version already published, or — for
 * delete — this snapshot being the published one) surfaces via the
 * server's own message rather than a generic failure string.
 */
export function InstructionsHistory({
	projectId,
	open,
	onOpenChange,
	snapshots,
	publishedId,
	onChanged,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	snapshots: HistorySnapshot[];
	publishedId: string | null;
	onChanged: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.history");
	// "See why" shows the same rejection rows as the banner, so it reads the
	// banner's own label maps rather than a second copy: a new scan rule then
	// needs one translation entry, not two that can drift apart.
	const tReason = useTranslations(
		"projects.codingInstructions.rejectedBanner",
	);
	const secretLabels = tReason.raw("secretLabels") as Record<string, string>;
	const reasonLabels = tReason.raw("reasonLabels") as Record<string, string>;
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const publish = useMutation(
		orpc.projects.instructions.publish.mutationOptions({
			onSuccess: () => onChanged(),
			onError: (error) => toast.error(error.message),
		}),
	);
	const remove = useMutation(
		orpc.projects.instructions.delete.mutationOptions({
			onSuccess: () => onChanged(),
			onError: (error) => toast.error(error.message),
		}),
	);
	const download = useMutation(
		orpc.projects.instructions.createDownloadUrl.mutationOptions({
			onSuccess: (data) => window.open(data.url, "_blank", "noopener"),
			onError: (error) => toast.error(error.message),
		}),
	);

	function statusBadge(snapshot: HistorySnapshot, isPublished: boolean) {
		if (isPublished) {
			return { label: t("publishedPill"), variant: "success" as const };
		}
		if (RECEIVING_STATUSES.has(snapshot.status)) {
			return { label: t("checkingPill"), variant: "outline" as const };
		}
		if (snapshot.status === "REJECTED") {
			return {
				label: t("rejectedPill"),
				variant: "destructive" as const,
			};
		}
		if (snapshot.status === "FAILED") {
			return { label: t("failedPill"), variant: "destructive" as const };
		}
		return { label: t("readyPill"), variant: "secondary" as const };
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-[420px] flex-col gap-2 overflow-auto">
					{snapshots.map((s) => {
						const isPublished = s.id === publishedId;
						const badge = statusBadge(s, isPublished);
						const rejectionRows =
							s.rejection?.filter(
								(r) => r.reason !== TRUNCATED_REASON,
							) ?? [];
						const truncatedRow = s.rejection?.find(
							(r) => r.reason === TRUNCATED_REASON,
						);
						return (
							<div
								key={s.id}
								className="flex flex-col gap-2 rounded-lg border border-border p-3"
							>
								<div className="flex items-center justify-between gap-3">
									<div className="flex flex-col gap-0.5">
										<div className="flex items-center gap-2">
											<span className="font-medium text-sm">
												{t("versionLabel", {
													version: s.version,
												})}
											</span>
											<Badge variant={badge.variant}>
												{badge.label}
											</Badge>
										</div>
										<p className="text-muted-foreground text-xs">
											{s.user?.name ?? t("anonymousUser")}
											{" · "}
											{formatRelativeTime(s.createdAt)}
											{" · "}
											{t("filesStored", {
												count: s.fileCount,
											})}
										</p>
									</div>
									<div className="flex shrink-0 gap-2">
										{s.status === "READY" &&
										!isPublished ? (
											<Button
												size="sm"
												variant="outline"
												disabled={publish.isPending}
												onClick={() => {
													if (
														window.confirm(
															t(
																"publishConfirm",
																{
																	version:
																		s.version,
																},
															),
														)
													) {
														publish.mutate({
															projectId,
															snapshotId: s.id,
														});
													}
												}}
											>
												{t("publishAction")}
											</Button>
										) : null}
										{s.status === "READY" ? (
											<Button
												size="sm"
												variant="outline"
												disabled={download.isPending}
												onClick={() =>
													download.mutate({
														projectId,
														snapshotId: s.id,
													})
												}
											>
												{t("downloadAction")}
											</Button>
										) : null}
										{s.status === "REJECTED" ? (
											<Button
												size="sm"
												variant="ghost"
												onClick={() =>
													setExpandedId(
														expandedId === s.id
															? null
															: s.id,
													)
												}
											>
												{t("seeWhyAction")}
											</Button>
										) : null}
										{!isPublished &&
										DELETABLE_STATUSES.has(s.status) ? (
											<Button
												size="sm"
												variant="ghost"
												className="text-destructive"
												disabled={remove.isPending}
												onClick={() => {
													if (
														window.confirm(
															t("deleteConfirm", {
																version:
																	s.version,
															}),
														)
													) {
														remove.mutate({
															projectId,
															snapshotId: s.id,
														});
													}
												}}
											>
												{t("deleteAction")}
											</Button>
										) : null}
									</div>
								</div>
								{expandedId === s.id && s.rejection ? (
									<div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-2 text-xs">
										{rejectionRows.map((r, i) => (
											<div
												key={`${r.path}-${i}`}
												className="flex items-center justify-between gap-2"
											>
												<code>{r.path}</code>
												<span className="text-muted-foreground">
													{r.reason === "secret"
														? r.detail?.startsWith(
																"filename:",
															)
															? tReason(
																	"credentialFile",
																)
															: (secretLabels[
																	r.detail ??
																		""
																] ?? r.detail)
														: (reasonLabels[
																r.reason
															] ?? r.reason)}
												</span>
											</div>
										))}
										{truncatedRow ? (
											<p className="text-muted-foreground">
												{tReason("truncatedSummary", {
													detail:
														truncatedRow.detail ??
														"",
												})}
											</p>
										) : null}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</DialogContent>
		</Dialog>
	);
}
