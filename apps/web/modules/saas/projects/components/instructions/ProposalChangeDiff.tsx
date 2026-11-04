"use client";

import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { diffLines } from "diff";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useMemo } from "react";
import {
	isMarkdownPath,
	splitFrontmatter,
	toDiffRows,
} from "./lib/instruction-diff";
import { useProposalDiffMode } from "./lib/use-proposal-diff-mode";

const RenderedMarkdownDiff = lazy(() => import("./RenderedMarkdownDiff"));

/**
 * One diffable change in the proposal review: both sides present in full
 * (not binary, not omitted, not truncated). A Markdown file is shown
 * rendered by default, with the raw line diff behind a toggle whose choice
 * the browser remembers; every other file is the line diff.
 *
 * Whether the text changed at all is decided on the RAW sides, before any
 * rendering: a change the renderer would draw identically (whitespace, a
 * frontmatter key) is still a change.
 */
export function ProposalChangeView({
	path,
	before,
	after,
}: {
	path: string;
	before: string | null;
	after: string | null;
}) {
	const t = useTranslations("projects.codingInstructions.proposalReview");
	const { mode, setMode } = useProposalDiffMode();
	const oneSided = before === null || after === null;
	if (oneSided && (before ?? "") === "" && (after ?? "") === "") {
		return (
			<p className="text-muted-foreground text-sm">{t("emptyFile")}</p>
		);
	}
	if (!oneSided && before === after) {
		return (
			<p className="text-muted-foreground text-sm">
				{t("noTextualChanges")}
			</p>
		);
	}
	if (!isMarkdownPath(path)) {
		return <ProposalChangeDiff before={before} after={after} />;
	}
	return (
		<div className="flex flex-col gap-2">
			<fieldset
				aria-label={t("diffModeLabel")}
				className="flex gap-1 self-start"
			>
				<Button
					type="button"
					size="sm"
					variant={mode === "rendered" ? "secondary" : "ghost"}
					aria-pressed={mode === "rendered"}
					onClick={() => setMode("rendered")}
				>
					{t("diffModeRendered")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant={mode === "raw" ? "secondary" : "ghost"}
					aria-pressed={mode === "raw"}
					onClick={() => setMode("raw")}
				>
					{t("diffModeRaw")}
				</Button>
			</fieldset>
			{mode === "raw" ? (
				<ProposalChangeDiff before={before} after={after} />
			) : (
				<RenderedChange path={path} before={before} after={after} />
			)}
		</div>
	);
}

function RenderedChange({
	path,
	before,
	after,
}: {
	path: string;
	before: string | null;
	after: string | null;
}) {
	const t = useTranslations("projects.codingInstructions.proposalReview");
	const beforeParts = splitFrontmatter(before ?? "");
	const afterParts = splitFrontmatter(after ?? "");
	const frontmatterChanged =
		beforeParts.frontmatter !== afterParts.frontmatter;
	return (
		<>
			{frontmatterChanged ? (
				<p className="text-muted-foreground text-xs">
					{t("frontmatterChanged")}
				</p>
			) : null}
			{beforeParts.body === afterParts.body ? null : (
				<Suspense fallback={<Skeleton className="h-24 w-full" />}>
					<RenderedMarkdownDiff
						before={beforeParts.body}
						after={afterParts.body}
						label={t("renderedDiffLabel", { path })}
					/>
				</Suspense>
			)}
		</>
	);
}

/**
 * A validated proposal edit as a single unified line diff.
 *
 * "No textual changes" means two PRESENT sides with equal text, and nothing
 * else. `before`/`after` are `string | null` (`buildProposalChanges`), and a
 * side that is `null` is absent; a side that is `""` is a real, empty file.
 * `ProposalChangeView` makes that decision before this renders.
 *
 * Both bodies are already in hand — `buildProposalChanges` sends them inline
 * — so nothing is fetched here.
 */
function ProposalChangeDiff({
	before,
	after,
}: {
	before: string | null;
	after: string | null;
}) {
	const rows = useMemo(
		() => toDiffRows(diffLines(before ?? "", after ?? "")),
		[before, after],
	);
	return (
		<pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
			{rows.map((row, index) => (
				<span
					key={`${index}-${row.text.length}`}
					className={cn(
						row.added &&
							"bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
						row.removed &&
							"bg-red-500/15 text-red-800 dark:text-red-300",
					)}
				>
					{row.text}
				</span>
			))}
		</pre>
	);
}
