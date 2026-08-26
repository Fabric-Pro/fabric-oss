"use client";

/**
 * "Session history" for the AI Update window — a read-only log of past AI
 * Backlog Update runs, opened from inside the AI Update (BacklogChat) window.
 *
 * Two views in one dialog:
 *  - List: the last 10 sessions ("Show more" to page), newest first. The list
 *    live-polls while a run is still "Applying…" so its status flips to
 *    Applied / Failed without a manual refresh.
 *  - Detail (click a session): the entire preserved conversation replayed as a
 *    read-only chat — message bubbles and a Results card that links each created /
 *    updated ticket (F-XXX → opens in a new tab).
 *
 * Tied to AI Updates only (the `BacklogUpdateSession` store), distinct from the
 * roadmap-wide Change-history (audit) window.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftIcon,
	ChevronRightIcon,
	CircleStopIcon,
	ExternalLinkIcon,
	FilePlus2Icon,
	Loader2Icon,
	PencilIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { buildStoryDetailsRoute } from "../../lib/stories/routes";
import {
	HistoryEmptyState,
	HistoryError,
	HistoryLoading,
	HistoryTimestamp,
} from "./BacklogHistoryShared";

const PAGE_SIZE = 10;
/** Poll cadence while a run is still mid-apply, so its status flips live. */
const APPLYING_POLL_MS = 3000;

type AppliedTicket = {
	action: "create" | "update";
	storyId: string;
	identifier: string | null;
	title: string;
	deleted: boolean;
};

type SessionChange = { action: string; type: string; title: string };
type SessionMessage = { role: string; content: string };

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	organizationId: string | null;
	/** When opened from a deep-link, jump straight to this session's detail. */
	focusSessionId?: string | null;
};

function sessionStatusMeta(status: string): {
	label: string;
	className: string;
} {
	switch (status) {
		case "APPLIED":
			return {
				label: "Applied",
				className: "border-secondary/30 bg-secondary/15 text-secondary",
			};
		case "APPLYING":
			return {
				label: "Applying…",
				className: "border-highlight/30 bg-highlight/15 text-highlight",
			};
		case "PARTIALLY_APPLIED":
			return {
				label: "Partially applied",
				className: "border-highlight/30 bg-highlight/15 text-highlight",
			};
		case "FAILED":
			return {
				label: "Failed",
				className:
					"border-destructive/30 bg-destructive/10 text-destructive",
			};
		default:
			return {
				label: status,
				className:
					"border-foreground/10 bg-muted text-muted-foreground",
			};
	}
}

