"use client";

import { shortCommit } from "@saas/projects/lib/instructions-repository-sync";
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
import { type ReactNode, useState } from "react";
import { InstructionCommitFileDiff } from "./InstructionCommitFileDiff";
import { InstructionFileDiff } from "./InstructionFileDiff";

/** What a row of either comparison needs: where it is, what it is, whether it has text. */
type ComparedRow = {
	path: string;
	kind: string;
	isText: boolean;
};
type Comparison = {
	from: { id: string; version: number };
	to: { id: string; version: number };
	added: ComparedRow[];
	removed: ComparedRow[];
	changed: ComparedRow[];
	unchangedCount: number;
};
type CommitComparison = {
	from: { sha: string };
	to: { sha: string };
	added: ComparedRow[];
	removed: ComparedRow[];
	changed: ComparedRow[];
	/** The provider capped its own list, so more may have changed than is named. */
	truncated: boolean;
};

/**
 * The three groups, owning which rows are expanded.
 *
 * Mounted under a key of the PAIR being compared, so a changed pair remounts it
 * from scratch. Expansion was keyed by path alone, and this dialog can stay
 * mounted across a pair change — the published view holds it open while the
 * tab polls, and the published pointer can move underneath it. The same path
 * in the new pair would then have arrived already expanded, silently fetching
 * two bodies nobody asked for, and a SCRIPT row would have kept the "Show
 * diff" consent someone gave for a different pair.
 *
 * What an expanded changed row draws is the caller's: two versions read through
 * `getFile`, or two commits through `readCommitFile`.
 */
