"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ExternalLinkIcon,
	Loader2Icon,
	RefreshCwIcon,
	TriangleAlertIcon,
	WorkflowIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	MARKABLE_RESULTS,
	RESULT_I18N_KEY,
	type RecordableResult,
	type TestResult,
} from "./constants";
import {
	HISTORY_DIALOG_PAGE,
	HISTORY_PANEL_PREVIEW,
	HistoryMoreDialog,
} from "./HistoryMoreDialog";
import { OwnerAvatar } from "./OwnerAvatar";
import { type RunHistoryItem, resolveRunActor } from "./run-history";
import { TestCaseResultPill } from "./TestCaseResultPill";

/** Sentinel for "no plan" in the Mark-result plan picker (Radix disallows ""). */
const PLAN_NONE = "__none__";

// ---------------------------------------------------------------------------
// Runs — mark a run result (manual), pull PM run outcomes (gated on the tool's
// test-execution capability), and show the provenance history: which result,
// when, WHO changed it (manual) or WHERE it ran (PM sync, with an external link).
// ---------------------------------------------------------------------------

export function RunsSection({
	projectId,
	organizationId,
	testCaseId,
	currentResult,
	planLinks,
	canEdit,
}: {
	projectId: string;
	organizationId: string | null;
	testCaseId: string;
	currentResult: TestResult;
	planLinks: { planId: string; identifier: string; name: string }[];
	canEdit: boolean;
}) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const [allOpen, setAllOpen] = useState(false);

	// The panel shows only the newest few; the rest live in the dialog.
	const historyQuery = useQuery(
		orpc.projects.testCases.resultHistory.queryOptions({
			input: {
				projectId,
				organizationId,
				testCaseId,
				limit: HISTORY_PANEL_PREVIEW,
			},
		}),
	);
	const items = (historyQuery.data?.items ?? []) as RunHistoryItem[];
	const total = historyQuery.data?.total ?? 0;

	// Paged full history — only fetched once the dialog is actually opened.
	const allQuery = useInfiniteQuery({
		...orpc.projects.testCases.resultHistory.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				organizationId,
				testCaseId,
				limit: HISTORY_DIALOG_PAGE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, allPages) => {
				const loaded = allPages.reduce(
					(sum, page) => sum + page.items.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
		enabled: allOpen,
	});
	const allItems = (allQuery.data?.pages ?? []).flatMap(
		(page) => page.items,
	) as RunHistoryItem[];

	const invalidate = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.list.key(),
		});
		// Procedure-level key on purpose: the history now lives in two queries —
		// the 5-row panel and the paged dialog — and an input-scoped key would
		// reach neither reliably (the dialog's is an `infinite` query, so it
		// carries a different type marker).
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.resultHistory.key(),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.get.queryKey({
				input: { projectId, testCaseId, organizationId },
			}),
		});
	};

	// Mark-result popover draft.
	const [markOpen, setMarkOpen] = useState(false);
	const [markResult, setMarkResult] = useState<RecordableResult | null>(null);
	const [markPlanId, setMarkPlanId] = useState<string>(PLAN_NONE);
	const [markNote, setMarkNote] = useState("");
	const resetMark = () => {
		setMarkResult(null);
		setMarkPlanId(PLAN_NONE);
		setMarkNote("");
	};

	// Mark path — always MANUAL (the route rejects a `source`). Invalidates the
	// list, the history and the case detail so the
	// current-result pill everywhere stays in step.
	const recordMutation = useMutation(
		orpc.projects.testCases.recordResult.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.resultRecorded"));
				setMarkOpen(false);
				resetMark();
				invalidate();
			},
			onError: (e) =>
				toast.error(t("toasts.resultFailed", { error: e.message })),
		}),
	);

	const submitMark = () => {
		if (!markResult) {
			return;
		}
		recordMutation.mutate({
			projectId,
			organizationId,
			testCaseId,
			result: markResult,
			testPlanId: markPlanId === PLAN_NONE ? null : markPlanId,
			note: markNote.trim() || null,
		});
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-3">
				<p className="app-editorial-label">{t("runs.heading")}</p>
			</div>

			{/* Current result + mark */}
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-muted-foreground text-xs">
					{t("runs.currentResult")}
				</span>
				<TestCaseResultPill
					result={currentResult}
					label={t(RESULT_I18N_KEY[currentResult])}
				/>
				{canEdit && (
					<Popover
						open={markOpen}
						onOpenChange={(o) => {
							setMarkOpen(o);
							if (!o) {
								resetMark();
							}
						}}
					>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="sm"
								aria-label={t("runs.markAria")}
							>
								{t("runs.mark")}
							</Button>
						</PopoverTrigger>
						<PopoverContent
							align="start"
							className="w-80 space-y-3"
						>
							<p className="app-editorial-label">
								{t("runs.mark")}
							</p>
							<div className="space-y-1.5">
								<span className="text-muted-foreground text-xs">
									{t("runs.resultLegend")}
								</span>
								<div className="flex flex-wrap gap-1.5">
									{MARKABLE_RESULTS.map((r) => {
										const active = markResult === r;
										return (
											<button
												key={r}
												type="button"
												aria-pressed={active}
												onClick={() => setMarkResult(r)}
												className={cn(
													"rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
													active
														? "ring-2 ring-ring"
														: "opacity-70 hover:opacity-100",
												)}
											>
												<TestCaseResultPill
													result={r}
													label={t(
														RESULT_I18N_KEY[r],
													)}
												/>
											</button>
										);
									})}
								</div>
							</div>
							{planLinks.length > 0 && (
								<div className="space-y-1.5">
									<Label
										htmlFor="tc-run-plan"
										className="text-muted-foreground text-xs"
									>
										{t("runs.planLabel")}
									</Label>
									<Select
										value={markPlanId}
										onValueChange={setMarkPlanId}
									>
										<SelectTrigger
											id="tc-run-plan"
											className="h-8"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={PLAN_NONE}>
												{t("runs.planNone")}
											</SelectItem>
											{planLinks.map((p) => (
												<SelectItem
													key={p.planId}
													value={p.planId}
												>
													{p.identifier} · {p.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
							<div className="space-y-1.5">
								<Label
									htmlFor="tc-run-note"
									className="text-muted-foreground text-xs"
								>
									{t("runs.noteLabel")}
								</Label>
								<Textarea
									id="tc-run-note"
									value={markNote}
									onChange={(e) =>
										setMarkNote(e.target.value)
									}
									rows={2}
									placeholder={t("runs.notePlaceholder")}
								/>
							</div>
							<div className="flex justify-end">
								<Button
									type="button"
									size="sm"
									disabled={
										!markResult || recordMutation.isPending
									}
									onClick={submitMark}
								>
									{recordMutation.isPending && (
										<Loader2Icon
											className="mr-2 size-4 animate-spin"
											aria-hidden="true"
										/>
									)}
									{t("runs.record")}
								</Button>
							</div>
						</PopoverContent>
					</Popover>
				)}
			</div>

			{/* History */}
			<div className="space-y-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
						{t("runs.historyHeading")}
					</p>
					{total > items.length && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setAllOpen(true)}
							className="h-auto py-0.5 text-muted-foreground text-xs hover:text-foreground"
						>
							{t("runs.viewAll", { total })}
						</Button>
					)}
				</div>
				{historyQuery.isLoading ? (
					<div className="flex items-center justify-center py-6 text-muted-foreground">
						<Loader2Icon className="size-4 animate-spin" />
					</div>
				) : historyQuery.isError ? (
					/*
					 * "No runs recorded yet" is a claim about the case, and a
					 * failed fetch cannot support it — a case that HAS run then
					 * reads as never tested.
					 */
					<p className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-destructive text-sm">
						<TriangleAlertIcon
							className="size-4"
							aria-hidden="true"
						/>
						{t("runs.historyFailed")}
					</p>
				) : items.length === 0 ? (
					<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
						{t("runs.historyEmpty")}
					</p>
				) : (
					<ul className="space-y-1.5">
						{items.map((item) => (
							<RunHistoryRow key={item.id} item={item} />
						))}
					</ul>
				)}
			</div>

			<HistoryMoreDialog
				open={allOpen}
				onOpenChange={setAllOpen}
				title={t("runs.historyHeading")}
				description={t("runs.dialogDescription")}
				total={allQuery.data?.pages[0]?.total ?? total}
				shown={allItems.length}
				hasMore={allQuery.hasNextPage === true}
				onShowMore={() => allQuery.fetchNextPage()}
				isLoading={allQuery.isLoading}
				isLoadingMore={allQuery.isFetchingNextPage}
				isError={allQuery.isError}
			>
				{allItems.map((item) => (
					<RunHistoryRow key={item.id} item={item} />
				))}
			</HistoryMoreDialog>
		</div>
	);
}

function RunHistoryRow({ item }: { item: RunHistoryItem }) {
	const t = useTranslations("projects.testCases");
	const actor = resolveRunActor(item);
	const actorName = actor.label ?? t("row.unknownActor");
	const when = new Date(item.occurredAt);
	const validDate = !Number.isNaN(when.getTime());

	return (
		<li className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<TestCaseResultPill
					result={item.result}
					label={t(RESULT_I18N_KEY[item.result])}
				/>
				{/* Source badge — the icon + text carry the distinction, never
				    colour alone. */}
				<span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
					{item.source === "PIPELINE" ? (
						<>
							<WorkflowIcon
								aria-hidden="true"
								className="size-3"
							/>
							{t("runs.sourcePipeline")}
						</>
					) : item.source === "PM_SYNC" ? (
						<>
							<RefreshCwIcon
								aria-hidden="true"
								className="size-3"
							/>
							{t("runs.sourceSynced")}
						</>
					) : (
						t("runs.sourceManual")
					)}
				</span>
				{validDate && (
					<time
						dateTime={when.toISOString()}
						title={when.toLocaleString()}
						className="text-muted-foreground text-xs"
					>
						{formatDistanceToNow(when, { addSuffix: true })}
					</time>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
				{item.source === "MANUAL" ? (
					<span className="inline-flex items-center gap-1.5">
						<OwnerAvatar name={actor.label} label={actorName} />
						<span>
							{t("runs.provenanceBy", { name: actorName })}
						</span>
					</span>
				) : (
					<span>{actorName}</span>
				)}
				{item.testPlan && (
					<span className="inline-flex items-center gap-1">
						<span aria-hidden="true">·</span>
						<span>
							{t("runs.inPlan", {
								identifier: item.testPlan.identifier,
							})}
						</span>
					</span>
				)}
				{(item.source === "PM_SYNC" || item.source === "PIPELINE") &&
					item.externalRunUrl && (
						<a
							href={item.externalRunUrl}
							target="_blank"
							rel="noreferrer"
							aria-label={t("runs.externalRunAria")}
							className="inline-flex items-center gap-1 text-primary hover:underline"
						>
							<ExternalLinkIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							{item.externalRunRef && (
								<span>{item.externalRunRef}</span>
							)}
						</a>
					)}
			</div>

			{item.note && (
				<p className="text-foreground/80 text-xs">{item.note}</p>
			)}
		</li>
	);
}