/** Replay the captured transcript as read-only chat bubbles. */
function SessionConversation({ messages }: { messages: SessionMessage[] }) {
	return (
		<div>
			<p className="mb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
				Conversation
			</p>
			{messages.length > 0 ? (
				<div className="space-y-2.5">
					{messages.map((m, i) => {
						const isUser = m.role === "user";
						return (
							<div
								// Transcript is a fixed, ordered snapshot — index key is stable.
								key={i}
								className={cn(
									"flex",
									isUser ? "justify-end" : "justify-start",
								)}
							>
								<div
									className={cn(
										"max-w-[85%] rounded-2xl px-3.5 py-2",
										isUser
											? "rounded-br-sm bg-primary text-primary-foreground"
											: "rounded-bl-sm bg-muted text-foreground",
									)}
								>
									<p
										className={cn(
											"mb-0.5 font-medium text-[10px] uppercase tracking-wide",
											isUser
												? "text-primary-foreground/70"
												: "text-muted-foreground",
										)}
									>
										{isUser ? "You" : "AI"}
									</p>
									<p className="whitespace-pre-wrap text-sm leading-relaxed">
										{m.content}
									</p>
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<p className="text-muted-foreground text-xs italic">
					No conversation was captured for this session.
				</p>
			)}
		</div>
	);
}

/**
 * The result card — each ticket the session created/updated, with a link to it.
 * Prefers the audit-resolved applied tickets (with identifiers + links); falls
 * back to the proposed-change snapshot for older sessions that predate it.
 */
function SessionResults({
	appliedItems,
	changes,
	onOpenTicket,
}: {
	appliedItems: AppliedTicket[];
	changes: SessionChange[];
	onOpenTicket: (storyId: string) => void;
}) {
	const tTooltips = useTranslations("tooltips.common");
	if (appliedItems.length > 0) {
		return (
			<div>
				<p className="mb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
					Results
				</p>
				<ul className="space-y-1.5">
					{appliedItems.map((item) => {
						const Icon =
							item.action === "create"
								? FilePlus2Icon
								: PencilIcon;
						return (
							<li
								key={item.storyId}
								className="flex items-center gap-2 rounded-lg border border-foreground/10 bg-card px-3 py-2"
							>
								<Icon
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden="true"
								/>
								<span className="shrink-0 font-medium text-foreground text-xs">
									{item.action === "create"
										? "Created"
										: "Updated"}
								</span>
								{item.deleted ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<span className="shrink-0 rounded bg-muted px-1.5 py-0 font-medium text-[10px] text-muted-foreground">
												deleted
												{/* See the note on the matching chip in
													BacklogAuditDialog.tsx: the chip is not focusable, so
													the tooltip is pointer-only and this keeps the copy
													reachable by screen readers. */}
												<span className="sr-only">
													{tTooltips("ticketDeleted")}
												</span>
											</span>
										</TooltipTrigger>
										<TooltipContent>
											{tTooltips("ticketDeleted")}
										</TooltipContent>
									</Tooltip>
								) : item.identifier ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												onClick={() =>
													onOpenTicket(item.storyId)
												}
												className="inline-flex shrink-0 items-center gap-0.5 rounded font-medium font-mono text-primary text-xs hover:underline"
											>
												{item.identifier}
												<ExternalLinkIcon
													className="size-3"
													aria-hidden="true"
												/>
											</button>
										</TooltipTrigger>
										<TooltipContent>
											{tTooltips("openTicketNewTab")}
										</TooltipContent>
									</Tooltip>
								) : null}
								<span
									title={item.title}
									className={cn(
										"truncate text-sm",
										item.deleted
											? "text-muted-foreground/70 line-through"
											: "text-muted-foreground",
									)}
								>
									{item.title}
								</span>
							</li>
						);
					})}
				</ul>
			</div>
		);
	}
	if (changes.length > 0) {
		return (
			<div>
				<p className="mb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
					Proposed changes
				</p>
				<ul className="space-y-1">
					{changes.map((change, i) => (
						<li
							// Snapshot list — fixed order, index key is stable.
							key={i}
							className="text-muted-foreground text-xs"
						>
							<span className="font-medium text-foreground">
								{change.action === "create"
									? "Create"
									: "Update"}
							</span>{" "}
							<span className="capitalize">{change.type}</span>{" "}
							<span className="text-foreground">
								«{change.title}»
							</span>
						</li>
					))}
				</ul>
			</div>
		);
	}
	return null;
}

/**
 * Detail view — the entire preserved session, read-only: a Back affordance, the
 * conversation replay, and the linked Results card. Keeps polling while the run
 * is still applying so the status + results fill in.
 */
function SessionDetailView({
	projectId,
	organizationId,
	sessionId,
	onBack,
	onOpenTicket,
}: {
	projectId: string;
	organizationId: string | null;
	sessionId: string;
	onBack: () => void;
	onOpenTicket: (storyId: string) => void;
}) {
	const detail = useQuery({
		queryKey: ["backlog-session-detail", projectId, sessionId],
		queryFn: () =>
			orpcClient.projects.backlog.history.sessions.get({
				projectId,
				organizationId,
				sessionId,
			}),
		// Poll a still-applying session so its status + results land without a
		// manual refresh; stop once it reaches a terminal state.
		refetchInterval: (q) =>
			q.state.data?.status === "APPLYING" ? APPLYING_POLL_MS : false,
	});

	const queryClient = useQueryClient();
	const proposalId = detail.data?.pendingProposalId ?? null;
	const cancelMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.backlog.proposals.cancel({
				projectId,
				organizationId,
				proposalId: proposalId ?? "",
			}),
		onSuccess: (res) => {
			toast.success(res.message ?? "Apply cancelled.");
			// Flip the detail + list to their terminal state without a manual
			// refresh (the poll already stopped once status left APPLYING).
			queryClient.invalidateQueries({
				queryKey: ["backlog-session-detail", projectId, sessionId],
			});
			queryClient.invalidateQueries({
				queryKey: [
					"backlog-session-history",
					projectId,
					organizationId ?? null,
				],
			});
		},
		onError: (err) => {
			toast.error("Couldn't cancel the apply", {
				description: err instanceof Error ? err.message : undefined,
			});
		},
	});

	const status = detail.data ? sessionStatusMeta(detail.data.status) : null;
	const author =
		detail.data?.authorName ?? detail.data?.authorEmail ?? "Unknown user";
	// A still-applying run we can stop: shows the "Cancel apply" footer.
	const canCancel = detail.data?.status === "APPLYING" && proposalId !== null;

	return (
		<>
			<DialogHeader className="border-border/60 border-b px-6 pt-5 pb-4">
				<button
					type="button"
					onClick={onBack}
					className="-ml-1 inline-flex w-fit items-center gap-1 rounded font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" aria-hidden="true" />
					All sessions
				</button>
				<div className="mt-2 flex items-center gap-2">
					<SparklesIcon
						className="size-4 shrink-0 text-secondary"
						aria-hidden="true"
					/>
					<DialogTitle className="truncate font-serif font-normal text-xl">
						AI Update by {author}
					</DialogTitle>
					{status ? (
						<span
							className={cn(
								"shrink-0 rounded-full border px-2 py-0.5 font-medium text-xs",
								status.className,
							)}
						>
							{status.label}
						</span>
					) : null}
				</div>
				<DialogDescription className="flex items-start justify-between gap-3">
					{detail.data ? (
						<>
							<span
								title={detail.data.summary}
								className="min-w-0 truncate"
							>
								{detail.data.summary}
							</span>
							<HistoryTimestamp value={detail.data.createdAt} />
						</>
					) : (
						"Loading session…"
					)}
				</DialogDescription>
			</DialogHeader>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
				{detail.isLoading ? (
					<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						Loading the preserved session…
					</div>
				) : detail.isError || !detail.data ? (
					<HistoryError onRetry={() => detail.refetch()} />
				) : (
					<div className="space-y-5">
						<SessionConversation messages={detail.data.messages} />
						<SessionResults
							appliedItems={detail.data.appliedItems}
							changes={detail.data.changes}
							onOpenTicket={onOpenTicket}
						/>
					</div>
				)}
			</div>

			{/* Stuck-apply escape hatch: while a run is still applying, let the
			    user stop it immediately rather than wait on the auto-timeout. */}
			{canCancel ? (
				<div className="flex items-center justify-between gap-3 border-border/60 border-t px-6 py-3">
					<p className="min-w-0 text-muted-foreground text-xs">
						Still applying. If it looks stuck, you can stop it and
						retry from the backlog.
					</p>
					<Button
						variant="outline"
						size="sm"
						className="shrink-0"
						onClick={() => cancelMutation.mutate()}
						disabled={cancelMutation.isPending}
					>
						{cancelMutation.isPending ? (
							<>
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
								Cancelling…
							</>
						) : (
							<>
								<CircleStopIcon
									className="size-4"
									aria-hidden="true"
								/>
								Cancel apply
							</>
						)}
					</Button>
				</div>
			) : null}
		</>
	);
}

