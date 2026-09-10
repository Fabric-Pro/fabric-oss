"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { useState } from "react";
import { toast } from "sonner";
import {
	liveAnswerReply,
	type TopicDecisionThread,
} from "./TopicQuestionsPanel";

/**
 * What this topic is MISSING, before it can be published.
 *
 * A third class beside questions and approvals, and the distinction is the
 * whole point: "should this be a case study?" is decided at your desk in a
 * minute, and "we have no approved customer quote" takes somebody else and an
 * artifact that does not exist yet. They read identically today, so a reader
 * scanning their open items cannot tell which ones they can actually clear.
 *
 * Above the questions on Summary & Questions, because it is the shorter list
 * and the one that decides whether the other list is worth working through —
 * answering five questions for a case study nobody can approve is wasted.
 *
 * Not a table of its own: a blocker is a thread with a status, an author,
 * assignees and a history, which is every column the decision-entry table
 * already has. It rides the same query, the same tenancy and the same RLS.
 */
const BLOCKER_LABELS: Record<string, string> = {
	MISSING_ASSET: "Asset",
	MISSING_QUOTE: "Quote",
	MISSING_APPROVAL: "Approval",
	MISSING_DATA: "Data",
	OTHER: "Needed",
};

/** What a "not needed" reply records, so the log says why it closed. */
const NOT_NEEDED_ANSWER = "Not needed for this topic.";

export function TopicBlockers({
	projectId,
	topicId,
	organizationId,
	threads,
	canEdit,
}: {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	threads: TopicDecisionThread[];
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const [openId, setOpenId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	const settle = useMutation(
		orpc.projects.publishingSuite.answerTopicQuestion.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listTopicDecisions.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
				setOpenId(null);
				setDraft("");
			},
			onError: () => {
				toast.error("Could not record that. Please try again.");
			},
		}),
	);

	// OPEN only. A cleared blocker is history, and the Decision Log is where
	// history lives — leaving it here would make the section permanent and
	// teach its reader to skip it, which is the failure the section exists to
	// avoid.
	const open = threads.filter(
		(t) => t.root.kind === "BLOCKER" && t.root.status === "OPEN",
	);
	if (open.length === 0) {
		return null;
	}

	const settleBlocker = (thread: TopicDecisionThread, answer: string) => {
		const questionId = thread.root.questionId;
		const text = answer.trim();
		if (!questionId || text.length === 0) {
			return;
		}
		settle.mutate({
			projectId,
			topicId,
			organizationId,
			questionId,
			kind: "BLOCKER",
			answer: text,
			// MANUAL always. `answerSource` measures whether people accept the
			// AI's RECOMMENDATION, and a blocker carries none — there is nothing
			// to recommend about a thing that does not exist yet.
			answerSource: "MANUAL",
		});
	};

	return (
		<section
			className="space-y-2"
			aria-label="Before this can be published"
		>
			<h3 className="publishing-label">Before this can be published</h3>
			<ul className="space-y-2">
				{open.map((thread) => {
					const root = thread.root;
					const label =
						BLOCKER_LABELS[root.decisionKind ?? "OTHER"] ??
						BLOCKER_LABELS.OTHER;
					const isEditing = openId === root.id;
					return (
						<li
							key={root.id}
							className="rounded-lg border border-highlight/40 bg-highlight/10 px-3 py-2"
						>
							<p className="flex flex-wrap items-center gap-2">
								<span className="rounded-full border border-highlight/50 px-2 py-0.5 font-medium text-[10px] text-foreground uppercase tracking-[0.14em]">
									{label}
								</span>
								<span className="font-medium text-foreground text-sm">
									{root.summary ?? root.content ?? ""}
								</span>
							</p>
							{root.whyItMatters ? (
								<p className="publishing-prose mt-1">
									{root.whyItMatters}
								</p>
							) : null}
							{canEdit ? (
								isEditing ? (
									<div className="mt-2 space-y-2">
										<Textarea
											value={draft}
											onChange={(e) =>
												setDraft(e.target.value)
											}
											rows={2}
											aria-label="How this was cleared"
											placeholder="Where it came from, or who provided it…"
											disabled={settle.isPending}
										/>
										<div className="flex items-center justify-end gap-2">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={settle.isPending}
												onClick={() => setOpenId(null)}
											>
												Cancel
											</Button>
											<Button
												type="button"
												size="sm"
												disabled={
													settle.isPending ||
													draft.trim().length === 0
												}
												onClick={() =>
													settleBlocker(thread, draft)
												}
											>
												Mark provided
											</Button>
										</div>
									</div>
								) : (
									<div className="mt-2 flex flex-wrap items-center gap-2">
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => {
												setOpenId(root.id);
												setDraft(
													liveAnswerReply(thread)
														?.content ?? "",
												);
											}}
										>
											Mark provided
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={settle.isPending}
											onClick={() =>
												settleBlocker(
													thread,
													NOT_NEEDED_ANSWER,
												)
											}
										>
											Not needed
										</Button>
									</div>
								)
							) : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
