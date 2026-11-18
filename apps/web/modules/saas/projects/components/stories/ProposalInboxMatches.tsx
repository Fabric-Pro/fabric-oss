"use client";

/**
 * "Similar items waiting in the Proposal Inbox" — part of the manual create
 * dialog's duplicate step. Lists unreviewed inbox items whose content is
 * close to what the person typed, each with its similarity, and offers two
 * explicit actions per item: merge the typed text into that item instead of
 * creating a new one, or move that inbox item to Rejected (recoverable from
 * the Rejected list). Nothing happens unless the person picks an action;
 * "Create new anyway" and "Back" stay with the parent step.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ArchiveIcon, Loader2Icon, MergeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { PROPOSAL_SOURCE_LABELS } from "../../lib/stories/proposal-source-labels";
import { similarityPercent } from "./proposal-duplicate-flags";
import { invalidateProposalInboxQueries } from "./proposal-inbox-client";

/** One entry of `checkDuplicate`'s `proposalMatches`. */
export type ProposalInboxMatch = {
	proposalId: string;
	changeIndex: number;
	title: string;
	summary: string;
	source: string;
	similarity: number;
};

type PendingAction = { key: string; kind: "merge" | "reject" };

const matchKey = (match: ProposalInboxMatch) =>
	`${match.proposalId}:${match.changeIndex}`;

type Props = {
	matches: ProposalInboxMatch[];
	projectId: string;
	organizationId: string | null;
	/** The typed description, merged into the chosen inbox item. */
	description: string;
	/** The draft has files, which a merge into an inbox item cannot carry. */
	hasAttachments?: boolean;
	/** Another step action is running: every action here is disabled. */
	disabled?: boolean;
	/** The text was merged; the parent closes the dialog without creating. */
	onMerged: () => void;
};

export function ProposalInboxMatches({
	matches,
	projectId,
	organizationId,
	description,
	hasAttachments = false,
	disabled = false,
	onMerged,
}: Props) {
	const t = useTranslations("projects.stories.create.duplicateWarning.inbox");
	const headingId = useId();
	const queryClient = useQueryClient();
	const [rejectedKeys, setRejectedKeys] = useState<Set<string>>(
		() => new Set(),
	);
	const [pending, setPending] = useState<PendingAction | null>(null);
	const [status, setStatus] = useState<{
		text: string;
		error: boolean;
	} | null>(null);

	const mergeMutation = useMutation({
		mutationFn: (match: ProposalInboxMatch) =>
			orpcClient.projects.backlog.proposals.mergeIntoItem({
				projectId,
				organizationId,
				proposalId: match.proposalId,
				changeIndex: match.changeIndex,
				description,
			}),
		onMutate: (match) => {
			setPending({ key: matchKey(match), kind: "merge" });
			setStatus(null);
		},
		onSuccess: (_result, match) => {
			invalidateProposalInboxQueries(
				queryClient,
				projectId,
				organizationId,
			);
			toast.success(t("mergedToast", { title: match.title }));
			onMerged();
		},
		onError: () => setStatus({ text: t("mergeError"), error: true }),
		onSettled: () => setPending(null),
	});

	const rejectMutation = useMutation({
		mutationFn: (match: ProposalInboxMatch) =>
			orpcClient.projects.backlog.proposals.rejectItem({
				projectId,
				organizationId,
				proposalId: match.proposalId,
				changeIndex: match.changeIndex,
			}),
		onMutate: (match) => {
			setPending({ key: matchKey(match), kind: "reject" });
			setStatus(null);
		},
		onSuccess: (_result, match) => {
			invalidateProposalInboxQueries(
				queryClient,
				projectId,
				organizationId,
			);
			setRejectedKeys((prev) => new Set(prev).add(matchKey(match)));
			setStatus({
				text: t("rejectedStatus", { title: match.title }),
				error: false,
			});
		},
		onError: () => setStatus({ text: t("rejectError"), error: true }),
		onSettled: () => setPending(null),
	});

	const visible = matches.filter(
		(match) => !rejectedKeys.has(matchKey(match)),
	);
	const busy = disabled || pending !== null;

	return (
		<section aria-labelledby={headingId} className="min-w-0 space-y-2">
			<h3 id={headingId} className="font-medium text-sm">
				{t("title")}
			</h3>
			<p className="text-muted-foreground text-xs">{t("body")}</p>
			{hasAttachments && (
				<p className="text-muted-foreground text-xs">
					{t("attachmentsNotMerged")}
				</p>
			)}
			{visible.length > 0 && (
				<ul className="space-y-1.5">
					{visible.map((match) => {
						const key = matchKey(match);
						const source = PROPOSAL_SOURCE_LABELS[match.source];
						return (
							<li
								key={key}
								className="min-w-0 space-y-2 rounded-md border p-2 text-sm"
							>
								<div className="flex min-w-0 items-center gap-2">
									<span className="min-w-0 flex-1 truncate">
										{match.title}
									</span>
									<Badge variant="outline">
										{t("similarity", {
											percent: similarityPercent(
												match.similarity,
											),
										})}
									</Badge>
								</div>
								{(source || match.summary) && (
									<p className="truncate text-muted-foreground text-xs">
										{[source, match.summary]
											.filter(Boolean)
											.join(" · ")}
									</p>
								)}
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										size="sm"
										variant="outline"
										className="h-7 px-2 text-xs"
										disabled={busy}
										aria-label={t("mergeLabel", {
											title: match.title,
										})}
										onClick={() =>
											mergeMutation.mutate(match)
										}
									>
										{pending?.key === key &&
										pending.kind === "merge" ? (
											<Loader2Icon
												aria-hidden="true"
												className="size-3.5 motion-safe:animate-spin"
											/>
										) : (
											<MergeIcon
												aria-hidden="true"
												className="size-3.5"
											/>
										)}
										{t("merge")}
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										className="h-7 px-2 text-xs"
										disabled={busy}
										aria-label={t("rejectLabel", {
											title: match.title,
										})}
										onClick={() =>
											rejectMutation.mutate(match)
										}
									>
										{pending?.key === key &&
										pending.kind === "reject" ? (
											<Loader2Icon
												aria-hidden="true"
												className="size-3.5 motion-safe:animate-spin"
											/>
										) : (
											<ArchiveIcon
												aria-hidden="true"
												className="size-3.5"
											/>
										)}
										{t("reject")}
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<output aria-live="polite" className="block min-h-4">
				{status && (
					<span
						className={cn(
							"text-xs",
							status.error
								? "text-destructive"
								: "text-muted-foreground",
						)}
					>
						{status.text}
					</span>
				)}
			</output>
		</section>
	);
}
