"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	CircleSlashIcon,
	Loader2Icon,
	PlayIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { BulkSelection } from "../BulkActionsBar";
import { formatAbsoluteTime, timeAgo } from "./pipeline-run";
import { RunConfigurationDialog } from "./RunConfigurationDialog";

/**
 * Runs Fabric orchestrated itself — as opposed to the CI runs it ingested, which
 * the panel below this one shows.
 *
 * Kept as a SEPARATE panel rather than merged into the CI runs list, even though
 * both end up as `TestPipelineRun` rows. They answer different questions: "did
 * the customer's pipeline pass" and "did Fabric's own run of my authored cases
 * pass". Blending them would make the provider column the only thing
 * distinguishing a run Fabric is responsible for from one it merely read.
 *
 * An in-flight run is polled rather than pushed: the workflow reports through the
 * database and there is no socket for this surface. 4s is frequent enough that a
 * short run does not look stuck and cheap enough that an idle tab costs little.
 */

const IN_FLIGHT = new Set(["QUEUED", "RUNNING"]);

/**
 * How many times to keep asking a terminal-but-empty run for its step log
 * before accepting that it has none. At the 4s interval below that is a little
 * over half a minute — comfortably longer than the gap between a run reaching a
 * terminal status and `persistAgenticRun` writing its steps, and short enough
 * that a run which genuinely recorded nothing stops being polled.
 */
const SETTLE_POLL_LIMIT = 8;

/** Runs per page. Matches the old fixed cap, so the first page is unchanged. */
const AGENTIC_RUNS_PAGE = 25;

/**
 * Should the run-detail query keep asking for a step log?
 *
 * Exported and pure because the interesting case is not "while it runs" — it is
 * the window AFTER a run reaches a terminal status but BEFORE
 * `persistAgenticRun` has written its steps. Stopping there latched
 * "This run recorded no steps." permanently on a run that had plenty, which is
 * exactly the wrong thing to tell someone who just pressed Stop.
 */
export function shouldPollRunDetail(input: {
	status: string;
	caseCount: number;
	pollsSoFar: number;
}): boolean {
	if (IN_FLIGHT.has(input.status)) {
		return true;
	}
	// A refused run never ran a step and never will; anything else that is
	// terminal and empty is most likely still being written.
	return (
		input.caseCount === 0 &&
		input.status !== "REFUSED" &&
		input.pollsSoFar < SETTLE_POLL_LIMIT
	);
}

type RunDetailPollState = {
	runId: string | null;
	terminalEmptyPolls: number;
};

export function advanceRunDetailPollState(
	state: RunDetailPollState,
	input: { runId: string; status: string; caseCount: number },
): { state: RunDetailPollState; pollsSoFar: number } {
	if (
		state.runId !== input.runId ||
		IN_FLIGHT.has(input.status) ||
		input.caseCount > 0 ||
		input.status === "REFUSED"
	) {
		return {
			state: { runId: input.runId, terminalEmptyPolls: 0 },
			pollsSoFar: 0,
		};
	}
	return {
		state: {
			runId: input.runId,
			terminalEmptyPolls: state.terminalEmptyPolls + 1,
		},
		pollsSoFar: state.terminalEmptyPolls,
	};
}

/**
 * Mirrors the server's `MAX_CASES_PER_RUN`. A literal rather than an import:
 * @repo/api is a server package and importing it here would drag it into the
 * browser bundle — a mistake `tsc` does not catch and only a real build surfaces.
 * The server still enforces it; this exists so someone who selects every case is
 * told the limit BEFORE a request that can only fail.
 *
 * Durable batching now runs an arbitrary selection in slices via Temporal
 * `continueAsNew`, so this is no longer a cap on the feature — it is a
 * request-size sanity bound. A selection under it runs in full, however large.
 */
const MAX_CASES_PER_RUN = 500;