/** A single clickable row in the list view → opens that session's detail. */
function SessionListCard({
	session,
	highlighted,
	onOpen,
}: {
	session: {
		id: string;
		status: string;
		summary: string;
		createCount: number;
		updateCount: number;
		appliedCount: number;
		failedCount: number;
		authorName: string | null;
		authorEmail: string | null;
		createdAt: string | Date;
	};
	highlighted?: boolean;
	onOpen: () => void;
}) {
	const status = sessionStatusMeta(session.status);
	const author = session.authorName ?? session.authorEmail ?? "Unknown user";
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className={cn(
					"flex w-full items-start justify-between gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40",
					highlighted
						? "border-primary/40 ring-1 ring-primary/20"
						: "border-foreground/10",
				)}
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<SparklesIcon
							className="size-4 shrink-0 text-secondary"
							aria-hidden="true"
						/>
						<span className="truncate font-medium text-foreground text-sm">
							{author}
						</span>
						<span
							className={cn(
								"shrink-0 rounded-full border px-2 py-0.5 font-medium text-xs",
								status.className,
							)}
						>
							{status.label}
						</span>
					</div>
					<p
						title={session.summary}
						className="mt-1 truncate text-muted-foreground text-sm"
					>
						{session.summary}
					</p>
					<p className="mt-1 text-muted-foreground/80 text-xs">
						{session.createCount} to create · {session.updateCount}{" "}
						to update
						{session.status !== "APPLYING"
							? ` · ${session.appliedCount} applied${
									session.failedCount > 0
										? ` · ${session.failedCount} failed`
										: ""
								}`
							: ""}
					</p>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-2">
					<HistoryTimestamp value={session.createdAt} />
					<ChevronRightIcon
						className="size-4 text-muted-foreground"
						aria-hidden="true"
					/>
				</div>
			</button>
		</li>
	);
}

