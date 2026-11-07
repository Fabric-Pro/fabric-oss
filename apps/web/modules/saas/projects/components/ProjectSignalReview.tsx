"use client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

const api = orpcClient.projects.triage;
interface Choice {
	id: string;
	capturedAt: string;
}
/** One private review drawer; history stays out of the project document flow. */
export function ProjectSignalReview({
	projectId,
	scope,
	choices,
}: {
	projectId: string;
	scope: readonly unknown[];
	choices: Choice[];
}) {
	const t = useTranslations("deliverySignalReview");
	const client = useQueryClient();
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"new" | "history" | "result">("new");
	const [selected, setSelected] = useState<string[]>([]);
	const [goal, setGoal] = useState("");
	const [runId, setRunId] = useState<string>();
	const [before, setBefore] = useState<string>();
	const intent = useRef<
		| {
				projectId: string;
				requestId: string;
				goal: string;
				evidenceIds: string[];
		  }
		| undefined
	>(undefined);
	const goalId = useId();
	const pollUntil = useRef(0);
	const key = [...scope, "triage"];
	const history = useQuery({
		queryKey: [...key, "list", before],
		queryFn: () => api.list({ projectId, ...(before ? { before } : {}) }),
		enabled: open,
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	const status = useQuery({
		queryKey: [...key, "status", runId],
		queryFn: () => api.status({ projectId, runId: runId! }),
		enabled: open && !!runId,
		gcTime: 0,
		staleTime: 0,
		retry: false,
		refetchInterval: (q) =>
			Date.now() < pollUntil.current &&
			["QUEUED", "RUNNING"].includes(q.state.data?.status ?? "")
				? 3000
				: false,
	});
	const result = useQuery({
		queryKey: [...key, "result", runId],
		queryFn: () => api.result({ projectId, runId: runId! }),
		enabled: open && status.data?.status === "COMPLETED" && !status.isError,
		gcTime: 0,
		staleTime: 0,
		retry: false,
		refetchOnWindowFocus: "always",
	});
	const start = useMutation({
		mutationFn: (input: NonNullable<typeof intent.current>) =>
			api.start(input),
		onError: (error) => {
			const dataCode =
				error &&
				typeof error === "object" &&
				"data" in error &&
				error.data &&
				typeof error.data === "object" &&
				"code" in error.data
					? String(error.data.code)
					: "";
			if (dataCode === "TRIAGE_NOT_ENABLED") intent.current = undefined;
			const code =
				error && typeof error === "object" && "code" in error
					? String(error.code)
					: "";
			if (
				[
					"BAD_REQUEST",
					"UNAUTHORIZED",
					"FORBIDDEN",
					"NOT_FOUND",
					"CONFLICT",
				].includes(code)
			) {
				intent.current = undefined;
			}
		},
		onSuccess: (run) => {
			intent.current = undefined;
			pollUntil.current = Date.now() + 120000;
			setRunId(run.id);
			setView("result");
			void history.refetch();
		},
	});
	const cancel = useMutation({
		mutationFn: () => api.cancel({ projectId, runId: runId! }),
		onSuccess: () => {
			void status.refetch();
			void history.refetch();
		},
	});
	const review = useMutation({
		mutationFn: (input: {
			proposalId: string;
			decision: "KEEP" | "DISMISS";
		}) => api.review({ projectId, runId: runId!, ...input }),
		onSuccess: () => void result.refetch(),
	});
	useEffect(() => {
		if (!open) {
			setRunId(undefined);
			client.removeQueries({ queryKey: [...scope, "triage", "result"] });
		}
	}, [open, client, scope]);
	const unavailable =
		history.isPending || history.data?.availability !== "AVAILABLE";
	const busy = start.isPending || !!intent.current;
	const shown =
		!status.isError &&
		!history.isError &&
		!review.isError &&
		!result.isFetching &&
		!result.isError
			? result.data
			: undefined;
	const error =
		history.isError ||
		status.isError ||
		result.isError ||
		start.isError ||
		cancel.isError ||
		review.isError;
	function run() {
		intent.current ??= {
			projectId,
			requestId: crypto.randomUUID(),
			goal,
			evidenceIds: [...selected],
		};
		start.mutate(intent.current);
	}
	const selectRun = (id: string) => {
		start.reset();
		cancel.reset();
		review.reset();
		pollUntil.current = Date.now() + 120000;
		setRunId(id);
		setView("result");
	};
	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				{t("open")}
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="flex h-full flex-col sm:max-w-2xl">
					<SheetHeader>
						<SheetTitle>{t("title")}</SheetTitle>
						<SheetDescription>{t("scope")}</SheetDescription>
					</SheetHeader>
					<div className="flex gap-2 border-b border-border py-3">
						<Button
							variant={view === "new" ? "secondary" : "ghost"}
							onClick={() => setView("new")}
						>
							{t("newReview")}
						</Button>
						<Button
							variant={view === "history" ? "secondary" : "ghost"}
							onClick={() => {
								setView("history");
								void history.refetch();
							}}
						>
							{t("history")}
						</Button>
						{runId && (
							<Button
								variant={
									view === "result" ? "secondary" : "ghost"
								}
								onClick={() => setView("result")}
							>
								{t("result")}
							</Button>
						)}
					</div>
					<div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-5 scrollbar-hide">
						{error && (
							<div role="alert" className="space-y-2 text-sm">
								<p>{t("error")}</p>
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										review.reset();
										cancel.reset();
										void history.refetch();
										if (runId) {
											void status.refetch();
											void result.refetch();
										}
									}}
								>
									{t("refresh")}
								</Button>
							</div>
						)}
						{view === "new" && (
							<div className="space-y-5">
								{!history.isPending && unavailable && (
									<p
										role="status"
										className="text-sm text-muted-foreground"
									>
										{t("notEnabled")}
									</p>
								)}
								<fieldset
									disabled={busy || unavailable}
									className="space-y-3"
								>
									<legend className="mb-3 font-medium text-sm">
										{t("choose")}
									</legend>
									{!choices.length && (
										<p className="text-sm text-muted-foreground">
											{t("noSignals")}
										</p>
									)}
									{choices.map((choice) => (
										<label
											key={choice.id}
											htmlFor={`${goalId}-${choice.id}`}
											className="flex items-center gap-3 rounded-md border border-border p-3 text-sm"
										>
											<Checkbox
												id={`${goalId}-${choice.id}`}
												checked={selected.includes(
													choice.id,
												)}
												disabled={
													!selected.includes(
														choice.id,
													) && selected.length >= 5
												}
												onCheckedChange={(checked) =>
													setSelected((ids) =>
														checked
															? [
																	...ids,
																	choice.id,
																]
															: ids.filter(
																	(id) =>
																		id !==
																		choice.id,
																),
													)
												}
											/>
											<span className="min-w-0">
												<span className="block">
													{new Date(
														choice.capturedAt,
													).toLocaleString()}
												</span>
												<span className="block break-all text-xs text-muted-foreground">
													{choice.id}
												</span>
											</span>
										</label>
									))}
								</fieldset>
								<div className="space-y-2">
									<Label htmlFor={goalId}>{t("goal")}</Label>
									<Textarea
										id={goalId}
										value={goal}
										onChange={(e) =>
											setGoal(e.target.value)
										}
										maxLength={2000}
										disabled={busy || unavailable}
										placeholder={t("goalPlaceholder")}
									/>
								</div>
								<p className="text-sm text-muted-foreground">
									{t("cost")}
								</p>
								<Button
									onClick={run}
									disabled={
										start.isPending ||
										unavailable ||
										!selected.length ||
										!goal.trim() ||
										new TextEncoder().encode(goal)
											.byteLength > 2000
									}
								>
									{start.isPending
										? t("starting")
										: intent.current
											? t("retrySaved")
											: t("start")}
								</Button>
								{intent.current && start.isError && (
									<p
										role="status"
										className="text-sm text-muted-foreground"
									>
										{t("uncertain")}
									</p>
								)}
							</div>
						)}
						{view === "history" && (
							<div className="space-y-4">
								{history.isFetching ? (
									<p role="status">{t("loading")}</p>
								) : (
									!history.isError && (
										<>
											{!history.data?.runs.length && (
												<p className="text-sm text-muted-foreground">
													{t("empty")}
												</p>
											)}
											<ul className="divide-y divide-border">
												{history.data?.runs.map(
													(run) => (
														<li key={run.id}>
															<button
																type="button"
																className="flex w-full flex-wrap items-center justify-between gap-3 rounded-md py-4 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
																onClick={() =>
																	selectRun(
																		run.id,
																	)
																}
															>
																<span>
																	<span className="block">
																		{new Date(
																			run.createdAt,
																		).toLocaleString()}
																	</span>
																	<span className="text-muted-foreground">
																		{t(
																			"selectedCount",
																			{
																				count: run.selectedCount,
																			},
																		)}
																	</span>
																</span>
																<Badge variant="secondary">
																	{t(
																		`states.${run.status}`,
																	)}
																</Badge>
															</button>
														</li>
													),
												)}
											</ul>
											<div className="flex gap-2">
												<Button
													variant="outline"
													disabled={!before}
													onClick={() =>
														setBefore(undefined)
													}
												>
													{t("latest")}
												</Button>
												<Button
													variant="outline"
													disabled={
														!history.data
															?.nextBefore
													}
													onClick={() =>
														setBefore(
															history.data
																?.nextBefore ??
																undefined,
														)
													}
												>
													{t("older")}
												</Button>
											</div>
										</>
									)
								)}
							</div>
						)}
						{view === "result" && runId && (
							<div className="space-y-5">
								<div className="flex flex-wrap items-center gap-3">
									<Badge variant="secondary">
										{status.data
											? t(`states.${status.data.status}`)
											: t("loading")}
									</Badge>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											pollUntil.current =
												Date.now() + 120000;
											void status.refetch();
											if (
												status.data?.status ===
												"COMPLETED"
											) {
												void result.refetch();
											}
										}}
									>
										{t("refresh")}
									</Button>
									{["QUEUED", "RUNNING"].includes(
										status.data?.status ?? "",
									) && (
										<Button
											size="sm"
											variant="outline"
											disabled={cancel.isPending}
											onClick={() => cancel.mutate()}
										>
											{t("cancel")}
										</Button>
									)}
								</div>
								{(status.data?.failureCode ||
									status.data?.status ===
										"OUTCOME_UNKNOWN") && (
									<p
										role="status"
										className="text-sm text-muted-foreground"
									>
										{t(
											status.data.status ===
												"OUTCOME_UNKNOWN" ||
												status.data.failureCode ===
													"OUTCOME_UNKNOWN"
												? "unknownSpend"
												: status.data.status ===
														"CANCELLED"
													? "states.CANCELLED"
													: "failed",
										)}
									</p>
								)}
								{result.isFetching && (
									<p role="status" className="text-sm">
										{t("checking")}
									</p>
								)}
								{shown?.result &&
									!shown.result.proposals.length && (
										<p className="text-sm text-muted-foreground">
											{t("noProposals")}
										</p>
									)}
								<ul className="divide-y divide-border">
									{shown?.result?.proposals.map(
										(proposal) => (
											<li
												key={proposal.id}
												className="space-y-3 py-5"
											>
												<h3 className="font-semibold">
													{proposal.title}
												</h3>
												<p className="whitespace-pre-wrap break-words text-sm">
													{proposal.summary}
												</p>
												{proposal.uncertainties.length >
													0 && (
													<div>
														<h4 className="text-sm font-medium">
															{t("uncertainties")}
														</h4>
														<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
															{proposal.uncertainties.map(
																(
																	value,
																	index,
																) => (
																	<li
																		key={`${index}-${value}`}
																	>
																		{value}
																	</li>
																),
															)}
														</ul>
													</div>
												)}
												<details className="text-sm">
													<summary className="cursor-pointer">
														{t("citations", {
															count: proposal
																.citations
																.length,
														})}
													</summary>
													<ul className="space-y-2 py-2">
														{proposal.citations.map(
															(pin) => (
																<li
																	key={
																		pin.observationId
																	}
																	className="break-all text-xs text-muted-foreground"
																>
																	{
																		pin.observationId
																	}
																</li>
															),
														)}
													</ul>
												</details>
												<div className="flex flex-wrap items-center gap-2">
													<Button
														size="sm"
														variant="outline"
														disabled={
															review.isPending ||
															shown.reviews[
																proposal.id
															] === "KEEP"
														}
														onClick={() =>
															review.mutate({
																proposalId:
																	proposal.id,
																decision:
																	"KEEP",
															})
														}
													>
														{shown.reviews[
															proposal.id
														] === "KEEP"
															? t("kept")
															: t("keep")}
													</Button>
													<Button
														size="sm"
														variant="ghost"
														disabled={
															review.isPending ||
															shown.reviews[
																proposal.id
															] === "DISMISS"
														}
														onClick={() =>
															review.mutate({
																proposalId:
																	proposal.id,
																decision:
																	"DISMISS",
															})
														}
													>
														{shown.reviews[
															proposal.id
														] === "DISMISS"
															? t("dismissed")
															: t("dismiss")}
													</Button>
												</div>
											</li>
										),
									)}
								</ul>
							</div>
						)}
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