const STATUS_TONE: Record<string, string> = {
	QUEUED: "text-muted-foreground",
	RUNNING: "text-highlight",
	PASSED: "text-secondary",
	FAILED: "text-destructive",
	// Amber, matching the step-level BLOCKED below: the run finished but could
	// not test everything it was asked to. Deliberately not green (nothing was
	// verified) and not red (the product never disagreed).
	BLOCKED: "text-highlight",
	// Amber for the same reason, and deliberately the SAME amber as BLOCKED:
	// both mean "ran, reached no verdict, a person is needed". The label carries
	// the difference — inventing a sixth tone to separate two states that call
	// for the same action would be decoration, and colour is not how either one
	// is distinguished by anyone using a screen reader.
	NEEDS_REVIEW: "text-highlight",
	CANCELLED: "text-muted-foreground",
	REFUSED: "text-destructive",
};

const STEP_TONE: Record<string, string> = {
	PASSED: "text-secondary",
	FAILED: "text-destructive",
	BLOCKED: "text-highlight",
	NEEDS_REVIEW: "text-highlight",
	SKIPPED: "text-muted-foreground",
};

/**
 * How a status reads on screen.
 *
 * Every status here is rendered verbatim, which was fine while they were all
 * single words. `NEEDS_REVIEW` is the first with an underscore, and shipping the
 * database's spelling into the interface is how a schema detail becomes a label
 * nobody chose. Only the values that need rewriting appear — anything absent
 * falls through unchanged.
 */
const STATUS_LABEL: Record<string, string> = {
	NEEDS_REVIEW: "NEEDS REVIEW",
};

function statusLabel(status: string): string {
	return STATUS_LABEL[status] ?? status;
}

/**
 * One step's evidence, shown rather than linked.
 *
 * It used to be the word "screenshot" behind a link, which meant the only way
 * to find the frame where a run went wrong was to open every step in turn. The
 * image is the fastest thing on the page to read, so it is on the page.
 *
 * The signed links expire after five minutes. That is deliberate — the image is
 * a customer's application, sometimes signed in — but it means a panel left open
 * shows a broken image rather than an expired one, so a load failure is caught
 * and explained with the way to get a fresh link.
 */
function StepEvidence({
	viewUrl,
	downloadUrl,
	fileName,
}: {
	viewUrl: string;
	downloadUrl: string | null;
	fileName: string | null;
}) {
	const [expired, setExpired] = useState(false);

	if (expired) {
		return (
			<p className="mt-1 text-muted-foreground text-xs">
				This evidence link has expired. Reopen the run to get a fresh
				one.
			</p>
		);
	}

	return (
		<figure className="mt-1.5 space-y-1">
			<a
				href={viewUrl}
				target="_blank"
				rel="noreferrer"
				title="Open full size"
			>
				{/* biome-ignore lint/performance/noImgElement: a signed, short-lived
				    URL on a customer's storage host cannot go through the image
				    optimizer, which would need the host allow-listed and would
				    cache what is deliberately ephemeral. */}
				<img
					src={viewUrl}
					alt={
						fileName
							? `Evidence captured at ${fileName}`
							: "Evidence captured during this step"
					}
					loading="lazy"
					onError={() => setExpired(true)}
					className="max-h-48 w-auto rounded border border-border bg-muted object-contain"
				/>
			</a>
			<figcaption className="flex items-center gap-2 text-muted-foreground text-xs">
				<a
					href={viewUrl}
					target="_blank"
					rel="noreferrer"
					className="text-primary underline"
				>
					Open full size
				</a>
				{downloadUrl && (
					<>
						<span aria-hidden="true">·</span>
						<a
							href={downloadUrl}
							// The name comes from the signed URL's own
							// Content-Disposition; this attribute is the fallback
							// for a same-origin response that does not carry one.
							download={fileName ?? undefined}
							className="text-primary underline"
						>
							Download
						</a>
					</>
				)}
				{fileName && <span className="truncate">{fileName}</span>}
			</figcaption>
		</figure>
	);
}

function money(value: number | null): string {
	return value === null ? "—" : `$${value.toFixed(2)}`;
}

