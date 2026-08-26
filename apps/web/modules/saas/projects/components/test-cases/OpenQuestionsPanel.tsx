"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	HelpCircleIcon,
	Loader2Icon,
	PlusIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FeaturePicker } from "./FeaturePicker";
import { FilterChip } from "./FilterChip";
import { SectionHint } from "./SectionHint";

/**
 * The QA open-questions log — testing unknowns tracked to resolution.
 *
 * Ambiguities raised while planning tests ("is the 60s SLA in scope, or just
 * functional correctness?") used to sit as prose inside a QA analysis, where
 * nothing could list what was still open. This is the queryable surface: filter
 * by status, answer in place, or defer what the team has decided not to settle
 * yet.
 *
 * Copy is inline English, matching the QA settings pages in this feature.
 */

const STATUSES = ["OPEN", "ANSWERED", "DEFERRED"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABEL: Record<Status, string> = {
	OPEN: "Open",
	ANSWERED: "Answered",
	DEFERRED: "Deferred",
};

const STATUS_TONE: Record<Status, string> = {
	OPEN: "border-highlight/30 bg-highlight/10 text-highlight",
	ANSWERED: "border-secondary/30 bg-secondary/10 text-secondary",
	DEFERRED: "border-border bg-muted text-muted-foreground",
};

export function OpenQuestionsPanel({
	projectId,
	organizationId,
	canEdit,
	className,
}: {
	projectId: string;
	/** Needed by the feature picker, which resolves options per tenant. */
	organizationId: string | null;
	canEdit: boolean;
	className?: string;
}) {
	const queryClient = useQueryClient();
	const [filter, setFilter] = useState<Status | null>(null);
	const [draft, setDraft] = useState("");
	const [answering, setAnswering] = useState<string | null>(null);
	const [answerText, setAnswerText] = useState("");
	// The feature this question is about. `createQaOpenQuestion`
	// has always accepted `userStoryId`; the composer never sent one, so a
	// question could only be attached to a feature by something other than the
	// person asking it.
	const [linkedStory, setLinkedStory] = useState<{
		id: string;
		identifier: string;
	} | null>(null);

	const query = useQuery(
		orpc.projects.qaOpenQuestions.list.queryOptions({
			input: { projectId, ...(filter ? { status: filter } : {}) },
		}),
	);

	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.qaOpenQuestions.list.key(),
		});

	const createMutation = useMutation(
		orpc.projects.qaOpenQuestions.create.mutationOptions({
			onSuccess: () => {
				setDraft("");
				// Cleared with the draft. A sticky picker would silently attach
				// the previous question's feature to the next one, which is a
				// wrong link nobody typed.
				setLinkedStory(null);
				invalidate();
			},
			onError: (e) => toast.error(e.message),
		}),
	);

	const updateMutation = useMutation(
		orpc.projects.qaOpenQuestions.update.mutationOptions({
			onSuccess: () => {
				setAnswering(null);
				setAnswerText("");
				invalidate();
			},
			onError: (e) => toast.error(e.message),
		}),
	);

	const items = query.data?.items ?? [];

	return (
		<section className={cn("space-y-4", className)}>
			<div>
				<p className="app-editorial-label">
					Open questions
					<SectionHint
						className="ml-1.5 align-middle"
						label="How open questions work"
						body="Ambiguities raised while drafting or reviewing cases — a criterion that could be read two ways, a flow with no stated expected result. They live here rather than as comments on a case so the thing actually blocking coverage is visible without opening every case. The tab's count is open questions only, so answering one takes it down."
					/>
				</p>
				<p className="mt-1 text-muted-foreground text-sm">
					Testing unknowns raised during planning, tracked to
					resolution.
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-1.5">
				{[null, ...STATUSES].map((s) => (
					<button
						key={s ?? "ALL"}
						type="button"
						aria-pressed={filter === s}
						onClick={() => setFilter(s)}
						className={cn(
							"rounded-md border px-2.5 py-1 text-xs motion-safe:transition-colors",
							filter === s
								? "border-primary bg-primary/5 text-foreground"
								: "border-border/60 text-muted-foreground hover:text-foreground",
						)}
					>
						{s ? STATUS_LABEL[s] : "All"}
					</button>
				))}
			</div>

			{canEdit && (
				<div className="space-y-2 rounded-lg border bg-card p-3">
					<Textarea
						rows={2}
						value={draft}
						placeholder="What is unclear about testing this?"
						aria-label="New open question"
						onChange={(e) => setDraft(e.target.value)}
					/>
					<div className="flex flex-wrap items-center justify-between gap-2">
						{/* Optional: a question about testing in general is a
						    legitimate question, so this never blocks the button.
						    Once chosen it becomes a removable chip rather than
						    staying a picker — single-select never toggles off on
						    re-click, so without this a mis-pick could only be
						    undone by submitting or discarding the draft. Same
						    swap the cases toolbar makes, same component. */}
						{linkedStory ? (
							<FilterChip
								label="Feature"
								identifier={linkedStory.identifier}
								onRemove={() => setLinkedStory(null)}
								removeAriaLabel={`Remove feature ${linkedStory.identifier}`}
							/>
						) : (
							<FeaturePicker
								projectId={projectId}
								organizationId={organizationId}
								value={[]}
								onChange={(selected) =>
									setLinkedStory(
										selected[0]
											? {
													id: selected[0].id,
													identifier:
														selected[0].identifier,
												}
											: null,
									)
								}
								ariaLabel="Feature this question is about"
								placeholder="Link a feature (optional)"
								triggerClassName="h-8 w-[13rem]"
							/>
						)}
						<Button
							type="button"
							size="sm"
							disabled={!draft.trim() || createMutation.isPending}
							onClick={() =>
								createMutation.mutate({
									projectId,
									question: draft.trim(),
									...(linkedStory
										? { userStoryId: linkedStory.id }
										: {}),
								})
							}
							className="gap-1.5"
						>
							{createMutation.isPending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<PlusIcon
									className="size-4"
									aria-hidden="true"
								/>
							)}
							Add question
						</Button>
					</div>
				</div>
			)}

			{query.isLoading ? (
				<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					Loading questions…
				</div>
			) : query.isError ? (
				/* A failed load must not read as "nothing is open" — that is a
				   claim about the project this query never answered. */
				<p className="flex items-center gap-1.5 rounded-md border border-dashed bg-muted/30 px-4 py-6 text-destructive text-sm">
					<TriangleAlertIcon className="size-4" aria-hidden="true" />
					Couldn't load the open questions.
				</p>
			) : items.length === 0 ? (
				<div className="flex flex-col items-center gap-2 rounded-md border border-dashed bg-muted/30 px-4 py-10 text-center">
					<HelpCircleIcon className="size-7 text-muted-foreground/60" />
					<p className="text-muted-foreground text-sm">
						{filter
							? `No ${STATUS_LABEL[filter].toLowerCase()} questions.`
							: "No open questions recorded yet."}
					</p>
				</div>
			) : (
				<ul className="divide-y divide-border rounded-md border">
					{items.map((q) => (
						<li key={q.id} className="space-y-2 px-3 py-3">
							<div className="flex flex-wrap items-center gap-2">
								<span
									className={cn(
										"rounded-full border px-2 py-0.5 text-[11px]",
										STATUS_TONE[q.status as Status],
									)}
								>
									{STATUS_LABEL[q.status as Status]}
								</span>
								<span className="text-muted-foreground text-xs">
									{q.askedByLabel}
								</span>
								{q.userStory && (
									<span className="font-mono text-muted-foreground text-xs">
										{q.userStory.identifier}
									</span>
								)}
							</div>
							<p className="text-sm">{q.question}</p>
							{q.answer && (
								<p className="rounded-md bg-muted/40 px-2.5 py-2 text-muted-foreground text-sm">
									{q.answer}
								</p>
							)}

							{canEdit && answering === q.id ? (
								<div className="space-y-2">
									<Textarea
										rows={2}
										value={answerText}
										aria-label="Answer"
										onChange={(e) =>
											setAnswerText(e.target.value)
										}
									/>
									<div className="flex gap-2">
										<Button
											type="button"
											size="sm"
											disabled={updateMutation.isPending}
											onClick={() =>
												updateMutation.mutate({
													projectId,
													questionId: q.id,
													status: "ANSWERED",
													answer:
														answerText.trim() ||
														null,
												})
											}
										>
											Save answer
										</Button>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onClick={() => setAnswering(null)}
										>
											Cancel
										</Button>
									</div>
								</div>
							) : (
								canEdit && (
									<div className="flex flex-wrap gap-2">
										{q.status !== "ANSWERED" && (
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() => {
													setAnswering(q.id);
													setAnswerText(
														q.answer ?? "",
													);
												}}
											>
												Answer
											</Button>
										)}
										{q.status !== "DEFERRED" && (
											<Button
												type="button"
												size="sm"
												variant="ghost"
												disabled={
													updateMutation.isPending
												}
												onClick={() =>
													updateMutation.mutate({
														projectId,
														questionId: q.id,
														status: "DEFERRED",
													})
												}
											>
												Defer
											</Button>
										)}
										{q.status !== "OPEN" && (
											<Button
												type="button"
												size="sm"
												variant="ghost"
												disabled={
													updateMutation.isPending
												}
												onClick={() =>
													updateMutation.mutate({
														projectId,
														questionId: q.id,
														status: "OPEN",
													})
												}
											>
												Reopen
											</Button>
										)}
									</div>
								)
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
