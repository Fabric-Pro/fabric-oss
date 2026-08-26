"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import { ExternalLinkIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
	RESULT_I18N_KEY,
	RESULT_TONE,
	type TestResult,
	TONE_CLASSES,
} from "../constants";
import {
	PipelineProviderIcon,
	pipelineProviderLabel,
} from "./PipelineProviderIcon";
import { formatAbsoluteTime, formatDuration } from "./pipeline-run";

/** How many per-test rows to render at once — a run can carry thousands. */
const PAGE = 100;

type DetailResult = {
	name: string;
	classname?: string | null;
	rawStatus?: string | null;
	status: TestResult;
	failureMessage?: string | null;
	durationMs?: number | null;
	matchedCaseId?: string | null;
	matchTier?: "tag" | "path" | "title" | null;
	matchedCase: { id: string; identifier: string; title: string } | null;
};

/**
 * The in-Fabric run detail: one CI run with its full per-test breakdown — every
 * test the run reported, matched or not, with the Fabric case it linked to.
 *
 * This is the "portal" destination for a run (the CI provider stays one click
 * away via the external link), so a failing test can be read, traced to its test
 * case, and triaged without leaving Fabric. Rows render incrementally rather
 * than all at once: a monorepo suite reports thousands of tests and mounting
 * them together janks the sheet.
 */