export function AgenticRunsPanel({
	projectId,
	selection,
	selectionCount = 0,
	canRun,
}: {
	projectId: string;
	/**
	 * What the reader selected on the Cases segment — an id list, or the
	 * filter behind "Select all N matching".
	 *
	 * Carried as the same predicate the bulk actions use rather than as a
	 * resolved id list, because "all matching" deliberately holds no ids. Taking
	 * ids here is what left the Run button dead on the widest selection the list
	 * offers: bulk edits honoured the predicate and runs received an empty array.
	 */
	selection?: BulkSelection;
	/** How many cases that selection names — `total` in filter mode. */
	selectionCount?: number;
	canRun: boolean;
}) {
	const queryClient = useQueryClient();
	const [openRunId, setOpenRunId] = useState<string | null>(null);
	const detailPollState = useRef<RunDetailPollState>({
		runId: null,
		terminalEmptyPolls: 0,
	});
	/**
	 * The run-configuration dialog (mocks C2). The Run button opens it rather
	 * than dispatching, so environment / browser / resolution are a choice made
	 * per run instead of whatever Settings ▸ Testing happened to list first.
	 */
	const [configuring, setConfiguring] = useState(false);

	// Whether a run has a target at all. The server resolves the environment from
	// the project's QA policy and 400s without one; the panel used to leave the
	// Run button enabled regardless, so the only way to discover the problem was
	// to press it and read an error pointing at a DIFFERENT screen.
	const settingsQuery = useQuery(
		orpc.projects.qaSettings.get.queryOptions({ input: { projectId } }),
	);
	const environmentsQuery = useQuery(
		orpc.projects.environments.list.queryOptions({ input: { projectId } }),
	);

	// Paged, not capped. The plain list returns the newest 25 and stops, which
	// reads as the whole history because nothing on screen says otherwise — every
	// older run was invisible with no way to reach it.
	const runsQuery = useInfiniteQuery({
		...orpc.projects.agenticRuns.listPage.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				limit: AGENTIC_RUNS_PAGE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, allPages) => {
				const loaded = allPages.reduce(
					(sum, page) => sum + page.runs.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
		// Poll only while something is actually in flight. A finished list is
		// static, and polling it forever is a tab that never goes quiet.
		refetchInterval: (query) =>
			(query.state.data?.pages ?? [])
				.flatMap((page) => page.runs)
				.some((r) => IN_FLIGHT.has(r.status))
				? 4000
				: false,
	});
	const runs = (runsQuery.data?.pages ?? []).flatMap((page) => page.runs);
	const runsTotal = runsQuery.data?.pages?.[0]?.total ?? 0;

	/**
	 * A run that just finished may have written findings, and the findings panel
	 * beside this one does not know that.
	 *
	 * Without this a failing run's finding only appears after a full page
	 * reload — the same shape #2317 fixed for the sync mutation, where every
	 * test was green and the user-visible behaviour was "nothing happened".
	 * Keyed on the set of terminal run ids so it fires once per completion
	 * rather than on every poll tick.
	 */
	const settledRunIds = runs
		.filter((r) => !IN_FLIGHT.has(r.status))
		.map((r) => r.id)
		.join(",");
	useEffect(() => {
		if (!settledRunIds) {
			return;
		}
		queryClient.invalidateQueries({
			queryKey: orpc.projects.pipelineResults.findings.key(),
		});
	}, [settledRunIds, queryClient]);

	const detailQuery = useQuery({
		...orpc.projects.agenticRuns.get.queryOptions({
			input: { projectId, runId: openRunId ?? "" },
		}),
		enabled: openRunId !== null,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) {
				return false;
			}
			const tracked = advanceRunDetailPollState(detailPollState.current, {
				runId: data.run.id,
				status: data.run.status,
				caseCount: data.cases.length,
			});
			detailPollState.current = tracked.state;
			return shouldPollRunDetail({
				status: data.run.status,
				caseCount: data.cases.length,
				pollsSoFar: tracked.pollsSoFar,
			})
				? 4000
				: false;
		},
	});

	const dispatchMutation = useMutation(
		orpc.projects.agenticRuns.dispatch.mutationOptions({
			onSuccess: (result) => {
				setConfiguring(false);
				if (result.dispatched) {
					toast.success("Run started");
					setOpenRunId(result.run.id);
				} else {
					// A refusal is not an error toast — it is an answer, and it
					// names a number the user can act on.
					toast.warning(result.reason ?? "The run was refused.");
				}
				// A production target no longer BLOCKS the run (a product ruling:
				// warn, do not gate), so this is the only thing that tells anyone
				// a browser just acted on their live system. Shown after the
				// outcome toast and given a long dwell — a warning that shares the
				// default three seconds with "Run started" is one nobody reads.
				if (result.productionWarning) {
					toast.warning(result.productionWarning, {
						duration: 12_000,
					});
				}
				queryClient.invalidateQueries({
					queryKey: orpc.projects.agenticRuns.list.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const cancelMutation = useMutation(
		orpc.projects.agenticRuns.cancel.mutationOptions({
			onSuccess: () => {
				toast.success("Cancelling — steps already run are kept");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.agenticRuns.list.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const caseCount = selectionCount;
	const overLimit = caseCount > MAX_CASES_PER_RUN;

	// Two distinct failures needing different sentences: no environment exists at
	// all, versus one exists but none is the default. Judged only once BOTH
	// queries have answered — a button disabled during loading flickers and reads
	// as "you cannot do this".
	const targetsLoaded =
		settingsQuery.data !== undefined &&
		environmentsQuery.data !== undefined;
	const environments = environmentsQuery.data ?? [];
	const defaultEnvironmentId = settingsQuery.data?.defaultEnvironmentId;
	// The default is deliberately NOT a foreign key, so it can point at a deleted
	// environment. Checking membership rather than mere presence is what makes
	// this agree with what the server will actually resolve.
	const hasRunTarget =
		!!defaultEnvironmentId &&
		environments.some((e) => e.id === defaultEnvironmentId);
	const missingTarget = targetsLoaded && !hasRunTarget;

	return (
		<section className="rounded-lg border bg-card p-4">
			<RunConfigurationDialog
				projectId={projectId}
				open={configuring}
				onOpenChange={setConfiguring}
				caseCount={caseCount}
				dispatching={dispatchMutation.isPending}
				onDispatch={(overrides) =>
					selection &&
					dispatchMutation.mutate({
						projectId,
						selection,
						...overrides,
					})
				}
			/>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h4 className="font-medium text-sm">Fabric runs</h4>
					<p className="mt-1 max-w-2xl text-muted-foreground text-xs">
						Run authored steps agentically or execute an editable
						Playwright script in an isolated sandbox. Failures
						become findings for a person to triage — never bugs
						filed automatically.
					</p>
				</div>
				<Button
					size="sm"
					disabled={
						!canRun ||
						caseCount === 0 ||
						overLimit ||
						missingTarget ||
						dispatchMutation.isPending
					}
					onClick={() => setConfiguring(true)}
					title={
						caseCount === 0
							? "Select the cases to run on the Cases tab first"
							: overLimit
								? `A run covers at most ${MAX_CASES_PER_RUN} cases`
								: missingTarget
									? "Set a default environment in Settings ▸ Testing first"
									: undefined
					}
				>
					{dispatchMutation.isPending ? (
						<Loader2Icon
							className="mr-1.5 size-3.5 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					) : (
						<PlayIcon
							className="mr-1.5 size-3.5"
							aria-hidden="true"
						/>
					)}
					{caseCount > 0
						? `Run ${caseCount} case${caseCount === 1 ? "" : "s"}`
						: "Run selected cases"}
				</Button>
			</div>

			{caseCount === 0 && (
				// Said plainly rather than leaving a disabled button unexplained —
				// a control that cannot be pressed and does not say why reads as
				// broken.
				<p className="mt-3 text-muted-foreground text-xs">
					Select one or more cases on the <strong>Cases</strong> tab
					to run them here.
				</p>
			)}

			{missingTarget && (
				// The G3 defect: the button was enabled, the dispatch 400'd, and
				// the (correct, actionable) message pointed at a different
				// screen — so the only way to learn a run had no target was to
				// start one. Refusing here, with the reason, keeps that
				// discovery out of the error path.
				<p className="mt-3 text-muted-foreground text-xs">
					{environments.length === 0
						? "No environments are configured. Add the URL Fabric should test under Settings ▸ Environments, then choose it as the default in Settings ▸ Testing."
						: "No default environment is set. Choose which environment runs target under Settings ▸ Testing."}
				</p>
			)}

			{overLimit && (
				// Same reasoning as the empty case above, which this originally
				// missed: the button was disabled with nothing naming the limit, so
				// selecting every case produced a dead control. Naming the number
				// and the remedy is the whole point — the server's own message says
				// the same thing, but the panel refuses first, so it never arrives.
				<p className="mt-3 text-muted-foreground text-xs">
					{caseCount} cases selected — a single run covers at most{" "}
					<strong>{MAX_CASES_PER_RUN}</strong>. Narrow the selection
					on the <strong>Cases</strong> tab to start a run. Fabric
					runs large selections in batches, so there is no need to
					split them yourself.
				</p>
			)}

			{runsQuery.isLoading ? (
				<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					Loading runs…
				</div>
			) : runs.length === 0 ? (
				<p className="mt-4 rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
					Fabric has not run any cases for this project yet.
				</p>
			) : (
				<ul className="mt-4 divide-y divide-border rounded-md border">
					{runs.map((run) => {
						const inFlight = IN_FLIGHT.has(run.status);
						return (
							<li key={run.id} className="px-3 py-2.5">
								<div className="flex flex-wrap items-center gap-3">
									<span
										className={`w-28 shrink-0 font-medium text-xs uppercase tracking-wide ${
											STATUS_TONE[run.status] ??
											"text-muted-foreground"
										}`}
									>
										{statusLabel(run.status)}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
										{run.targetBaseUrl}
									</span>
									{/* When, and by whom. A history that answers
									    neither cannot be used to explain anything
									    after the fact — and these runs cost money,
									    so "who started this" is a question that
									    gets asked. `startedAt` falls back to
									    `createdAt` because a REFUSED run never
									    started but still happened. */}
									<time
										className="shrink-0 text-muted-foreground text-xs"
										dateTime={new Date(
											run.startedAt ?? run.createdAt,
										).toISOString()}
										title={
											formatAbsoluteTime(
												run.startedAt ?? run.createdAt,
											) ?? undefined
										}
									>
										{timeAgo(
											run.startedAt ?? run.createdAt,
										)}
									</time>
									{run.triggeredByActor && (
										<span
											className="hidden shrink-0 truncate text-muted-foreground text-xs sm:inline"
											title={run.triggeredByActor}
										>
											by {run.triggeredByActor}
										</span>
									)}
									{run.environmentType === "PRODUCTION" && (
										<span className="flex items-center gap-1 text-highlight text-xs">
											<TriangleAlertIcon
												className="size-3.5"
												aria-hidden="true"
											/>
											production
										</span>
									)}
									<span className="shrink-0 text-muted-foreground text-xs">
										{run.runMode === "MODE_B"
											? "scripted"
											: "agentic"}
									</span>
									<span className="shrink-0 text-muted-foreground text-xs">
										{run.passedCount}/{run.caseCount} passed
										{run.failedCount > 0 &&
											` · ${run.failedCount} failed`}
										{run.blockedCount > 0 &&
											` · ${run.blockedCount} blocked`}
										{run.needsReviewCount > 0 &&
											` · ${run.needsReviewCount} to review`}
									</span>
									<span
										className="shrink-0 text-muted-foreground text-xs"
										title={`Estimated ${money(run.estimatedCostUsd)}, cap ${money(run.costCapUsd)}`}
									>
										{money(
											run.actualCostUsd ??
												run.estimatedCostUsd,
										)}
									</span>
									<Button
										size="sm"
										variant="ghost"
										onClick={() =>
											setOpenRunId((cur) =>
												cur === run.id ? null : run.id,
											)
										}
									>
										{openRunId === run.id
											? "Hide"
											: "Steps"}
									</Button>
									{inFlight && canRun && (
										<Button
											size="sm"
											variant="ghost"
											disabled={cancelMutation.isPending}
											onClick={() =>
												cancelMutation.mutate({
													projectId,
													runId: run.id,
												})
											}
										>
											<CircleSlashIcon
												className="mr-1.5 size-3.5"
												aria-hidden="true"
											/>
											Stop
										</Button>
									)}
								</div>

								{run.refusalReason && (
									<p className="mt-2 text-destructive text-xs">
										{run.refusalReason}
									</p>
								)}

								{openRunId === run.id && (
									<div className="mt-3">
										{detailQuery.isLoading ? (
											<p className="text-muted-foreground text-xs">
												Loading steps…
											</p>
										) : (detailQuery.data?.cases.length ??
												0) === 0 ? (
											<p className="text-muted-foreground text-xs">
												{inFlight
													? "The run is still going. The counts above advance as each case finishes; the full step log is written when the run completes."
													: run.status === "REFUSED"
														? "This run was refused before it started, so there are no steps to show."
														: // Said this way round on purpose. The step log is
															// written after the run reaches a terminal status,
															// so "nothing here" and "not written yet" look
															// identical for a few seconds — and telling someone
															// who just cancelled that their run recorded nothing
															// reads as work thrown away. It settles into the real
															// log on its own.
															"Collecting the step log for this run — the steps that did execute are kept, including on a cancelled run."}
											</p>
										) : (
											<ul className="space-y-3">
												{detailQuery.data?.cases.map(
													(c) => (
														<li
															key={c.testCaseId}
															className="rounded-md bg-muted/40 p-2.5"
														>
															<p className="font-medium text-xs">
																<span
																	className={
																		STEP_TONE[
																			c
																				.result
																		] ?? ""
																	}
																>
																	{statusLabel(
																		c.result,
																	)}
																</span>{" "}
																{c.identifier}{" "}
																{c.title}
															</p>
															{c.failureMessage &&
																c.steps
																	.length ===
																	0 && (
																	// Only when there is no step log to read. A case
																	// blocked before its first step — sign-in failed,
																	// the page never loaded — otherwise renders as a
																	// bare verdict with the reason left in the
																	// database, which is how the first real run looked.
																	<p className="mt-1 text-muted-foreground text-xs">
																		{
																			c.failureMessage
																		}
																	</p>
																)}
															<ol className="mt-2 space-y-1.5">
																{c.steps.map(
																	(step) => (
																		<li
																			key={
																				step.id
																			}
																			className="text-xs"
																		>
																			<span
																				className={`font-medium ${STEP_TONE[step.status] ?? ""}`}
																			>
																				{statusLabel(
																					step.status,
																				)}
																			</span>{" "}
																			<span className="text-muted-foreground">
																				{
																					step.action
																				}
																			</span>
																			{step.observation && (
																				<p className="mt-0.5 text-muted-foreground">
																					{
																						step.observation
																					}
																				</p>
																			)}
																			{step.evidenceUrl && (
																				<StepEvidence
																					viewUrl={
																						step.evidenceUrl
																					}
																					downloadUrl={
																						step.evidenceDownloadUrl
																					}
																					fileName={
																						step.evidenceFileName
																					}
																				/>
																			)}
																		</li>
																	),
																)}
															</ol>
														</li>
													),
												)}
											</ul>
										)}
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{/* The way to everything older than the first page. Says the total, so
			    a truncated list is never mistaken for the whole history — which is
			    exactly what the old fixed cap of 25 looked like. */}
			{runsQuery.hasNextPage && (
				<div className="flex items-center gap-3 pt-1">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={runsQuery.isFetchingNextPage}
						onClick={() => runsQuery.fetchNextPage()}
					>
						{runsQuery.isFetchingNextPage ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : null}
						Show older runs
					</Button>
					<span className="text-muted-foreground text-xs">
						Showing {runs.length} of {runsTotal}
					</span>
				</div>
			)}
		</section>
	);
}