function ComparisonGroups({
	added,
	removed,
	changed,
	renderDiff,
}: {
	added: ComparedRow[];
	removed: ComparedRow[];
	changed: ComparedRow[];
	renderDiff: (row: ComparedRow) => ReactNode;
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

	function group(title: string, rows: ComparedRow[], expandable: boolean) {
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
										{renderDiff(row)}
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
			{group(t("addedGroup"), added, false)}
			{group(t("removedGroup"), removed, false)}
			{group(t("changedGroup"), changed, true)}
		</>
	);
}

/** A comparison's body, below its title: what is loading, what failed, what changed. */
function ComparisonBody({
	loading,
	failed,
	failureKey,
	summary,
	notice,
	nothingChanged,
	groups,
}: {
	loading: boolean;
	failed: boolean;
	failureKey: "loadError" | "loadErrorCommits";
	summary: string | null;
	notice?: string | null;
	nothingChanged: boolean;
	groups: ReactNode;
}) {
	const t = useTranslations("projects.codingInstructions.compare");
	return (
		<>
			{loading ? <Skeleton className="h-32 w-full" /> : null}
			{failed ? (
				<p role="alert" className="text-destructive text-sm">
					{t(failureKey)}
				</p>
			) : null}
			{summary !== null ? (
				<div className="flex min-h-0 flex-col gap-4 overflow-auto">
					<p className="text-muted-foreground text-sm">{summary}</p>
					{notice ? (
						<p className="text-muted-foreground text-sm">
							{notice}
						</p>
					) : null}
					{nothingChanged ? (
						<p className="text-muted-foreground text-sm">
							{t("noDifferences")}
						</p>
					) : null}
					{groups}
				</div>
			) : null}
		</>
	);
}

/** Two of a project's coding-instruction versions: a manifest, with bodies read per expanded row. */
function SnapshotComparison({
	projectId,
	fromSnapshotId,
	toSnapshotId,
	publishedSide,
	open,
}: {
	projectId: string;
	fromSnapshotId: string;
	toSnapshotId: string;
	publishedSide?: "from" | "to";
	open: boolean;
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
	return (
		<>
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
			<ComparisonBody
				loading={comparison.isLoading}
				failed={comparison.isError}
				failureKey="loadError"
				summary={
					data
						? t("summary", {
								added: data.added.length,
								removed: data.removed.length,
								changed: data.changed.length,
								unchanged: data.unchangedCount,
							})
						: null
				}
				nothingChanged={
					data !== undefined &&
					data.added.length === 0 &&
					data.removed.length === 0 &&
					data.changed.length === 0
				}
				groups={
					data ? (
						<ComparisonGroups
							// Remount on a pair change: expansion and the per-file
							// "Show diff" consent are both about ONE pair.
							key={`${fromSnapshotId}\0${toSnapshotId}`}
							added={data.added}
							removed={data.removed}
							changed={data.changed}
							renderDiff={(row) => (
								<InstructionFileDiff
									// The pair is part of the identity here too:
									// the body reader holds its own "Show diff"
									// consent, and that consent belongs to one
									// pair of versions.
									key={`${data.from.id}\0${data.to.id}\0${row.path}`}
									projectId={projectId}
									fromSnapshotId={data.from.id}
									toSnapshotId={data.to.id}
									path={row.path}
									kind={row.kind}
									isText={row.isText}
								/>
							)}
						/>
					) : null
				}
			/>
		</>
	);
}

/**
 * Two commits of the synced branch (Fizzy #2878 §10): what changed between
 * them within the synced folder, a commit's own diff being that commit against
 * its parent. Names only, as a snapshot comparison does; a body is read per
 * expanded row, through `readCommitFile`.
 */
function CommitComparisonContent({
	projectId,
	fromSha,
	toSha,
	open,
	includeHeader,
}: {
	projectId: string;
	fromSha: string;
	toSha: string;
	open: boolean;
	includeHeader: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.compare");
	const comparison = useQuery({
		...orpc.projects.instructions.repositorySync.compareCommits.queryOptions(
			{
				input: { projectId, from: fromSha, to: toSha },
			},
		),
		enabled: open,
		retry: false,
	});
	const data = comparison.data as CommitComparison | undefined;
	return (
		<>
			{includeHeader ? (
				<DialogHeader>
					<DialogTitle>{t("titleCommits")}</DialogTitle>
					<DialogDescription>
						{data
							? t("subtitleCommits", {
									from: shortCommit(data.from.sha) ?? "",
									to: shortCommit(data.to.sha) ?? "",
								})
							: t("subtitlePending")}
					</DialogDescription>
				</DialogHeader>
			) : null}
			<ComparisonBody
				loading={comparison.isLoading}
				failed={comparison.isError}
				failureKey="loadErrorCommits"
				summary={
					data
						? t("summaryCommits", {
								added: data.added.length,
								removed: data.removed.length,
								changed: data.changed.length,
							})
						: null
				}
				notice={data?.truncated ? t("commitsTruncated") : null}
				nothingChanged={
					data !== undefined &&
					!data.truncated &&
					data.added.length === 0 &&
					data.removed.length === 0 &&
					data.changed.length === 0
				}
				groups={
					data ? (
						<ComparisonGroups
							key={`${fromSha}\0${toSha}`}
							added={data.added}
							removed={data.removed}
							changed={data.changed}
							renderDiff={(row) => (
								<InstructionCommitFileDiff
									key={`${fromSha}\0${toSha}\0${row.path}`}
									projectId={projectId}
									fromSha={fromSha}
									toSha={toSha}
									path={row.path}
									kind={row.kind}
									isText={row.isText}
								/>
							)}
						/>
					) : null
				}
			/>
		</>
	);
}

/**
 * The selected commit's comparison body, embedded where the history already
 * names that commit. File bodies stay lazy: only an expanded changed file reads
 * its two commit sides through the existing guarded reader.
 */
export function InstructionCommitComparison({
	projectId,
	fromSha,
	toSha,
	open,
}: {
	projectId: string;
	fromSha: string;
	toSha: string;
	open: boolean;
}) {
	return (
		<CommitComparisonContent
			projectId={projectId}
			fromSha={fromSha}
			toSha={toSha}
			open={open}
			includeHeader={false}
		/>
	);
}

type CompareDialogProps = {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
} & (
	| {
			fromSnapshotId: string;
			toSnapshotId: string;
			/** Which side currently holds the published pointer, when either does. */
			publishedSide?: "from" | "to";
			commits?: undefined;
	  }
	| {
			/** Two commits of the synced branch, as full object ids. */
			commits: { from: string; to: string };
			fromSnapshotId?: undefined;
			toSnapshotId?: undefined;
			publishedSide?: undefined;
	  }
);

/**
 * What changed between two of a project's coding-instruction versions, or, on
 * a repository-backed project, between two commits of its branch.
 *
 * Read-only by construction: it offers no publish, no rollback and no
 * proposal decision, so the same dialog is safe to open from History (where
 * the viewer may not be allowed to mutate anything) and from the published
 * summary line.
 *
 * The manifest arrives in one call with no bytes in it. A body is fetched only
 * for a changed row somebody expands; added and removed rows list their path
 * and never fetch at all, because "this whole file is new" is not a diff
 * anyone reads line by line here — the file reader in the tab shows it in full.
 */
export function InstructionsCompareDialog(props: CompareDialogProps) {
	const t = useTranslations("projects.codingInstructions.compare");
	const { projectId, open, onOpenChange } = props;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
				{props.commits ? (
					<CommitComparisonContent
						projectId={projectId}
						fromSha={props.commits.from}
						toSha={props.commits.to}
						open={open}
						includeHeader
					/>
				) : (
					<SnapshotComparison
						projectId={projectId}
						fromSnapshotId={props.fromSnapshotId}
						toSnapshotId={props.toSnapshotId}
						publishedSide={props.publishedSide}
						open={open}
					/>
				)}
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
