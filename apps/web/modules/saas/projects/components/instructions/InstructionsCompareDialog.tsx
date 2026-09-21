"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Skeleton } from "@ui/components/skeleton";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { InstructionFileDiff } from "./InstructionFileDiff";

type ComparedFile = {
	path: string;
	kind: string;
	isText: boolean;
	size: number;
};
type ChangedFile = {
	path: string;
	kind: string;
	isText: boolean;
	fromSize: number;
	toSize: number;
};
type Comparison = {
	from: { id: string; version: number };
	to: { id: string; version: number };
	added: ComparedFile[];
	removed: ComparedFile[];
	changed: ChangedFile[];
	unchangedCount: number;
};

/**
 * What changed between two of a project's coding-instruction versions.
 *
 * Read-only by construction: it offers no publish, no rollback and no
 * proposal decision, so the same dialog is safe to open from History (where
 * the viewer may not be allowed to mutate anything) and from the published
 * summary line.
 *
 * The manifest arrives in one `compare` call with no bytes in it. A body is
 * fetched only for a changed row somebody expands, by `InstructionFileDiff`;
 * added and removed rows list their path and never fetch at all, because
 * "this whole file is new" is not a diff anyone reads line by line here — the
 * file reader in the tab shows it in full.
 */
/**
 * The three groups, owning which rows are expanded.
 *
 * Mounted under a key of the snapshot PAIR, so a changed pair remounts it
 * from scratch. Expansion was keyed by path alone, and this dialog can stay
 * mounted across a pair change — the published view holds it open while the
 * tab polls, and the published pointer can move underneath it. The same path
 * in the new pair would then have arrived already expanded, silently fetching
 * two bodies nobody asked for, and a SCRIPT row would have kept the "Show
 * diff" consent someone gave for a different pair of versions.
 */
function ComparisonGroups({
	projectId,
	comparison,
}: {
	projectId: string;
	comparison: Comparison;
}) {
	const t = useTranslations("projects.codingInstructions.compare");
	const kindLabels = useTranslations(
		"projects.codingInstructions.fileView",
	).raw("kindLabels") as Record<string, string>;
	const [expanded, setExpanded] = useState<string[]>([]);

	function toggle(path: string) {
		setExpanded((current) =>
			current.includes(path)
				? current.filter((p) => p !== path)
				: [...current, path],
		);
	}

	function group(
		title: string,
		rows: Array<ComparedFile | ChangedFile>,
		expandable: boolean,
	) {
		if (rows.length === 0) {
			return null;
		}
		return (
			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-sm">
					{title} ({rows.length})
				</h3>
				<div className="flex flex-col gap-1">
					{rows.map((row) => {
						const isOpen = expanded.includes(row.path);
						return (
							<div
								key={row.path}
								className="rounded-md border border-border p-2"
							>
								{expandable ? (
									<button
										type="button"
										aria-expanded={isOpen}
										className="flex w-full min-w-0 items-center gap-2 text-left"
										onClick={() => toggle(row.path)}
									>
										{isOpen ? (
											<ChevronDownIcon
												className="size-3.5 shrink-0"
												aria-hidden="true"
											/>
										) : (
											<ChevronRightIcon
												className="size-3.5 shrink-0"
												aria-hidden="true"
											/>
										)}
										<Badge variant="secondary">
											{kindLabels[row.kind] ??
												kindLabels.OTHER}
										</Badge>
										<code className="min-w-0 truncate text-xs">
											{row.path}
										</code>
									</button>
								) : (
									<div className="flex min-w-0 items-center gap-2">
										<Badge variant="secondary">
											{kindLabels[row.kind] ??
												kindLabels.OTHER}
										</Badge>
										<code className="min-w-0 truncate text-xs">
											{row.path}
										</code>
									</div>
								)}
								{expandable && isOpen ? (
									<div className="mt-2">
										<InstructionFileDiff
											// The pair is part of the identity
											// here too: the body reader holds
											// its own "Show diff" consent, and
											// that consent belongs to one pair
											// of versions.
											key={`${comparison.from.id}\0${comparison.to.id}\0${row.path}`}
											projectId={projectId}
											fromSnapshotId={comparison.from.id}
											toSnapshotId={comparison.to.id}
											path={row.path}
											kind={row.kind}
											isText={row.isText}
										/>
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</section>
		);
	}

	return (
		<>
			{group(t("addedGroup"), comparison.added, false)}
			{group(t("removedGroup"), comparison.removed, false)}
			{group(t("changedGroup"), comparison.changed, true)}
		</>
	);
}

export function InstructionsCompareDialog({
	projectId,
	fromSnapshotId,
	toSnapshotId,
	publishedSide,
	open,
	onOpenChange,
}: {
	projectId: string;
	fromSnapshotId: string;
	toSnapshotId: string;
	/** Which side currently holds the published pointer, when either does. */
	publishedSide?: "from" | "to";
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useTranslations("projects.codingInstructions.compare");
	const comparison = useQuery({
		...orpc.projects.instructions.compare.queryOptions({
			input: { projectId, fromSnapshotId, toSnapshotId },
		}),
		enabled: open,
		retry: false,
	});
	const data = comparison.data as Comparison | undefined;
	const subtitleKey =
		publishedSide === "from"
			? "subtitleFromPublished"
			: publishedSide === "to"
				? "subtitleToPublished"
				: "subtitle";

	const nothingChanged =
		data !== undefined &&
		data.added.length === 0 &&
		data.removed.length === 0 &&
		data.changed.length === 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>
						{data
							? t(subtitleKey, {
									from: data.from.version,
									to: data.to.version,
								})
							: t("subtitlePending")}
					</DialogDescription>
				</DialogHeader>
				{comparison.isLoading ? (
					<Skeleton className="h-32 w-full" />
				) : null}
				{comparison.isError ? (
					<p role="alert" className="text-destructive text-sm">
						{t("loadError")}
					</p>
				) : null}
				{data ? (
					<div className="flex min-h-0 flex-col gap-4 overflow-auto">
						<p className="text-muted-foreground text-sm">
							{t("summary", {
								added: data.added.length,
								removed: data.removed.length,
								changed: data.changed.length,
								unchanged: data.unchangedCount,
							})}
						</p>
						{nothingChanged ? (
							<p className="text-muted-foreground text-sm">
								{t("noDifferences")}
							</p>
						) : null}
						<ComparisonGroups
							// Remount on a pair change: expansion and the
							// per-file "Show diff" consent are both about ONE
							// pair of versions.
							key={`${fromSnapshotId}\0${toSnapshotId}`}
							projectId={projectId}
							comparison={data}
						/>
					</div>
				) : null}
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{t("closeButton")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
