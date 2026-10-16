"use client";

import {
	PAGE_COMMENT_MAX_CHARS,
	PAGE_LIST_DEFAULT,
} from "@repo/utils/page-limits";
import { callFabricTool } from "@saas/mcp/lib/fabric-tool-client";
import { isBusyError, userMessageOf } from "@saas/shared/lib/user-message-of";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";
import {
	PageCommentListSchema,
	pageCommentsKey,
} from "../lib/workspace-comments";

/** The counter appears once a comment is long enough that the limit is worth knowing. */
const COUNTER_FROM = Math.floor(PAGE_COMMENT_MAX_CHARS * 0.8);

/** Pages read to reach the newest comment after adding one; a thread longer than this shows the rest on request. */
const PAGES_TO_NEWEST = 10;

/**
 * What people have said about a Workspace page, oldest first, and a place to
 * add to it below. Comments are kept with the page through its own tools
 * (`fabric_page_comment_list` and `fabric_page_comment_add`), so what is shown
 * here is what Fabric Agent reads too. Anyone who can open the page can read
 * and add; each comment carries the name Fabric stamped on it, not one the
 * writer chose.
 */
export function WorkspaceComments({
	frameId,
	organizationId,
}: {
	frameId: string;
	organizationId: string;
}) {
	const [draft, setDraft] = useState("");
	const queryKey = pageCommentsKey(organizationId, frameId);

	const comments = useInfiniteQuery({
		queryKey,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) =>
			callFabricTool(
				"fabric_page_comment_list",
				{
					frameId,
					limit: PAGE_LIST_DEFAULT,
					...(pageParam ? { cursor: pageParam } : {}),
				},
				{
					organizationId,
					signal,
					schema: PageCommentListSchema,
				},
			),
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});

	// A comment goes on the end, which a long thread has not loaded: read on
	// until the person can see theirs.
	const showNewest = async () => {
		const refreshed = await comments.refetch();
		let cursor = refreshed.data?.pages.at(-1)?.nextCursor;
		for (let page = 0; cursor && page < PAGES_TO_NEWEST; page++) {
			const next = await comments.fetchNextPage();
			cursor = next.data?.pages.at(-1)?.nextCursor;
		}
	};

	const add = useMutation({
		mutationFn: (text: string) =>
			callFabricTool(
				"fabric_page_comment_add",
				{ frameId, text },
				{ organizationId },
			),
		onSuccess: async () => {
			setDraft("");
			toast.success("Comment added");
			await showNewest();
		},
		onError: (error) => {
			if (isBusyError(error)) {
				toast.message("The page is busy", {
					description: "Try again in a moment.",
				});
				return;
			}
			toast.error("Could not add your comment", {
				description: userMessageOf(error, "Please try again."),
			});
		},
	});

	const entries = comments.data?.pages.flatMap((page) => page.comments) ?? [];
	const trimmed = draft.trim();
	// A refresh or the next page that fails leaves the comments already read on
	// screen, with a way to try again beside them.
	const failedWithComments = comments.isError && entries.length > 0;

	return (
		<section
			aria-labelledby="workspace-comments-heading"
			className="space-y-4"
		>
			<h2 id="workspace-comments-heading" className="app-editorial-label">
				Comments
			</h2>

			{comments.isLoading ? (
				<output
					className="block space-y-3"
					aria-label="Loading comments"
				>
					{[0, 1].map((key) => (
						<Skeleton key={key} className="h-16 rounded-lg" />
					))}
				</output>
			) : comments.isError && entries.length === 0 ? (
				<div className="flex items-center justify-between gap-3">
					<p role="alert" className="text-sm text-destructive">
						The comments could not be loaded.
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => comments.refetch()}
					>
						Try again
					</Button>
				</div>
			) : entries.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No comments yet. Anyone who can open this page can start.
				</p>
			) : (
				<>
					<ul className="space-y-3">
						{entries.map((comment) => (
							<li
								key={comment.id}
								className="rounded-lg border border-border bg-card p-4"
							>
								<p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
									<span className="text-sm font-medium text-foreground">
										{comment.author.name}
									</span>
									<time dateTime={comment.at}>
										{formatDistanceToNow(
											new Date(comment.at),
											{
												addSuffix: true,
											},
										)}
									</time>
								</p>
								<p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
									{comment.text}
								</p>
							</li>
						))}
					</ul>
					{failedWithComments ? (
						<div className="flex items-center justify-between gap-3">
							<p
								role="alert"
								className="text-sm text-destructive"
							>
								{comments.isFetchNextPageError
									? "More comments could not be loaded."
									: "The comments could not be refreshed."}
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									comments.isFetchNextPageError
										? comments.fetchNextPage()
										: comments.refetch()
								}
							>
								Try again
							</Button>
						</div>
					) : comments.hasNextPage ? (
						<Button
							variant="outline"
							size="sm"
							loading={comments.isFetchingNextPage}
							onClick={() => comments.fetchNextPage()}
						>
							Show more comments
						</Button>
					) : null}
				</>
			)}

			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (trimmed && !add.isPending) {
						add.mutate(trimmed);
					}
				}}
			>
				<Label htmlFor="workspace-comment-draft" className="sr-only">
					Add a comment
				</Label>
				<Textarea
					id="workspace-comment-draft"
					value={draft}
					maxLength={PAGE_COMMENT_MAX_CHARS}
					placeholder="Add a comment"
					onChange={(event) => setDraft(event.target.value)}
				/>
				<div className="flex items-center justify-end gap-3">
					{draft.length >= COUNTER_FROM ? (
						<span className="text-xs text-muted-foreground">
							{draft.length} / {PAGE_COMMENT_MAX_CHARS}
						</span>
					) : null}
					<Button
						type="submit"
						size="sm"
						loading={add.isPending}
						disabled={!trimmed}
					>
						Comment
					</Button>
				</div>
			</form>
		</section>
	);
}
