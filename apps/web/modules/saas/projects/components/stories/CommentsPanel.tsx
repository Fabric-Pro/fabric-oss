"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { groupCommentsIntoThreads } from "@saas/projects/lib/comment-threading";
import { evaluateLargeGroupConfirm } from "@saas/projects/lib/group-mention-confirm";
import { getPendingFabricCommentIds } from "@saas/projects/lib/pending-fabric-comments";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { BotIcon, Loader2Icon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface CommentsPanelProps {
	projectId: string;
	storyId: string;
	taskId?: string;
	organizationId?: string | null;
	className?: string;
}

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

type CommentItem = {
	id: string;
	content: string;
	authorType: "USER" | "AGENT";
	parentId?: string | null;
	sourceCommentId?: string | null;
	workflowId?: string | null;
	createdAt: string | Date;
	metadata?: Record<string, unknown> | null;
	author: {
		name?: string | null;
		email?: string | null;
		image?: string | null;
	};
};

/**
 * True when the agent reply was persisted as a failure (the workflow set
 * `metadata.status = "failed"`). Falls back to a string-prefix match for
 * older replies that predate the metadata field.
 */
function isFailedAgentReply(comment: CommentItem) {
	const metaStatus =
		typeof comment.metadata === "object" &&
		comment.metadata !== null &&
		!Array.isArray(comment.metadata)
			? (comment.metadata as Record<string, unknown>).status
			: undefined;
	if (metaStatus === "failed") {
		return true;
	}
	return comment.content.startsWith("I couldn't generate a reply:");
}

function CommentRow({
	comment,
	isReply,
	onReply,
}: {
	comment: CommentItem;
	isReply?: boolean;
	onReply?: () => void;
}) {
	const isAgent = comment.authorType === "AGENT";
	const displayName = comment.author.name || comment.author.email || "User";
	return (
		<div id={`comment-${comment.id}`} className="group flex gap-3">
			<Avatar className={isReply ? "size-6" : "size-8"}>
				{isAgent ? null : (
					<AvatarImage src={comment.author.image ?? undefined} />
				)}
				<AvatarFallback
					className={
						isAgent ? "bg-primary/10 text-primary" : undefined
					}
				>
					{isAgent ? (
						<BotIcon className="size-4" />
					) : (
						initials(comment.author.name, comment.author.email)
					)}
				</AvatarFallback>
			</Avatar>
			<div className="min-w-0 flex-1 rounded-lg bg-background p-3 shadow-sm">
				<div className="mb-1 flex flex-wrap items-center gap-2">
					<span className="font-medium text-sm">
						{isAgent ? "Fabric Agent" : displayName}
					</span>
					{isAgent && <Badge variant="secondary">Agent</Badge>}
					<span className="text-xs text-muted-foreground">
						{formatTime(comment.createdAt)}
					</span>
				</div>
				<p className="whitespace-pre-wrap text-sm leading-relaxed">
					{comment.content}
				</p>
				{!isAgent && onReply && (
					<button
						type="button"
						onClick={onReply}
						aria-label={`Reply to ${displayName}`}
						className="mt-1 text-muted-foreground text-xs opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
					>
						Reply
					</button>
				)}
			</div>
		</div>
	);
}

export function CommentsPanel({
	projectId,
	storyId,
	taskId,
	organizationId,
	className,
}: CommentsPanelProps) {
	const { organizationId: ambientOrganizationId } = useOrganizationContext();
	// Explicit prop (including `null` for personal context) wins; `undefined`
	// (prop omitted, e.g. TaskModal) falls back to ambient. Do NOT use `??` here
	// — that would let an explicit `null` fall through to ambient.
	const effectiveOrganizationId =
		organizationId !== undefined ? organizationId : ambientOrganizationId;
	const queryClient = useQueryClient();
	const [content, setContent] = useState("");
	const [replyingTo, setReplyingTo] = useState<CommentItem | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// Enter reply mode and move focus to the composer (spec a11y requirement).
	// The composer is always mounted, so focusing the existing element after
	// the state update is safe and synchronous.
	const handleReply = (comment: CommentItem) => {
		setReplyingTo(comment);
		textareaRef.current?.focus();
	};
	const baseInput = useMemo(
		() => ({
			projectId,
			storyId,
			organizationId: effectiveOrganizationId ?? null,
		}),
		[effectiveOrganizationId, projectId, storyId],
	);

	const commentsQuery = taskId
		? orpc.projects.stories.tasks.comments.list.queryOptions({
				input: { ...baseInput, taskId },
			})
		: orpc.projects.stories.comments.list.queryOptions({
				input: baseInput,
			});

	const previousPendingIdsRef = useRef<Set<string>>(new Set());
	const { data, isLoading } = useQuery({
		...commentsQuery,
		refetchInterval: (query) => {
			const queryComments =
				((query.state.data as { comments?: CommentItem[] } | undefined)
					?.comments as CommentItem[] | undefined) ?? [];
			return getPendingFabricCommentIds(queryComments).length > 0
				? 3000
				: false;
		},
	});
	const comments = (data?.comments ?? []) as CommentItem[];
	const threads = useMemo(
		() => groupCommentsIntoThreads(comments),
		[comments],
	);
	const pendingFabricCommentIds = useMemo(
		() => getPendingFabricCommentIds(comments),
		[comments],
	);

	useEffect(() => {
		const previousPendingIds = previousPendingIdsRef.current;
		for (const reply of comments) {
			if (
				reply.authorType === "AGENT" &&
				reply.sourceCommentId &&
				previousPendingIds.has(reply.sourceCommentId)
			) {
				if (isFailedAgentReply(reply)) {
					toast.error("Fabric Agent couldn't generate a reply");
				} else {
					toast.success("Fabric Agent replied in this thread");
				}
			}
		}
		previousPendingIdsRef.current = new Set(pendingFabricCommentIds);
	}, [comments, pendingFabricCommentIds]);

	const createMutation = useMutation({
		mutationFn: async () => {
			const parentId = replyingTo?.id;
			return taskId
				? orpc.projects.stories.tasks.comments.create.call({
						...baseInput,
						taskId,
						content,
						parentId,
					})
				: orpc.projects.stories.comments.create.call({
						...baseInput,
						content,
						parentId,
					});
		},
		onSuccess: (result) => {
			setContent("");
			setReplyingTo(null);
			queryClient.invalidateQueries({ queryKey: commentsQuery.queryKey });
			if (result.fabricMentionQueued) {
				toast.success("Fabric Agent is replying in this thread");
			}
		},
		onError: () => {
			toast.error("Could not save comment");
		},
	});

	// Large-group confirm gate (#1767 Stage 5). Advisory and fail-open: a
	// failed counts fetch must never block sending the comment, and a comment
	// with no `@@` token must not trigger any extra request.
	const [largeGroupConfirm, setLargeGroupConfirm] = useState<{
		maxCount: number;
	} | null>(null);
	const [isCheckingGroupSize, setIsCheckingGroupSize] = useState(false);

	const handleSubmit = async () => {
		if (content.includes("@@")) {
			setIsCheckingGroupSize(true);
			try {
				const counts = await orpc.functionTags.groupMemberCounts.call({
					projectId: baseInput.projectId,
				});
				const { needsConfirm, maxCount } = evaluateLargeGroupConfirm(
					content,
					counts,
				);
				if (needsConfirm) {
					setLargeGroupConfirm({ maxCount });
					return;
				}
			} catch (error) {
				console.error("Failed to fetch group member counts:", error);
				// Fail-open — the confirm is advisory, never a blocker.
			} finally {
				setIsCheckingGroupSize(false);
			}
		}
		createMutation.mutate();
	};

	return (
		<div className={className}>
			<div className="mb-3 flex items-center justify-between">
				<div>
					<h3 className="font-medium text-sm">Comments</h3>
					<p className="text-xs text-muted-foreground">
						Mention @fabric to get an in-thread agent reply.
					</p>
				</div>
				<Badge variant="outline">{comments.length}</Badge>
			</div>

			<div className="space-y-3 rounded-lg border bg-muted/20 p-3">
				{isLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2Icon className="size-4 animate-spin" />
						Loading comments…
					</div>
				) : comments.length === 0 ? (
					<p className="py-4 text-center text-sm text-muted-foreground">
						No comments yet.
					</p>
				) : (
					threads.map((thread) => (
						<div key={thread.id} data-thread className="space-y-2">
							<CommentRow
								comment={thread}
								onReply={() => handleReply(thread)}
							/>
							{thread.replies.length > 0 && (
								<div className="ml-4 space-y-2 border-l border-border pl-4">
									{thread.replies.map((reply) => (
										<CommentRow
											key={reply.id}
											comment={reply}
											isReply
											onReply={() => handleReply(reply)}
										/>
									))}
								</div>
							)}
						</div>
					))
				)}

				{pendingFabricCommentIds.length > 0 && (
					<div className="flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-primary text-sm">
						<Loader2Icon className="size-4 animate-spin" />
						Fabric Agent is drafting a reply…
					</div>
				)}

				<div className="space-y-2 border-t pt-3">
					{replyingTo && (
						<div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-xs">
							<span className="text-muted-foreground">
								Replying to{" "}
								<span className="font-medium text-foreground">
									{replyingTo.author.name ||
										replyingTo.author.email ||
										"User"}
								</span>
							</span>
							<Button
								variant="ghost"
								size="sm"
								aria-label="Cancel reply"
								className="h-auto p-1 text-muted-foreground"
								onClick={() => setReplyingTo(null)}
							>
								<XIcon className="size-3.5" />
							</Button>
						</div>
					)}
					<Textarea
						ref={textareaRef}
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder={
							replyingTo
								? `Reply to ${replyingTo.author.name || replyingTo.author.email || "User"}…`
								: "Add a comment, or ask @fabric a question…"
						}
						className="min-h-20 bg-background"
					/>
					<div className="flex justify-end">
						<Button
							size="sm"
							onClick={() => handleSubmit()}
							disabled={
								!content.trim() ||
								createMutation.isPending ||
								isCheckingGroupSize
							}
						>
							{createMutation.isPending || isCheckingGroupSize ? (
								<Loader2Icon className="mr-2 size-4 animate-spin" />
							) : (
								<SendIcon className="mr-2 size-4" />
							)}
							{replyingTo ? "Reply" : "Comment"}
						</Button>
					</div>
				</div>
			</div>

			<AlertDialog
				open={largeGroupConfirm !== null}
				onOpenChange={(open) => {
					if (!open) {
						setLargeGroupConfirm(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{`Notify ${largeGroupConfirm?.maxCount ?? 0} people?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							This comment addresses a large function-tag group.
							Everyone in that group will be notified.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								e.preventDefault();
								setLargeGroupConfirm(null);
								createMutation.mutate();
							}}
						>
							Notify
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
