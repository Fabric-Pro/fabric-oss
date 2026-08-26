"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	canEditTestCases,
	draftOutcomeMessageKey,
	isDraftJobActive,
	type TestCaseDraftFeatureOutcomeStatus,
} from "./draft-jobs";
import { TestCaseEditorSheet } from "./TestCaseEditorSheet";
import { TestCasePriorityBars } from "./TestCasePriorityBars";
import { TestCaseStatusChip } from "./TestCaseStatusChip";

type Props = {
	projectId: string;
	organizationId: string | null;
	/** The run to show. Null keeps the sheet closed. */
	jobId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/**
 * The drafted batch: every case a run produced, with what it is, its state and
 * priority, how many steps it has, and which criterion it covers — reviewable
 * without opening each one.
 *
 * This is the "see what was generated" surface. Drafting is non-blocking, so by
 * the time a run finishes its dialog is long gone; the batch is addressed by the
 * run instead, which already recorded exactly which cases it created. That is
 * also why the notification's deep link carries a job id rather than a filter.
 */
export function TestCaseDraftResultsSheet({
	projectId,
	organizationId,
	jobId,
	open,
	onOpenChange,
}: Props) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editorOpen, setEditorOpen] = useState(false);

	const jobQuery = useQuery({
		...orpc.projects.testCases.draftJobs.get.queryOptions({
			input: { projectId, jobId: jobId ?? "", organizationId },
		}),
		enabled: open && !!jobId,
		// Keep following a run opened from a deep link while it is still going.
		refetchInterval: (query) =>
			query.state.data && isDraftJobActive(query.state.data.status)
				? 3000
				: false,
	});

	// The results view is reachable from a notification, i.e. without the cases
	// list's props, so the edit affordance is resolved from the role rather than
	// assumed.
	const projectQuery = useQuery({
		...orpc.projects.get.queryOptions({ input: { id: projectId } }),
		enabled: open,
	});
	const canEdit = canEditTestCases(projectQuery.data?.project?.userRole);

	const job = jobQuery.data;
	const cases = job?.cases ?? [];
	const draftIds = cases
		.filter((testCase) => testCase.state === "DRAFT")
		.map((testCase) => testCase.id);

	const promoteMutation = useMutation(
		orpc.projects.testCases.bulk.mutationOptions({
			onSuccess: () => {
				toast.success(
					t("ai.results.promotedToast", { count: draftIds.length }),
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.list.key(),
				});
				jobQuery.refetch();
			},
			onError: (e) =>
				toast.error(
					t("ai.results.promoteFailed", { error: e.message }),
				),
		}),
	);

	// Features that produced nothing are advisory, not errors — a run where some
	// features lack criteria is the normal shape of a batch.
	const skipped = (job?.outcomes ?? []).filter(
		(outcome) => outcome.status !== "DRAFTED",
	);

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side="right"
					className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
				>
					<SheetHeader className="border-b px-6 py-4">
						<SheetTitle>{t("ai.results.title")}</SheetTitle>
						<SheetDescription>
							{t("ai.results.description")}
						</SheetDescription>
					</SheetHeader>

					<div className="flex-1 overflow-y-auto px-6 py-4">
						{jobQuery.isLoading ? (
							<p className="py-8 text-center text-muted-foreground text-sm">
								{t("ai.results.loading")}
							</p>
						) : !job ? (
							<p className="py-8 text-center text-muted-foreground text-sm">
								{t("ai.results.notFound")}
							</p>
						) : (
							<div className="space-y-6">
								{isDraftJobActive(job.status) && (
									<p
										className="flex items-center gap-2 text-muted-foreground text-sm"
										aria-live="polite"
									>
										<Loader2Icon
											aria-hidden="true"
											className="size-4 motion-safe:animate-spin"
										/>
										{t("ai.progress", {
											done: job.processedFeatures,
											total: job.totalFeatures,
										})}
									</p>
								)}

								{job.status === "FAILED" && job.error && (
									<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
										<AlertTriangleIcon
											aria-hidden="true"
											className="mt-0.5 size-4 shrink-0 text-destructive"
										/>
										<p className="text-foreground/90">
											{job.error}
										</p>
									</div>
								)}

								{cases.length > 0 && (
									<section className="space-y-2">
										<h3 className="editorial-label">
											{t("ai.results.casesHeading", {
												count: cases.length,
											})}
										</h3>
										<ul className="space-y-2">
											{cases.map((testCase) => (
												<li key={testCase.id}>
													<div className="rounded-lg border bg-card p-3">
														<div className="flex items-start gap-3">
															<span className="shrink-0 pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">
																{
																	testCase.identifier
																}
															</span>
															<div className="min-w-0 flex-1 space-y-1.5">
																<p className="font-medium text-sm">
																	{
																		testCase.title
																	}
																</p>
																<div className="flex flex-wrap items-center gap-2">
																	<TestCaseStatusChip
																		status={
																			testCase.state
																		}
																		label={t(
																			`states.${testCase.state.toLowerCase()}`,
																		)}
																	/>
																	<TestCasePriorityBars
																		priority={
																			testCase.priority
																		}
																	/>
																	<span className="text-muted-foreground text-xs">
																		{t(
																			"stepCount",
																			{
																				count: testCase.stepCount,
																			},
																		)}
																	</span>
																</div>
																{testCase.coverage.map(
																	(link) => (
																		<p
																			key={`${testCase.id}-${link.storyIdentifier}`}
																			className="text-muted-foreground text-xs"
																		>
																			{link
																				.acceptanceCriterionRefs
																				.length >
																			0
																				? t(
																						"ai.results.coversAc",
																						{
																							feature: `${link.storyIdentifier} ${link.storyTitle}`,
																							ac: link.acceptanceCriterionRefs.join(
																								", ",
																							),
																						},
																					)
																				: t(
																						"ai.results.covers",
																						{
																							feature: `${link.storyIdentifier} ${link.storyTitle}`,
																						},
																					)}
																		</p>
																	),
																)}
															</div>
															{canEdit && (
																<Button
																	variant="outline"
																	size="sm"
																	className="shrink-0"
																	onClick={() => {
																		setEditingId(
																			testCase.id,
																		);
																		setEditorOpen(
																			true,
																		);
																	}}
																>
																	{t(
																		"ai.results.open",
																	)}
																</Button>
															)}
														</div>
													</div>
												</li>
											))}
										</ul>
									</section>
								)}

								{skipped.length > 0 && (
									<section className="space-y-2">
										<h3 className="editorial-label">
											{t("ai.results.skippedHeading")}
										</h3>
										<ul className="space-y-1.5">
											{skipped.map((outcome) => (
												<li
													key={outcome.storyId}
													className="rounded-lg border border-highlight/30 bg-highlight/10 p-3 text-sm"
												>
													<p className="font-medium">
														{
															outcome.storyIdentifier
														}{" "}
														{outcome.storyTitle}
													</p>
													<p className="text-foreground/80 text-xs">
														{t(
															`ai.outcomes.${draftOutcomeMessageKey(
																outcome.status as TestCaseDraftFeatureOutcomeStatus,
															)}`,
														)}
														{outcome.error
															? ` — ${outcome.error}`
															: ""}
													</p>
												</li>
											))}
										</ul>
									</section>
								)}
							</div>
						)}
					</div>

					<div className="flex items-center justify-between gap-2 border-t px-6 py-4">
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							{t("actions.done")}
						</Button>
						{canEdit && draftIds.length > 0 && (
							<Button
								onClick={() =>
									promoteMutation.mutate({
										projectId,
										organizationId,
										selection: {
											mode: "ids",
											ids: draftIds,
										},
										operation: {
											type: "SET_STATE",
											state: "READY",
										},
									})
								}
								disabled={promoteMutation.isPending}
							>
								{promoteMutation.isPending && (
									<Loader2Icon
										aria-hidden="true"
										className="mr-2 size-4 motion-safe:animate-spin"
									/>
								)}
								{t("ai.results.promote", {
									count: draftIds.length,
								})}
							</Button>
						)}
					</div>
				</SheetContent>
			</Sheet>

			<TestCaseEditorSheet
				projectId={projectId}
				organizationId={organizationId}
				testCaseId={editingId}
				open={editorOpen}
				onOpenChange={setEditorOpen}
				canEdit={canEdit}
				onSaved={() => jobQuery.refetch()}
			/>
		</>
	);
}
