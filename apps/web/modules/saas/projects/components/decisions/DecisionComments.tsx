"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	InfoIcon,
	Loader2Icon,
	MessageSquareIcon,
	SendIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";

function initials(name?: string | null, email?: string | null) {
	const source = name || email || "User";
	return source
		.split(/\s+/)
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

function formatTime(value: string | Date) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(value instanceof Date ? value : new Date(value));
}

type Props = {
	projectId: string;
	architectureDecisionId: string;
};

export function DecisionComments({ projectId, architectureDecisionId }: Props) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.decisions");
	const [content, setContent] = useState("");
	const [replyTo, setReplyTo] = useState<string | null>(null);

	const input = useMemo(
		() => ({
			projectId,
			architectureDecisionId,
			organizationId: organizationId ?? null,
		}),
		[projectId, architectureDecisionId, organizationId],
	);

	const { data, isLoading } = useQuery(
		orpc.projects.architectureDecisions.comments.list.queryOptions({
			input,
		}),
	);
	const comments = data?.comments ?? [];
	type CommentItem = (typeof comments)[number];

	const topLevel = useMemo(
		() => comments.filter((c) => !c.parentId),
		[comments],
	);
	const repliesByParent = useMemo(() => {
		const map = new Map<string, CommentItem[]>();
		for (const c of comments) {
			if (c.parentId) {
				const arr = map.get(c.parentId) ?? [];
				arr.push(c);
				map.set(c.parentId, arr);
			}
		}
		return map;
	}, [comments]);

	const createMutation = useMutation(
		orpc.projects.architectureDecisions.comments.create.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.architectureDecisions.comments.list.queryKey(
							{ input },
						),
				});
				setContent("");
				setReplyTo(null);
			},
			onError: (error) => {
				toast.error(`Failed to add comment: ${error.message}`);
			},
		}),
	);

	const submit = () => {
		const trimmed = content.trim();
		if (!trimmed) {
			return;
		}
		createMutation.mutate({
			projectId,
			architectureDecisionId,
			content: trimmed,
			parentId: replyTo,
			organizationId,
		});
	};

	const renderComment = (comment: CommentItem, isReply = false) => (
		<div
			key={comment.id}
			className={cn("flex gap-3", isReply && "ml-10 mt-3")}
		>
			<Avatar className="size-8 shrink-0">
				<AvatarImage src={comment.author.image ?? undefined} />
				<AvatarFallback className="text-xs">
					{initials(comment.author.name, comment.author.email)}
				</AvatarFallback>
			</Avatar>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="font-medium text-sm">
						{comment.author.name || comment.author.email || "User"}
					</span>
					<span className="text-muted-foreground text-xs">
						{formatTime(comment.createdAt)}
					</span>
					{comment.decisionVersion != null && (
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
									v{comment.decisionVersion}
									{/* The chip is not focusable, so the tooltip is
										pointer-only. Repeating the copy in an `sr-only`
										child keeps the parity the native `title` gave as
										an accessible description. `aria-label` would
										replace the visible "v3" in the name. */}
									<span className="sr-only">
										{t("postedOnVersion", {
											version: comment.decisionVersion,
										})}
									</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>
								{t("postedOnVersion", {
									version: comment.decisionVersion,
								})}
							</TooltipContent>
						</Tooltip>
					)}
				</div>
				<p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground/90">
					{comment.content}
				</p>
				{!isReply && (
					<button
						type="button"
						onClick={() =>
							setReplyTo(
								replyTo === comment.id ? null : comment.id,
							)
						}
						className="mt-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
					>
						{replyTo === comment.id ? "Cancel reply" : "Reply"}
					</button>
				)}
			</div>
		</div>
	);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-muted-foreground text-xs">
				<InfoIcon className="size-3.5 shrink-0" />
				<span>
					Comments are team discussion — they aren't part of the AI
					context.
				</span>
			</div>
			{isLoading ? (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader2Icon className="size-4 animate-spin" />
					Loading comments…
				</div>
			) : comments.length === 0 ? (
				<div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
					<MessageSquareIcon className="size-6 opacity-50" />
					<p className="text-sm">No comments yet.</p>
				</div>
			) : (
				<div className="space-y-4">
					{topLevel.map((comment) => (
						<div key={comment.id}>
							{renderComment(comment)}
							{(repliesByParent.get(comment.id) ?? []).map(
								(reply) => renderComment(reply, true),
							)}
						</div>
					))}
				</div>
			)}

			<div className="space-y-2 border-t pt-4">
				{replyTo && (
					<p className="text-muted-foreground text-xs">
						Replying to a comment ·{" "}
						<button
							type="button"
							className="underline"
							onClick={() => setReplyTo(null)}
						>
							cancel
						</button>
					</p>
				)}
				<Textarea
					value={content}
					onChange={(e) => setContent(e.target.value)}
					placeholder="Add a comment…"
					rows={3}
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							submit();
						}
					}}
				/>
				<div className="flex justify-end">
					<Button
						size="sm"
						onClick={submit}
						disabled={!content.trim() || createMutation.isPending}
					>
						{createMutation.isPending ? (
							<Loader2Icon className="size-4 animate-spin" />
						) : (
							<SendIcon className="size-4" />
						)}
						<span className="ml-2">Comment</span>
					</Button>
				</div>
			</div>
		</div>
	);
}
