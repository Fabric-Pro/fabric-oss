"use client";

import { validateDatabricksWorkspaceOrigin } from "@repo/databricks/workspace-origin";
import { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import {
	DownloadIcon,
	ExternalLinkIcon,
	Loader2Icon,
	RefreshCwIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { triggerBlobDownload } from "../lib/markdown-to-document";

type Run = Awaited<
	ReturnType<typeof orpcClient.contextQuality.runs.get>
>["run"];
type Comparison = Awaited<
	ReturnType<typeof orpcClient.contextQuality.runs.compare>
>;

const active = new Set([
	"QUEUED",
	"EXPORTING",
	"DISPATCHING",
	"RUNNING",
	"CANCEL_REQUESTED",
]);

function remoteLink(value: string | null): string | null {
	if (!value) {
		return null;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) {
			return null;
		}
		validateDatabricksWorkspaceOrigin(url.origin);
		return url.href;
	} catch {
		return null;
	}
}

interface Props {
	projectId: string;
	organizationId: string;
	canCancel: boolean;
	seedRunId?: string;
}

/** Key state to the tenant, including when this component is used on its own. */
export function SavedContextQualityRuns(props: Props) {
	return (
		<SavedRuns
			key={JSON.stringify([props.projectId, props.organizationId])}
			{...props}
		/>
	);
}

function SavedRuns({ projectId, organizationId, canCancel, seedRunId }: Props) {
	const t = useTranslations("projects.contexts.quality");
	const format = useFormatter();
	const id = useId();
	const generation = useRef(0);
	const comparisonGeneration = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [runs, setRuns] = useState<Run[]>([]);
	const [selectedId, setSelectedId] = useState(seedRunId ?? "");
	const [selected, setSelected] = useState<Run | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [operationError, setOperationError] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [cursor, setCursor] = useState<string | undefined>();
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState(false);
	const [baselineId, setBaselineId] = useState("");
	const [candidateId, setCandidateId] = useState("");
	const [comparison, setComparison] = useState<Comparison | null>(null);
	const [comparing, setComparing] = useState(false);

	useEffect(() => {
		const request = ++generation.current;
		setLoading(true);
		setError(false);
		async function load() {
			try {
				const [page, detail] = await Promise.all([
					orpcClient.contextQuality.runs.list({
						projectId,
						organizationId,
						limit: 20,
						cursor,
					}),
					selectedId
						? orpcClient.contextQuality.runs
								.get({
									projectId,
									organizationId,
									runId: selectedId,
								})
								.then(
									(response) => ({
										run: response.run,
										failed: false,
									}),
									() => ({ run: null, failed: true }),
								)
						: Promise.resolve({ run: null, failed: false }),
				]);
				if (request !== generation.current) {
					return;
				}
				setRuns(page.runs);
				setSelected(detail.run);
				setNextCursor(page.nextCursor);
				setError(detail.failed);
				// A new authorization check invalidates any old comparison evidence.
				comparisonGeneration.current += 1;
				setComparison(null);
				setComparing(false);
				if (
					!detail.failed &&
					(page.runs.some((run) => active.has(run.status)) ||
						(detail.run && active.has(detail.run.status)))
				) {
					timer.current = setTimeout(() => void load(), 2500);
				}
			} catch {
				if (request === generation.current) {
					setError(true);
					setSelected(null);
					setRuns([]);
					setNextCursor(null);
					comparisonGeneration.current += 1;
					setComparison(null);
					setComparing(false);
				}
			} finally {
				if (request === generation.current) {
					setLoading(false);
				}
			}
		}
		void load();
		return () => {
			generation.current += 1;
			comparisonGeneration.current += 1;
			clearTimeout(timer.current);
		};
	}, [projectId, organizationId, selectedId, refresh, cursor]);

	function clearComparison() {
		comparisonGeneration.current += 1;
		setComparison(null);
		setComparing(false);
	}

	async function cancel() {
		if (
			!selected ||
			!canCancel ||
			cancelling ||
			selected.status === "CANCEL_REQUESTED" ||
			(!active.has(selected.status) &&
				selected.status !== "RECONCILIATION_REQUIRED")
		) {
			return;
		}
		// Invalidate reads already in flight before the write. An old RUNNING
		// response must not overwrite a newer cancellation acknowledgement.
		const request = ++generation.current;
		clearTimeout(timer.current);
		clearComparison();
		setCancelling(true);
		setOperationError(false);
		try {
			const response = await orpcClient.contextQuality.runs.cancel({
				projectId,
				organizationId,
				runId: selected.id,
			});
			if (request === generation.current) {
				setSelected(response.run);
				setRuns((current) =>
					current.map((run) =>
						run.id === response.run.id ? response.run : run,
					),
				);
			}
		} catch {
			if (request === generation.current) {
				setOperationError(true);
			}
		} finally {
			if (request === generation.current) {
				setCancelling(false);
				setRefresh((value) => value + 1);
			}
		}
	}

	async function compare() {
		if (
			!baselineId ||
			!candidateId ||
			baselineId === candidateId ||
			comparing ||
			![baselineId, candidateId].every((runId) =>
				runs.some(
					(run) =>
						run.id === runId && run.evidenceAvailable && run.report,
				),
			)
		) {
			return;
		}
		const request = generation.current;
		const comparisonRequest = ++comparisonGeneration.current;
		setComparing(true);
		setComparison(null);
		setOperationError(false);
		try {
			const response = await orpcClient.contextQuality.runs.compare({
				projectId,
				organizationId,
				baselineId,
				candidateId,
			});
			if (
				request === generation.current &&
				comparisonRequest === comparisonGeneration.current
			) {
				setComparison(response);
			}
		} catch {
			if (
				request === generation.current &&
				comparisonRequest === comparisonGeneration.current
			) {
				setOperationError(true);
			}
		} finally {
			if (
				request === generation.current &&
				comparisonRequest === comparisonGeneration.current
			) {
				setComparing(false);
			}
		}
	}

	function changePage(next: string | undefined) {
		generation.current += 1;
		clearTimeout(timer.current);
		clearComparison();
		setOperationError(false);
		setCursor(next);
		setSelectedId("");
		setSelected(null);
		setBaselineId("");
		setCandidateId("");
	}

	function outcome(run: Run) {
		return (
			<Badge
				variant={
					run.status === "SUCCEEDED"
						? "success"
						: run.status === "FAILED"
							? "error"
							: "outline"
				}
			>
				{t(`saved.statuses.${run.status}`)}
			</Badge>
		);
	}

	const comparable = runs.filter(
		(run) => run.evidenceAvailable && run.report,
	);
	const comparisonEvidence =
		comparison?.baseline.evidenceAvailable &&
		comparison.candidate.evidenceAvailable &&
		comparison.baseline.report &&
		comparison.candidate.report;

	return (
		<section className="min-w-0 space-y-4" aria-label={t("saved.title")}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm text-muted-foreground">
					{t("saved.historyNotice")}
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={loading || cancelling}
					onClick={() => {
						clearComparison();
						setOperationError(false);
						setSelected(null);
						setCursor(undefined);
						setBaselineId("");
						setCandidateId("");
						setRefresh((value) => value + 1);
					}}
				>
					<RefreshCwIcon className="mr-2 size-4" aria-hidden="true" />
					{t("saved.refresh")}
				</Button>
			</div>
			{(error || operationError) && (
				<Alert variant="error">
					<AlertDescription>{t("saved.error")}</AlertDescription>
				</Alert>
			)}
			{loading && (
				<p className="flex items-center gap-2 text-sm" role="status">
					<Loader2Icon
						className="size-4 animate-spin"
						aria-hidden="true"
					/>
					{t("saved.loading")}
				</p>
			)}
			{!loading && runs.length === 0 && !selected && !error && (
				<p className="py-6 text-sm text-muted-foreground">
					{t("saved.empty")}
				</p>
			)}
			{runs.length > 0 && (
				<Table className="min-w-[36rem]">
					<TableHeader>
						<TableRow>
							<TableHead>{t("saved.name")}</TableHead>
							<TableHead>{t("saved.execution")}</TableHead>
							<TableHead>{t("saved.created")}</TableHead>
							<TableHead>
								<span className="sr-only">
									{t("saved.open")}
								</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{runs.map((run) => (
							<TableRow
								key={run.id}
								data-state={
									run.id === selectedId
										? "selected"
										: undefined
								}
							>
								<TableCell className="max-w-56 break-words">
									{run.name}
								</TableCell>
								<TableCell>{outcome(run)}</TableCell>
								<TableCell className="whitespace-nowrap">
									{format.dateTime(new Date(run.createdAt), {
										dateStyle: "medium",
										timeStyle: "short",
									})}
								</TableCell>
								<TableCell>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={cancelling}
										onClick={() => {
											if (selectedId !== run.id) {
												generation.current += 1;
												clearTimeout(timer.current);
												clearComparison();
												setOperationError(false);
												setSelectedId(run.id);
												setSelected(null);
												setCancelling(false);
											}
										}}
										aria-label={t("saved.openNamed", {
											name: run.name,
										})}
									>
										{t("saved.open")}
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			{(cursor || nextCursor) && (
				<div className="flex flex-wrap justify-between gap-2">
					{cursor && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={loading || cancelling}
							onClick={() => changePage(undefined)}
						>
							{t("saved.firstPage")}
						</Button>
					)}
					{nextCursor && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={loading || cancelling}
							onClick={() => changePage(nextCursor)}
						>
							{t("saved.older")}
						</Button>
					)}
				</div>
			)}
			{selected && (
				<section
					className="space-y-3 border-t border-border pt-4"
					aria-label={t("saved.details")}
				>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h3 className="min-w-0 break-words text-base font-semibold">
							{selected.name}
						</h3>
						{outcome(selected)}
					</div>
					{selected.status === "CANCEL_REQUESTED" && (
						<p
							className="text-sm text-muted-foreground"
							role="status"
						>
							{t("saved.cancellationPending")}
						</p>
					)}
					{selected.status === "CANCELLED" && (
						<p
							className="text-sm text-muted-foreground"
							role="status"
						>
							{t("saved.cancellationConfirmed")}
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						{t("saved.cleanup", {
							status: t(
								`saved.cleanupStatuses.${selected.cleanupStatus}`,
							),
						})}
					</p>
					{!selected.evidenceAvailable && (
						<p className="text-sm text-muted-foreground">
							{t("saved.evidenceUnavailable")}
						</p>
					)}
					{selected.errorCode && (
						<Alert variant="error">
							<AlertDescription>
								{t("saved.executionFailed")}
							</AlertDescription>
						</Alert>
					)}
					{selected.evidenceAvailable && selected.report && (
						<>
							<Badge
								variant={
									selected.report.status === "passed"
										? "success"
										: "error"
								}
							>
								{t(
									selected.report.status === "passed"
										? "passed"
										: "failed",
								)}
							</Badge>
							<p className="text-sm">
								{t("saved.counts", {
									passed: selected.report.counts.passed,
									total: selected.report.counts.cases,
								})}
							</p>
							<p className="text-xs text-muted-foreground">
								{t("resultHelp")}
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									try {
										triggerBlobDownload(
											new Blob(
												[
													JSON.stringify(
														selected.report,
														null,
														2,
													),
												],
												{ type: "application/json" },
											),
											"context-quality-report.json",
										);
									} catch {
										setOperationError(true);
									}
								}}
							>
								<DownloadIcon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
								{t("download")}
							</Button>
							<details>
								<summary className="cursor-pointer text-sm">
									{t("reportDetails")}
								</summary>
								<p className="mt-2 break-all text-xs">
									{selected.report.scorerVersion}
								</p>
								<code className="mt-1 block break-all text-xs">
									{selected.report.snapshotHash}
								</code>
								<ul className="mt-2 divide-y divide-border">
									{selected.report.cases.flatMap((entry) =>
										entry.checks.map((check) => (
											<li
												key={`${entry.id}-${check.id}`}
												className="flex items-center justify-between gap-3 py-2 text-sm"
											>
												<span>
													{entry.id} ·{" "}
													{t(`checks.${check.id}`)}
												</span>
												<span>
													{t(
														check.status ===
															"passed"
															? "checkPassed"
															: "checkFailed",
													)}
												</span>
											</li>
										)),
									)}
								</ul>
							</details>
						</>
					)}
					<div className="flex flex-wrap gap-2">
						{selected.evidenceAvailable &&
							(
								[
									["remoteRunUrl", "saved.remoteRun"],
									["mlflowRunUrl", "saved.mlflowRun"],
								] as const
							).map(([field, label]) => {
								const href = remoteLink(selected[field]);
								return href ? (
									<Button
										key={field}
										asChild
										variant="outline"
										size="sm"
									>
										<a
											href={href}
											target="_blank"
											rel="noopener noreferrer"
										>
											{t(label)}
											<ExternalLinkIcon
												className="ml-2 size-3"
												aria-hidden="true"
											/>
										</a>
									</Button>
								) : null;
							})}
						{canCancel &&
							selected.status !== "CANCEL_REQUESTED" &&
							(active.has(selected.status) ||
								selected.status ===
									"RECONCILIATION_REQUIRED") && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={cancel}
									disabled={cancelling}
									aria-busy={cancelling}
								>
									{t(
										cancelling
											? "saved.cancelling"
											: "saved.cancel",
									)}
								</Button>
							)}
					</div>
				</section>
			)}
			{comparable.length > 1 && (
				<section
					className="space-y-3 border-t border-border pt-4"
					aria-label={t("saved.compare")}
				>
					<div className="grid gap-3 sm:grid-cols-2">
						{(
							[
								["baseline", baselineId, setBaselineId],
								["candidate", candidateId, setCandidateId],
							] as const
						).map(([label, value, setValue]) => (
							<div key={label} className="space-y-2">
								<Label htmlFor={`${id}-${label}`}>
									{t(`saved.${label}`)}
								</Label>
								<Select
									value={value}
									onValueChange={(value) => {
										clearComparison();
										setValue(value);
									}}
								>
									<SelectTrigger id={`${id}-${label}`}>
										<SelectValue
											placeholder={t("saved.chooseRun")}
										/>
									</SelectTrigger>
									<SelectContent>
										{comparable.map((run) => (
											<SelectItem
												key={run.id}
												value={run.id}
											>
												{run.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						))}
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={compare}
						disabled={
							!baselineId ||
							!candidateId ||
							baselineId === candidateId ||
							comparing ||
							cancelling ||
							![baselineId, candidateId].every((runId) =>
								comparable.some((run) => run.id === runId),
							)
						}
					>
						{t(comparing ? "saved.comparing" : "saved.compare")}
					</Button>
					{comparison && (
						<div className="space-y-2 text-sm" role="status">
							<p>
								{!comparisonEvidence
									? t("saved.evidenceUnavailable")
									: comparison.compatible &&
											comparison.passedDelta !== null
										? t("saved.comparison", {
												delta: comparison.passedDelta,
											})
										: t("saved.incompatible")}
							</p>
							{comparisonEvidence && !comparison.compatible && (
								<ul>
									{(
										[
											"dataset",
											"configuration",
											"scorer",
										] as const
									)
										.filter(
											(field) =>
												comparison.differences[field],
										)
										.map((field) => (
											<li key={field}>
												{t(
													`saved.differences.${field}`,
												)}
											</li>
										))}
								</ul>
							)}
						</div>
					)}
				</section>
			)}
		</section>
	);
}