export function BacklogSessionHistoryDialog({
	open,
	onOpenChange,
	projectId,
	organizationId,
	focusSessionId,
}: Props) {
	const { basePath } = useOrganizationContext();
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);

	const query = useInfiniteQuery({
		queryKey: [
			"backlog-session-history",
			projectId,
			organizationId ?? null,
		],
		queryFn: ({ pageParam }) =>
			orpcClient.projects.backlog.history.sessions.list({
				projectId,
				organizationId,
				cursor: pageParam,
				limit: PAGE_SIZE,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: open,
		// Live-update the list while any loaded run is still applying.
		refetchInterval: (q) => {
			const applying = q.state.data?.pages.some((p) =>
				p.items.some((i) => i.status === "APPLYING"),
			);
			return applying ? APPLYING_POLL_MS : false;
		},
	});

	const sessions = query.data?.pages.flatMap((p) => p.items) ?? [];

	// Arriving from a deep-link — open that session's detail directly.
	useEffect(() => {
		if (open && focusSessionId) {
			setSelectedSessionId(focusSessionId);
		}
	}, [open, focusSessionId]);

	// Reset to the list when the dialog is dismissed.
	useEffect(() => {
		if (!open) {
			setSelectedSessionId(null);
		}
	}, [open]);

	// Open a ticket in a new tab. Uses a programmatic anchor (not window.open) so
	// the installed PWA window doesn't swallow the in-scope URL.
	const openTicket = useCallback(
		(storyId: string) => {
			if (!storyId) {
				return;
			}
			const url = buildStoryDetailsRoute(basePath, projectId, storyId);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.target = "_blank";
			anchor.rel = "noopener noreferrer";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
		},
		[basePath, projectId],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
				{selectedSessionId ? (
					<SessionDetailView
						projectId={projectId}
						organizationId={organizationId}
						sessionId={selectedSessionId}
						onBack={() => setSelectedSessionId(null)}
						onOpenTicket={openTicket}
					/>
				) : (
					<>
						<DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
							<DialogTitle className="font-serif font-normal text-2xl">
								Session history
							</DialogTitle>
							<DialogDescription>
								Past AI Update runs for this project — click one
								to replay its conversation and see what it
								changed.
							</DialogDescription>
						</DialogHeader>

						<div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
							{query.isLoading ? (
								<HistoryLoading rows={4} />
							) : query.isError ? (
								<HistoryError onRetry={() => query.refetch()} />
							) : sessions.length === 0 ? (
								<HistoryEmptyState
									title="No AI Update sessions yet"
									description="When you run AI Backlog Update and apply changes, each session is recorded here with who ran it, when, and what changed."
								/>
							) : (
								<ul className="space-y-3">
									{sessions.map((session) => (
										<SessionListCard
											key={session.id}
											session={session}
											highlighted={
												session.id === focusSessionId
											}
											onOpen={() =>
												setSelectedSessionId(session.id)
											}
										/>
									))}
								</ul>
							)}
						</div>

						{query.hasNextPage ? (
							<div className="border-border/60 border-t px-6 py-3 text-center">
								<Button
									variant="outline"
									size="sm"
									onClick={() => query.fetchNextPage()}
									disabled={query.isFetchingNextPage}
								>
									{query.isFetchingNextPage ? (
										<>
											<Loader2Icon
												className="size-4 motion-safe:animate-spin"
												aria-hidden="true"
											/>
											Loading…
										</>
									) : (
										"Show more"
									)}
								</Button>
							</div>
						) : null}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
