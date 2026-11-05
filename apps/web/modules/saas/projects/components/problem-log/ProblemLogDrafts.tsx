"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { useState } from "react";
import { toast } from "sonner";
import {
	CATEGORY_LABEL,
	CONTEXT_CATEGORIES,
	type ContextProblemCategory,
	REVIEW_SEVERITIES,
	type ReviewSeverity,
	SEVERITY_CONFIG,
} from "./constants";

type Draft = {
	id: string;
	title: string;
	description: string | null;
	category: string;
	severity: string;
	sourceQuote: string | null;
	metadata: unknown;
};

/**
 * Problems Fabric drafted from this project's meetings (Fizzy #2277). None is
 * a log item until a manager confirms it; a dismissed draft never returns.
 */
export function ProblemLogDrafts({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}) {
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState<Draft | null>(null);

	const draftsQuery = useQuery(
		orpc.problemLog.list.queryOptions({
			input: {
				projectId,
				organizationId,
				reviewState: "PENDING",
				limit: 20,
			},
		}),
	);

	const reviewMutation = useMutation(
		orpc.problemLog.review.mutationOptions({
			onSuccess: (_data, variables) => {
				setEditing(null);
				toast.success(
					variables.decision === "CONFIRM"
						? "Added to the Problem Log"
						: "Draft dismissed",
				);
				queryClient.invalidateQueries({
					queryKey: orpc.problemLog.key(),
				});
			},
			onError: (error) =>
				toast.error(`Could not review the draft: ${error.message}`),
		}),
	);

	const drafts = (draftsQuery.data?.items ?? []) as Draft[];
	if (drafts.length === 0) {
		return null;
	}

	const review = (
		entryId: string,
		decision: "CONFIRM" | "DISMISS",
		edits?: {
			title: string;
			description: string | null;
			category: ContextProblemCategory;
			severity: ReviewSeverity;
		},
	) =>
		reviewMutation.mutate({
			projectId,
			organizationId,
			entryId,
			decision,
			edits,
		});

	return (
		<section
			aria-labelledby="problem-log-drafts-heading"
			className="rounded-lg border border-dashed p-3"
		>
			<h3 id="problem-log-drafts-heading" className="font-medium text-sm">
				Drafted from meetings · {drafts.length}
				{draftsQuery.data?.nextCursor ? "+" : ""} to review
			</h3>
			<p className="text-muted-foreground text-xs">
				Issues, blockers and risks Fabric found in meeting transcripts.
				Confirm to add one to the log, edit it first, or dismiss it.
			</p>
			<ul className="mt-3 space-y-2">
				{drafts.map((draft) => (
					<li
						key={draft.id}
						className="flex flex-col gap-2 rounded-md border p-2.5 sm:flex-row sm:items-start sm:justify-between"
					>
						<div className="min-w-0">
							<div className="break-words font-medium text-sm">
								{draft.title}
							</div>
							<div className="text-muted-foreground text-xs">
								{CATEGORY_LABEL[
									draft.category as ContextProblemCategory
								] ?? draft.category}
								{meetingLabel(draft.metadata)}
							</div>
							{draft.sourceQuote && (
								<blockquote className="mt-1 border-l-2 pl-2 text-muted-foreground text-xs italic">
									“{draft.sourceQuote}”
								</blockquote>
							)}
						</div>
						<div className="flex shrink-0 gap-1.5">
							<Button
								size="sm"
								onClick={() => review(draft.id, "CONFIRM")}
								disabled={reviewMutation.isPending}
								aria-label={`Confirm: ${draft.title}`}
							>
								Confirm
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setEditing(draft)}
								disabled={reviewMutation.isPending}
								aria-label={`Edit: ${draft.title}`}
							>
								Edit
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => review(draft.id, "DISMISS")}
								disabled={reviewMutation.isPending}
								aria-label={`Dismiss: ${draft.title}`}
							>
								Dismiss
							</Button>
						</div>
					</li>
				))}
			</ul>

			{editing && (
				<EditDraftDialog
					draft={editing}
					saving={reviewMutation.isPending}
					onCancel={() => setEditing(null)}
					onConfirm={(edits) => review(editing.id, "CONFIRM", edits)}
				/>
			)}
		</section>
	);
}

function EditDraftDialog({
	draft,
	saving,
	onCancel,
	onConfirm,
}: {
	draft: Draft;
	saving: boolean;
	onCancel: () => void;
	onConfirm: (edits: {
		title: string;
		description: string | null;
		category: ContextProblemCategory;
		severity: ReviewSeverity;
	}) => void;
}) {
	const [title, setTitle] = useState(draft.title);
	const [description, setDescription] = useState(draft.description ?? "");
	const [category, setCategory] = useState<ContextProblemCategory>(
		CONTEXT_CATEGORIES.includes(draft.category as ContextProblemCategory)
			? (draft.category as ContextProblemCategory)
			: "PROJECT_ISSUE",
	);
	const [severity, setSeverity] = useState<ReviewSeverity>(
		REVIEW_SEVERITIES.includes(draft.severity as ReviewSeverity)
			? (draft.severity as ReviewSeverity)
			: "WARNING",
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit and confirm</DialogTitle>
					<DialogDescription>
						The confirmed entry keeps your wording, not the draft's.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						onConfirm({
							title: title.trim(),
							description: description.trim() || null,
							category,
							severity,
						});
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor="problem-draft-title">Title</Label>
						<Input
							id="problem-draft-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={300}
							required
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="problem-draft-description">
							Description
						</Label>
						<Textarea
							id="problem-draft-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							maxLength={4000}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="problem-draft-category">
								Category
							</Label>
							<Select
								value={category}
								onValueChange={(v) =>
									setCategory(v as ContextProblemCategory)
								}
							>
								<SelectTrigger id="problem-draft-category">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CONTEXT_CATEGORIES.map((c) => (
										<SelectItem key={c} value={c}>
											{CATEGORY_LABEL[c]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="problem-draft-severity">
								Severity
							</Label>
							<Select
								value={severity}
								onValueChange={(v) =>
									setSeverity(v as ReviewSeverity)
								}
							>
								<SelectTrigger id="problem-draft-severity">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{REVIEW_SEVERITIES.map((s) => (
										<SelectItem key={s} value={s}>
											{SEVERITY_CONFIG[s].label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onCancel}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							loading={saving}
							disabled={!title.trim()}
						>
							Confirm
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function meetingLabel(metadata: unknown): string {
	const subject =
		metadata && typeof metadata === "object" && "meetingSubject" in metadata
			? (metadata as { meetingSubject?: unknown }).meetingSubject
			: null;
	return typeof subject === "string" && subject ? ` · ${subject}` : "";
}