export function PipelineRunDetailSheet({
	projectId,
	runId,
	open,
	onOpenChange,
	onSelectCase,
}: {
	projectId: string;
	runId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Optional: jump to the matched test case (wired where a case view exists). */
	onSelectCase?: (caseId: string) => void;
}) {
	const t = useTranslations("projects.stories.maturation.qa.pipelineRuns");
	const [failuresOnly, setFailuresOnly] = useState(false);
	const [search, setSearch] = useState("");
	const [limit, setLimit] = useState(PAGE);

	const detailQuery = useQuery({
		...orpc.projects.pipelineResults.runDetail.queryOptions({
			input: { projectId, runId: runId ?? "" },
		}),
		enabled: open && Boolean(runId),
	});

	const run = detailQuery.data?.run;
	const results = useMemo(
		() => (detailQuery.data?.results ?? []) as DetailResult[],
		[detailQuery.data],
	);

	// Failures first — the reason anyone opens a run — then the provider's order.
	const ordered = useMemo(() => {
		const rank = (r: DetailResult) =>
			r.status === "FAILED" ? 0 : r.status === "BLOCKED" ? 1 : 2;
		return [...results].sort((a, b) => rank(a) - rank(b));
	}, [results]);

	const filtered = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return ordered.filter((r) => {
			if (failuresOnly && r.status !== "FAILED") {
				return false;
			}
			if (!needle) {
				return true;
			}
			return (
				r.name.toLowerCase().includes(needle) ||
				(r.classname ?? "").toLowerCase().includes(needle)
			);
		});
	}, [ordered, failuresOnly, search]);

	const visible = filtered.slice(0, limit);

	/** True once the run is loaded and the visible header (with its title) renders. */
	const resolved = !detailQuery.isLoading && !detailQuery.isError && !!run;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
			>
				{/*
				 * The visible header below carries the real title, but it only exists
				 * once the run has loaded — and the sheet always opens before that,
				 * so without this the dialog has no accessible name on open, and
				 * none at all if the fetch fails. Screen readers then announce an
				 * unnamed dialog; Radix logs it as an error.
				 */}
				{!resolved && (
					<>
						<SheetTitle className="sr-only">
							{t("detail.srTitle")}
						</SheetTitle>
						<SheetDescription className="sr-only">
							{t("detail.srDescription")}
						</SheetDescription>
					</>
				)}
				{detailQuery.isLoading ? (
					<div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("loading")}
					</div>
				) : detailQuery.isError || !run ? (
					<div className="flex flex-1 items-center justify-center gap-2 p-6 text-destructive text-sm">
						<TriangleAlertIcon
							className="size-4"
							aria-hidden="true"
						/>
						{t("detail.loadError")}
					</div>
				) : (
					<>
						<SheetHeader className="space-y-3 border-b px-5 py-4">
							<div className="flex items-start gap-3">
								<PipelineProviderIcon
									provider={run.provider}
									className="mt-1"
								/>
								<div className="min-w-0 flex-1">
									<SheetTitle className="truncate text-base">
										{run.pipelineName ??
											t("runLabel", {
												id: run.externalRunId,
											})}
									</SheetTitle>
									<SheetDescription className="text-xs">
										{pipelineProviderLabel(run.provider)} ·{" "}
										{t("runLabel", {
											id: run.externalRunId,
										})}
									</SheetDescription>
								</div>
								{run.runUrl && (
									<Button
										variant="outline"
										size="sm"
										asChild
										className="shrink-0 gap-1.5"
									>
										<a
											href={run.runUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											<ExternalLinkIcon
												className="size-3.5"
												aria-hidden="true"
											/>
											{t("detail.openInProvider")}
										</a>
									</Button>
								)}
							</div>

							{/* Result mix — the run's headline numbers. */}
							<div className="flex flex-wrap items-center gap-2">
								<Badge
									variant={
										run.failedCount > 0
											? "error"
											: "success"
									}
								>
									{run.passedCount}/{run.totalCount}{" "}
									{t("passed")}
								</Badge>
								{run.failedCount > 0 && (
									<span className="text-destructive text-xs">
										{t("failedCount", {
											count: run.failedCount,
										})}
									</span>
								)}
								{run.skippedCount > 0 && (
									<span className="text-muted-foreground text-xs">
										{t("detail.skippedCount", {
											count: run.skippedCount,
										})}
									</span>
								)}
								{/* Queued-or-blocked. Before SKIPPED existed this
								    column was never rendered, while skippedCount
								    carried the not-run tally under a "not run"
								    label — the two had swapped places, so this one
								    had no home and the other was mislabelled. */}
								{run.otherCount > 0 && (
									<span className="text-muted-foreground text-xs">
										{t("detail.otherCount", {
											count: run.otherCount,
										})}
									</span>
								)}
							</div>

							<dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
								<Meta label={t("detail.branch")}>
									{run.branch ? (
										<span className="font-mono">
											{run.branch}
										</span>
									) : (
										"—"
									)}
								</Meta>
								<Meta label={t("detail.runBy")}>
									{run.triggeredByActor ?? "—"}
								</Meta>
								<Meta label={t("detail.commit")}>
									{run.commitSha ? (
										<span className="font-mono">
											{run.commitSha.slice(0, 8)}
										</span>
									) : (
										"—"
									)}
								</Meta>
								<Meta label={t("detail.duration")}>
									{formatDuration(run.durationMs) ?? "—"}
								</Meta>
								<Meta label={t("detail.started")}>
									{formatAbsoluteTime(
										run.startedAt ?? run.createdAt,
									) ?? "—"}
								</Meta>
								<Meta label={t("detail.status")}>
									{run.status ?? "—"}
								</Meta>
							</dl>
						</SheetHeader>

						{/* Per-test breakdown */}
						<div className="flex items-center gap-2 border-b px-5 py-2.5">
							<Input
								value={search}
								onChange={(e) => {
									setSearch(e.target.value);
									setLimit(PAGE);
								}}
								placeholder={t("detail.searchTests")}
								// A placeholder is not a label: it disappears the
								// moment text is entered (WCAG 3.3.2), and every
								// other search box in this feature is labelled.
								aria-label={t("detail.searchTests")}
								className="h-8 text-sm"
							/>
							<Button
								type="button"
								size="sm"
								variant={failuresOnly ? "primary" : "outline"}
								// The filter's on/off state was conveyed by colour
								// alone, so a screen reader read "Failures only,
								// button" identically either way.
								aria-pressed={failuresOnly}
								onClick={() => {
									setFailuresOnly((v) => !v);
									setLimit(PAGE);
								}}
								className="shrink-0"
							>
								{t("detail.failuresOnly")}
							</Button>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto">
							{filtered.length === 0 ? (
								<p className="px-5 py-8 text-center text-muted-foreground text-sm">
									{results.length > 0
										? t("detail.noMatches")
										: run.totalCount > 0
											? // The run counted tests, so it did
												// report results — we just have no
												// stored breakdown (ingested before
												// per-test capture). "Reported no
												// results" here would contradict the
												// tally rendered right above it.
												t("detail.breakdownUnavailable")
											: t("detail.noResults")}
								</p>
							) : (
								<>
									<ul className="divide-y divide-border">
										{visible.map((r, i) => (
											<TestResultRow
												key={`${r.classname ?? ""}::${r.name}::${i}`}
												result={r}
												onSelectCase={onSelectCase}
											/>
										))}
									</ul>
									{/* Never silently truncate — say what's hidden. */}
									{visible.length < filtered.length && (
										<div className="px-5 py-4 text-center">
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() =>
													setLimit((l) => l + PAGE)
												}
											>
												{t("detail.showMore", {
													shown: visible.length,
													total: filtered.length,
												})}
											</Button>
										</div>
									)}
								</>
							)}
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

function Meta({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex gap-1.5">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 truncate text-foreground">{children}</dd>
		</div>
	);
}

/** One automated test's outcome, with its Fabric case when the cascade matched. */
function TestResultRow({
	result,
	onSelectCase,
}: {
	result: DetailResult;
	onSelectCase?: (caseId: string) => void;
}) {
	const t = useTranslations("projects.stories.maturation.qa.pipelineRuns");
	const tone = TONE_CLASSES[RESULT_TONE[result.status]];
	const duration = formatDuration(result.durationMs);
	// Bound to a const so the null check narrows inside the click handler too —
	// a property access wouldn't, and the closure would need a non-null assertion.
	const matchedCase = result.matchedCase;

	return (
		<li className="px-5 py-3">
			<div className="flex items-start gap-2.5">
				<span
					aria-hidden="true"
					className={cn(
						"mt-1.5 size-1.5 shrink-0 rounded-full",
						tone.dot,
					)}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2">
						<span className="break-words font-medium text-sm">
							{result.name}
						</span>
						<span className={cn("text-[11px]", tone.text)}>
							{/* RESULT_I18N_KEY already carries its `result.` prefix. */}
							{t(`detail.${RESULT_I18N_KEY[result.status]}`)}
						</span>
						{result.rawStatus &&
							result.rawStatus.toUpperCase() !==
								result.status && (
								<span
									className="font-mono text-[10px] text-muted-foreground"
									title="Provider-native status"
								>
									{result.rawStatus}
								</span>
							)}
					</div>
					{result.classname && (
						<p className="truncate font-mono text-[11px] text-muted-foreground">
							{result.classname}
						</p>
					)}
					{result.failureMessage && (
						<pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
							{result.failureMessage}
						</pre>
					)}
					<div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
						{duration && <span>{duration}</span>}
						{matchedCase ? (
							onSelectCase ? (
								<button
									type="button"
									onClick={() => onSelectCase(matchedCase.id)}
									className="rounded font-mono text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									{matchedCase.identifier}
								</button>
							) : (
								<span className="font-mono text-primary">
									{matchedCase.identifier}
								</span>
							)
						) : (
							<span className="italic">
								{t("detail.unlinked")}
							</span>
						)}
					</div>
				</div>
			</div>
		</li>
	);
}
