"use client";

/**
 * `CopilotHistoryDrawer`.
 *
 * The drawer is the persistent-history surface for the document
 * AI Assistant. It mounts inside `<DocumentEditor>` next to the
 * `<CopilotSidebar>` and overlays the chat area (NOT the entire
 * viewport — the live thread stays in the DOM so focus and any
 * mid-typing state are preserved on close).
 *
 * Layout
 * ------
 *   - Desktop (≥ 640 px): two-pane — left = bucketed conversation list,
 *     right = read-only viewer for the selected conversation.
 *   - Mobile (< 640 px): stacked — list visible first; selecting an item
 *     swaps the panel for the viewer. A "Back" affordance returns to
 *     the list.
 *
 * Reused, NOT forked
 * -------------------
 *   - `<ChatHistoryGroup variant="editorial">` — the same group component
 *     the standalone Fabric AI page renders, widened to accept a generic
 *     items array.
 *   - `<RenameChatDialog>` — author-only rename flow.
 *   - `<AlertDialog>` (shadcn) — destructive delete confirm.
 *
 * Read-only viewer
 * ----------------
 * The viewer reads the persisted `messages[]` from one of two sources:
 *   - `getActiveForDocument` when the selection is the user's live thread
 *     (already-loaded payload, no round-trip);
 *   - `getByIdForDocument` (Group F.13) for any prior selection.
 *
 * Both paths feed the same `<ConversationViewer>` component so the visual
 * idiom stays identical. The viewer uses the live chat's `copilotKit*`
 * CSS classes — it does NOT mount `CopilotAssistantMessage` /
 * `CopilotUserMessage` directly because those components depend on
 * CopilotKit's `useChatContext` and `useCoAgent` runtime, neither of
 * which is available when rendering a HISTORICAL conversation.
 *
 * Diff outcome chip — render path
 * -------------------------------
 * Spec §3.8 FR-23 mandates the chip read from the persisted
 * `acceptedAt` / `rejectedAt` fields on each tool-call. We never
 * re-derive. The chip is purely informational — `<span>` with a Badge
 * style, no interactive role.
 *
 * Accessibility
 * -------------
 *   - The whole drawer is a Radix `<Sheet>` so focus-trap, Esc-to-close,
 *     and inert-background semantics come for free.
 *   - The Chat/History toggle uses `role="tablist"` and `role="tab"` for
 *     the two pane labels (list + viewer); each pane is a `tabpanel`.
 *   - Conversation rows form a `role="listbox"` with `role="option"` per
 *     row. Up/Down arrow keys move selection; Enter opens the
 *     conversation in the viewer pane.
 *   - All icon-only controls carry `aria-label`. The visibility chip in
 *     each row is rendered as a non-focusable badge (it's metadata, not
 *     a control).
 *   - Persistent animations are wrapped in `motion-safe:` Tailwind
 *     variants so `prefers-reduced-motion: reduce` users get no
 *     transitions at all.
 */

import type { ChatHistoryGroupItem } from "@saas/ai/components/ChatHistoryGroup";
import { ChatHistoryGroup } from "@saas/ai/components/ChatHistoryGroup";
import { RenameChatDialog } from "@saas/ai/components/RenameChatDialog";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowLeftIcon,
	CornerUpLeftIcon,
	GitForkIcon,
	Loader2Icon,
	LockIcon,
	MoreHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type DocumentAssistantHistoryListItem,
	type DocumentAssistantHistoryScope,
	useActiveDocumentAssistantConversation,
	useDeleteDocumentAssistantConversation,
	useDocumentAssistantConversationById,
	useDocumentAssistantHistoryList,
	useForkDocumentAssistantConversation,
	useRenameDocumentAssistantConversation,
} from "../../hooks/useDocumentAssistantHistory";
import {
	ConversationViewer,
	type PersistedConversationMessage,
} from "./ConversationViewer";

/**
 * Date buckets ("Today" / "Yesterday" / "Previous N days" / "Older"). We
 * compute them inside the drawer so the group component stays
 * domain-agnostic.
 */
type Bucket = "today" | "yesterday" | "last7" | "earlier";

const BUCKET_LABEL: Record<Bucket, string> = {
	today: "Today",
	yesterday: "Yesterday",
	last7: "Last 7 days",
	earlier: "Earlier",
};

const BUCKET_ORDER: Bucket[] = ["today", "yesterday", "last7", "earlier"];

function startOfDay(date: Date): Date {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	return d;
}

function bucketFor(updatedAtIso: string, now: Date = new Date()): Bucket {
	const updated = new Date(updatedAtIso);
	const startToday = startOfDay(now);
	const startYesterday = new Date(startToday);
	startYesterday.setDate(startYesterday.getDate() - 1);
	const startSevenDaysAgo = new Date(startToday);
	startSevenDaysAgo.setDate(startSevenDaysAgo.getDate() - 6); // includes today
	if (updated >= startToday) {
		return "today";
	}
	if (updated >= startYesterday) {
		return "yesterday";
	}
	if (updated >= startSevenDaysAgo) {
		return "last7";
	}
	return "earlier";
}

/**
 * Persisted message shape we read from `messages[]`. The canonical type
 * lives next to the viewer in `./ConversationViewer.tsx`; we re-export it
 * here as an alias so existing in-file references stay self-documenting.
 */
type PersistedMessage = PersistedConversationMessage;

export interface CopilotHistoryDrawerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	documentRefId: string;
	projectId: string;
	organizationId: string | null;
	/** Current authenticated user id — drives the author-only rename and
	 * delete affordances. */
	currentUserId: string;
	/** Conversation id of the currently-active (live) thread. Highlighted
	 * in the list when present. */
	activeConversationId: string | null;
	/**
	 * Called after a successful fork. The parent should switch its live
	 * `activeAssistantConversationId` to `forkedConversationId` so the
	 * sidebar swaps to the new thread, then close the drawer. The
	 * `copiedMessages` array is the exact slice the server persisted —
	 * the parent should push it into the live runtime's messages store
	 * so the agent receives the same context the user just saw in the
	 * historical viewer when their next typed message goes out.
	 *
	 * Optional because non-fork surfaces (or test mounts) can omit the
	 * fork affordance entirely.
	 */
	onForked?: (input: {
		forkedConversationId: string;
		copiedMessageCount: number;
		copiedMessages: PersistedMessage[];
		visibility: "SHARED" | "PRIVATE";
	}) => void;
}

/**
 * The active conversation payload, looked up either from the in-memory
 * list pages or via a fallback `getActiveForDocument` query. Shape is the
 * smallest superset of the two responses the viewer needs to render.
 */
interface SelectedConversation {
	conversationId: string;
	title: string | null;
	authorId: string;
	authorName: string | null;
	authorAvatarUrl: string | null;
	visibility: "SHARED" | "PRIVATE";
	visibilityLockedAt: string | null;
	parentConversationId: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	messages: PersistedMessage[];
}

/**
 * Visibility badge for the viewer pane — informational, NOT focusable.
 *
 * Style:
 *   - SHARED → muted outline + "Shared" label + tooltip on hover explaining
 *     "Visible to all members of this project."
 *   - PRIVATE (own) → muted outline + lock icon + "Private" label + tooltip
 *     "Only you can read this conversation."
 *   - PRIVATE (someone else's — should never render because the byId procedure
 *     returns null for non-author private rows, but we keep the branch for
 *     forward-compat.) → identical to PRIVATE own but with "Hidden".
 *   - When `lockedAt` is non-null we suffix the chip with a small lock icon
 *     and surface the lock timestamp on hover so a curious user can tell
 *     why a Shared chip can't be flipped to Private mid-thread.
 */
function VisibilityBadge({
	visibility,
	isOwn,
	lockedAt,
}: {
	visibility: "SHARED" | "PRIVATE";
	isOwn: boolean;
	lockedAt: string | null;
}) {
	const label =
		visibility === "PRIVATE" ? (isOwn ? "Private" : "Hidden") : "Shared";
	const explainer =
		visibility === "PRIVATE"
			? isOwn
				? "Only you can read this conversation."
				: "Hidden from project members other than the author."
			: "Visible to all members of this project.";
	const lockExplainer = lockedAt
		? ` Locked ${formatDistanceToNow(new Date(lockedAt), { addSuffix: true })} — the visibility can no longer be changed.`
		: "";
	return (
		<Badge
			variant="outline"
			className="gap-1 font-normal"
			title={`${explainer}${lockExplainer}`}
		>
			{visibility === "PRIVATE" ? (
				<LockIcon className="size-3" aria-hidden="true" />
			) : null}
			<span>{label}</span>
			{lockedAt && visibility === "SHARED" ? (
				<LockIcon
					className="size-3 text-muted-foreground"
					aria-label="Locked"
				/>
			) : null}
		</Badge>
	);
}

/**
 * "Started by <avatar> <name> · <time ago>" — used in the viewer header so a
 * SHARED conversation surfaces its author. Avatar falls back to the author's
 * initials when no URL is available. Time is relative ("2h ago") with the
 * absolute ISO string in the `title` attribute for hover precision.
 */
function CreatorChip({
	name,
	avatarUrl,
	createdAt,
}: {
	name: string | null;
	avatarUrl: string | null;
	createdAt: string | null;
}) {
	const tTooltips = useTranslations("tooltips.copilot");
	const displayName = name?.trim() || "Unknown user";
	const initials =
		displayName
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?";
	const startedLabel = createdAt
		? formatDistanceToNow(new Date(createdAt), { addSuffix: true })
		: null;
	const copy = createdAt
		? tTooltips("sessionStartedBy", {
				name: displayName,
				date: new Date(createdAt).toLocaleString(),
			})
		: tTooltips("sessionStartedByAuthorOnly", { name: displayName });
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<Avatar className="size-4">
						{avatarUrl ? (
							<AvatarImage src={avatarUrl} alt="" />
						) : null}
						<AvatarFallback className="text-[9px] font-medium">
							{initials}
						</AvatarFallback>
					</Avatar>
					<span className="truncate font-medium text-foreground/80">
						{displayName}
					</span>
					{startedLabel ? (
						<>
							<span aria-hidden="true">·</span>
							<span>{startedLabel}</span>
						</>
					) : null}
					{/* The chip is not focusable, so the portalled tooltip is
						pointer-only. `aria-label` would replace the visible author
						name and relative time in the accessible name; an `sr-only`
						child carries the absolute start time alongside them. */}
					<span className="sr-only">{copy}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>{copy}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The main drawer component. Renders nothing when `open === false` so we
 * avoid keeping any list/viewer DOM alive between sessions (the Radix
 * `<Sheet>` already handles unmount-on-close, but being explicit keeps
 * the parent's state model honest).
 */
export function CopilotHistoryDrawer({
	open,
	onOpenChange,
	documentRefKind,
	documentRefId,
	projectId,
	organizationId,
	currentUserId,
	activeConversationId,
	onForked,
}: CopilotHistoryDrawerProps) {
	const scope = useMemo<DocumentAssistantHistoryScope>(
		() => ({
			documentRefKind,
			documentRefId,
			projectId,
			organizationId,
		}),
		[documentRefKind, documentRefId, projectId, organizationId],
	);

	const listQuery = useDocumentAssistantHistoryList(scope, { enabled: open });
	const activeQuery = useActiveDocumentAssistantConversation(scope, {
		enabled: open,
	});

	const renameMutation = useRenameDocumentAssistantConversation();
	const deleteMutation = useDeleteDocumentAssistantConversation();
	const forkMutation = useForkDocumentAssistantConversation();

	// Holds the conversationId currently shown in the viewer. Driven by the
	// list-row click handler below and the auto-select effect.
	// Declared up here so the per-conversation fetch hook can read it.

	const flatItems = useMemo<DocumentAssistantHistoryListItem[]>(
		() => listQuery.data?.pages.flatMap((p) => p.items) ?? [],
		[listQuery.data],
	);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [renameOpen, setRenameOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);

	// Per-conversation fetch for the viewer pane. Group F.13 hotfix: backs
	// the "click a prior conversation" branch so the viewer can render any
	// non-active conversation read-only. Disabled when no selection exists
	// AND when the selection IS the active thread (the active query already
	// carries the full payload — skipping avoids a duplicate round-trip).
	const isActiveSelected =
		selectedId !== null && selectedId === activeConversationId;
	const byIdQuery = useDocumentAssistantConversationById({
		conversationId: selectedId,
		documentRefKind,
		documentRefId,
		projectId,
		organizationId,
		enabled: open && !isActiveSelected,
	});

	// Auto-select the active conversation when the drawer opens (if it's
	// in the list). On mobile we leave the selection unset until the user
	// explicitly taps a row so the list shows first.
	useEffect(() => {
		if (!open) {
			setSelectedId(null);
			return;
		}
		if (selectedId) {
			return;
		}
		if (
			activeConversationId &&
			flatItems.some((i) => i.conversationId === activeConversationId)
		) {
			setSelectedId(activeConversationId);
		}
	}, [open, selectedId, activeConversationId, flatItems]);

	// Look up the selected row from the cached list pages — used for the
	// header chip (author, visibility) so the viewer can show context
	// while the per-conversation `byIdQuery` is still loading. When the
	// selection is the active thread, `activeQuery` already carries the
	// full payload and we skip the byId fetch entirely.
	const selectedRow = useMemo<DocumentAssistantHistoryListItem | null>(() => {
		if (!selectedId) {
			return null;
		}
		return flatItems.find((i) => i.conversationId === selectedId) ?? null;
	}, [flatItems, selectedId]);

	// Resolve the viewer payload. Three sources, in priority order:
	//   1. If the selection IS the active thread, use the active query's
	//      payload — it already carries the full `messages[]` and saves a
	//      round-trip.
	//   2. Otherwise prefer the per-conversation `byIdQuery` (Group F.13).
	//   3. Fallback to the list row metadata with empty messages — this
	//      keeps the header rendered while `byIdQuery` is loading.
	const selected = useMemo<SelectedConversation | null>(() => {
		if (!selectedId) {
			return null;
		}
		const active = activeQuery.data?.conversation;
		if (active && active.conversationId === selectedId) {
			return {
				conversationId: active.conversationId,
				title: active.title,
				// active query only returns the caller's own threads
				authorId: currentUserId,
				authorName: selectedRow?.authorName ?? null,
				authorAvatarUrl: selectedRow?.authorAvatarUrl ?? null,
				visibility: active.visibility,
				visibilityLockedAt: active.visibilityLockedAt ?? null,
				parentConversationId: active.parentConversationId ?? null,
				createdAt: active.createdAt ?? null,
				updatedAt: active.updatedAt ?? null,
				messages: Array.isArray(active.messages)
					? (active.messages as PersistedMessage[])
					: [],
			};
		}
		const byId = byIdQuery.data?.conversation;
		if (byId && byId.conversationId === selectedId) {
			return {
				conversationId: byId.conversationId,
				title: byId.title,
				// The list row carries the canonical authorId; fall back to
				// the current user if the row isn't in the cache yet (rare —
				// only when the drawer auto-selects before the list resolves).
				authorId: selectedRow?.authorId ?? currentUserId,
				authorName: selectedRow?.authorName ?? null,
				authorAvatarUrl: selectedRow?.authorAvatarUrl ?? null,
				visibility: byId.visibility,
				visibilityLockedAt: byId.visibilityLockedAt ?? null,
				parentConversationId: byId.parentConversationId ?? null,
				createdAt: byId.createdAt ?? null,
				updatedAt: byId.updatedAt ?? null,
				messages: Array.isArray(byId.messages)
					? (byId.messages as PersistedMessage[])
					: [],
			};
		}
		if (!selectedRow) {
			return null;
		}
		// `byIdQuery` is still loading — render header from the list row so
		// the user sees the title/chip without flicker; the messages slot
		// stays empty until the fetch resolves.
		return {
			conversationId: selectedRow.conversationId,
			title: selectedRow.title,
			authorId: selectedRow.authorId,
			authorName: selectedRow.authorName ?? null,
			authorAvatarUrl: selectedRow.authorAvatarUrl ?? null,
			visibility: selectedRow.visibility,
			visibilityLockedAt: selectedRow.visibilityLockedAt ?? null,
			parentConversationId: selectedRow.parentConversationId,
			createdAt: selectedRow.createdAt ?? null,
			updatedAt: selectedRow.updatedAt ?? null,
			messages: [],
		};
	}, [
		selectedRow,
		activeQuery.data,
		byIdQuery.data,
		selectedId,
		currentUserId,
	]);

	// Bucket the items into Today / Yesterday / Last 7 days / Earlier and
	// adapt them to `ChatHistoryGroupItem`. Sort within each bucket by
	// `updatedAt DESC`.
	const buckets = useMemo(() => {
		const now = new Date();
		const map: Record<Bucket, DocumentAssistantHistoryListItem[]> = {
			today: [],
			yesterday: [],
			last7: [],
			earlier: [],
		};
		for (const item of flatItems) {
			map[bucketFor(item.updatedAt, now)].push(item);
		}
		for (const key of BUCKET_ORDER) {
			map[key].sort((a, b) =>
				a.updatedAt < b.updatedAt
					? 1
					: a.updatedAt > b.updatedAt
						? -1
						: 0,
			);
		}
		return map;
	}, [flatItems]);

	const groupItemsFor = useCallback(
		(rows: DocumentAssistantHistoryListItem[]): ChatHistoryGroupItem[] =>
			rows.map((row) => ({
				id: row.conversationId,
				title: row.title,
				previewText: row.firstPromptPreview,
				messageCount: row.messageCount,
				updatedAt: row.updatedAt,
				authorId: row.authorId,
				authorName: row.authorName,
				authorAvatarUrl: row.authorAvatarUrl,
				visibility: row.visibility,
				isOwn: row.authorId === currentUserId,
			})),
		[currentUserId],
	);

	const handleSelect = useCallback((id: string) => {
		setSelectedId(id);
	}, []);

	/**
	 * Inline-trash from a list row. Auto-selects the row first so the
	 * existing `<AlertDialog>` flow (which reads `selected`) has a target
	 * and the user sees the row highlighted under the dialog backdrop.
	 * Author-gating is enforced upstream by `<ChatHistoryGroup>`'s
	 * `item.isOwn` check, so this handler doesn't re-check.
	 */
	const handleDeleteFromList = useCallback((id: string) => {
		setSelectedId(id);
		setDeleteOpen(true);
	}, []);

	// Keyboard navigation on the list — up/down moves selection, Enter
	// opens. We attach the listener to the list container and rely on
	// `data-history-row` markers on each row to find adjacency.
	const listRef = useRef<HTMLDivElement | null>(null);
	const handleListKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (
				e.key !== "ArrowDown" &&
				e.key !== "ArrowUp" &&
				e.key !== "Home" &&
				e.key !== "End"
			) {
				return;
			}
			const rows = listRef.current?.querySelectorAll<HTMLButtonElement>(
				'[data-history-row="true"]',
			);
			if (!rows || rows.length === 0) {
				return;
			}
			e.preventDefault();
			const ids = Array.from(rows).map(
				(el) => el.getAttribute("data-history-row-id") ?? "",
			);
			const currentIdx = selectedId ? ids.indexOf(selectedId) : -1;
			let nextIdx: number;
			if (e.key === "ArrowDown") {
				nextIdx =
					currentIdx < 0
						? 0
						: Math.min(currentIdx + 1, ids.length - 1);
			} else if (e.key === "ArrowUp") {
				nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
			} else if (e.key === "Home") {
				nextIdx = 0;
			} else {
				nextIdx = ids.length - 1;
			}
			const nextId = ids[nextIdx];
			if (nextId) {
				setSelectedId(nextId);
				rows[nextIdx]?.focus();
			}
		},
		[selectedId],
	);

	const handleRenameSubmit = useCallback(
		(newTitle: string) => {
			if (!selected) {
				return;
			}
			renameMutation.mutate(
				{
					conversationId: selected.conversationId,
					title: newTitle,
					scope,
				},
				{
					onError: (err) => {
						const message =
							err instanceof Error
								? err.message
								: "Could not rename conversation.";
						toast.error(message);
					},
					onSuccess: () => {
						toast.success("Conversation renamed");
					},
				},
			);
		},
		[renameMutation, scope, selected],
	);

	/**
	 * Fork handler — bound to both the conv-level "Fork conversation" item
	 * in the dropdown (atMessageId = undefined → full copy) and to the
	 * per-message "Fork from here" affordance in the viewer (atMessageId
	 * scopes the copy).
	 *
	 * On success: pass the new conv id + the EXACT slice the server persisted
	 * up to the parent so it can (a) flip its `activeAssistantConversationId`
	 * to the forked id and (b) push the slice into the live runtime so the
	 * agent receives the same context the user was looking at. Drawer
	 * closes itself — keeping it open after a fork would leave the user
	 * staring at the source thread while their active sidebar swapped.
	 */
	const handleFork = useCallback(
		(atMessageId?: string) => {
			if (!selected) {
				return;
			}
			forkMutation.mutate(
				{
					sourceConversationId: selected.conversationId,
					atMessageId,
					scope,
					requestedVisibility: selected.visibility,
				},
				{
					onError: (err) => {
						const message =
							err instanceof Error
								? err.message
								: "Could not fork this conversation.";
						toast.error(message);
					},
					onSuccess: (data) => {
						// Slice the source messages on the client so the
						// parent receives the EXACT shape it would have seen
						// in the viewer — the server only returns counts,
						// not the copied messages themselves (small payload).
						const sourceMessages = selected.messages;
						let copiedMessages: PersistedMessage[];
						if (atMessageId) {
							const idx = sourceMessages.findIndex(
								(m) => m.id === atMessageId,
							);
							copiedMessages =
								idx === -1
									? sourceMessages
									: sourceMessages.slice(0, idx + 1);
						} else {
							copiedMessages = sourceMessages;
						}
						toast.success(
							atMessageId
								? `Forked from message — ${data.copiedMessageCount} ${
										data.copiedMessageCount === 1
											? "message"
											: "messages"
									} carried over`
								: `Forked conversation — ${data.copiedMessageCount} ${
										data.copiedMessageCount === 1
											? "message"
											: "messages"
									} carried over`,
						);
						onForked?.({
							forkedConversationId: data.forkedConversationId,
							copiedMessageCount: data.copiedMessageCount,
							copiedMessages,
							visibility: data.visibility,
						});
						onOpenChange(false);
					},
				},
			);
		},
		[forkMutation, onForked, onOpenChange, scope, selected],
	);

	const handleDeleteConfirm = useCallback(() => {
		if (!selected) {
			return;
		}
		deleteMutation.mutate(
			{
				conversationId: selected.conversationId,
				scope,
			},
			{
				onError: (err) => {
					const message =
						err instanceof Error
							? err.message
							: "Could not delete conversation.";
					toast.error(message);
				},
				onSuccess: () => {
					toast.success("Conversation deleted");
					setSelectedId(null);
					setDeleteOpen(false);
				},
			},
		);
	}, [deleteMutation, scope, selected]);

	const isAuthor = selected ? selected.authorId === currentUserId : false;

	// Continuation linkage: when the selected thread has a parent, render
	// a "Continued from earlier conversation" affordance that re-selects
	// the parent. The click target is a `<button>` so keyboard users can
	// activate it.
	const parentId = selected?.parentConversationId ?? null;

	// Infinite scroll: observe the sentinel at the list bottom to trigger
	// `fetchNextPage`. Avoids polluting the user's scroll position.
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) {
			return;
		}
		const el = sentinelRef.current;
		if (!el || !listQuery.hasNextPage || listQuery.isFetchingNextPage) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry?.isIntersecting) {
					listQuery.fetchNextPage();
				}
			},
			{ root: null, rootMargin: "120px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [open, listQuery]);

	// Mobile stacked layout — when a conversation is selected on a narrow
	// viewport, hide the list. We mirror this via Tailwind responsive
	// classes rather than JS measurement.
	const showListOnMobile = !selectedId;
	const showViewerOnMobile = !!selectedId;

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side="right"
					className="flex h-full w-full max-w-full flex-col gap-0 border-l border-border bg-card p-0 sm:max-w-[760px] xl:max-w-[920px]"
					showOverlay={false}
					aria-label="Document assistant chat history"
				>
					{/* Visually-hidden title + description satisfy Radix's
					    Dialog a11y contract without competing visually with
					    the editorial header below. */}
					<SheetTitle className="sr-only">
						Document assistant chat history
					</SheetTitle>
					<SheetDescription className="sr-only">
						Browse, read, rename, and delete prior AI Assistant
						conversations for this document.
					</SheetDescription>

					{/* Drawer header — tablist for the two panes */}
					<div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-3">
						<div className="flex items-center gap-2">
							<span
								aria-hidden="true"
								className="block h-3 w-0.5 rounded-sm bg-primary"
							/>
							<h2 className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
								Chat history
							</h2>
						</div>
						<div
							role="tablist"
							aria-label="Conversation panes"
							className="ml-auto flex items-center gap-1"
						>
							<button
								type="button"
								role="tab"
								id="copilot-history-list-tab"
								aria-controls="copilot-history-list-panel"
								aria-selected={showListOnMobile}
								tabIndex={-1}
								className="sr-only"
							>
								Conversations
							</button>
							<button
								type="button"
								role="tab"
								id="copilot-history-viewer-tab"
								aria-controls="copilot-history-viewer-panel"
								aria-selected={!!selectedId}
								tabIndex={-1}
								className="sr-only"
							>
								Viewer
							</button>
						</div>
					</div>

					{/* Two-pane (or stacked on mobile) body */}
					<div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[280px_minmax(0,1fr)]">
						{/* LIST PANE */}
						<div
							id="copilot-history-list-panel"
							role="tabpanel"
							aria-labelledby="copilot-history-list-tab"
							className={
								showListOnMobile
									? "flex min-h-0 flex-col border-r border-border sm:flex"
									: "hidden sm:flex sm:min-h-0 sm:flex-col sm:border-r sm:border-border"
							}
						>
							<div
								ref={listRef}
								onKeyDown={handleListKeyDown}
								role="listbox"
								aria-label="Conversations"
								tabIndex={0}
								className="flex-1 overflow-y-auto px-2 py-3 focus-visible:outline-none"
							>
								{listQuery.isLoading ? (
									<div className="space-y-2 px-2">
										<Skeleton className="h-16 w-full rounded-md" />
										<Skeleton className="h-16 w-full rounded-md" />
										<Skeleton className="h-16 w-full rounded-md" />
									</div>
								) : flatItems.length === 0 ? (
									<EmptyState />
								) : (
									<>
										{BUCKET_ORDER.map((key) => (
											<ChatHistoryGroup
												key={key}
												variant="editorial"
												label={BUCKET_LABEL[key]}
												items={groupItemsFor(
													buckets[key],
												)}
												selectedId={selectedId}
												onSelect={handleSelect}
												onDelete={handleDeleteFromList}
											/>
										))}
										<div
											ref={sentinelRef}
											className="py-2 text-center"
										>
											{listQuery.isFetchingNextPage ? (
												<Loader2Icon
													className="motion-safe:animate-spin mx-auto size-4 text-muted-foreground"
													aria-label="Loading more conversations"
												/>
											) : listQuery.hasNextPage ? (
												<span className="text-[11px] text-muted-foreground">
													Scroll to load more
												</span>
											) : null}
										</div>
									</>
								)}
							</div>
						</div>

						{/* VIEWER PANE */}
						<div
							id="copilot-history-viewer-panel"
							role="tabpanel"
							aria-labelledby="copilot-history-viewer-tab"
							className={
								showViewerOnMobile
									? "flex min-h-0 flex-col sm:flex"
									: "hidden sm:flex sm:min-h-0 sm:flex-col"
							}
						>
							{/* Mobile-only back-to-list affordance */}
							{selectedId ? (
								<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:hidden">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => setSelectedId(null)}
										aria-label="Back to conversation list"
									>
										<ArrowLeftIcon
											className="mr-1.5 size-4"
											aria-hidden="true"
										/>
										Back
									</Button>
								</div>
							) : null}

							{selected ? (
								<>
									{/* Viewer header — title, creator chip, visibility, kebab */}
									<div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
										<div className="min-w-0 flex-1">
											<h3 className="truncate text-sm font-medium text-foreground">
												{selected.title?.trim() ||
													"New conversation"}
											</h3>
											<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
												<CreatorChip
													name={selected.authorName}
													avatarUrl={
														selected.authorAvatarUrl
													}
													createdAt={
														selected.createdAt
													}
												/>
												<span aria-hidden="true">
													·
												</span>
												<VisibilityBadge
													visibility={
														selected.visibility
													}
													isOwn={isAuthor}
													lockedAt={
														selected.visibilityLockedAt
													}
												/>
												<span
													aria-hidden="true"
													className="text-foreground/30"
												>
													·
												</span>
												<span>
													{selected.messages.length}{" "}
													{selected.messages
														.length === 1
														? "message"
														: "messages"}
												</span>
											</div>
										</div>
										{isAuthor ? (
											<div className="flex shrink-0 items-center gap-1">
												{/* Conv-level "Fork conversation" — copies
												    the full thread into a new active row.
												    Only offered when the parent surface
												    accepted an onForked callback. Mounted
												    as a button (not a menu item) so the
												    affordance is one click + visually
												    discoverable. */}
												{onForked ? (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="gap-1.5 text-muted-foreground hover:text-foreground"
														onClick={() =>
															handleFork(
																undefined,
															)
														}
														disabled={
															forkMutation.isPending
														}
														title="Copy this conversation into a new active thread you can continue from"
													>
														{forkMutation.isPending ? (
															<Loader2Icon
																className="size-3.5 animate-spin"
																aria-hidden="true"
															/>
														) : (
															<GitForkIcon
																className="size-3.5"
																aria-hidden="true"
															/>
														)}
														<span className="text-xs">
															Fork
														</span>
													</Button>
												) : null}
												<DropdownMenu>
													<DropdownMenuTrigger
														asChild
													>
														<Button
															type="button"
															variant="ghost"
															size="icon-sm"
															aria-label="Conversation actions"
															className="text-muted-foreground"
														>
															<MoreHorizontalIcon
																className="size-4"
																aria-hidden="true"
															/>
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														<DropdownMenuItem
															onClick={() =>
																setRenameOpen(
																	true,
																)
															}
														>
															Rename
														</DropdownMenuItem>
														<DropdownMenuItem
															className="text-destructive focus:text-destructive"
															onClick={() =>
																setDeleteOpen(
																	true,
																)
															}
														>
															Delete
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										) : null}
									</div>

									{/* Continuation linkage (FR-14) */}
									{parentId ? (
										<div className="shrink-0 border-b border-border bg-muted/40 px-4 py-2">
											<button
												type="button"
												onClick={() =>
													setSelectedId(parentId)
												}
												className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground motion-safe:transition-colors"
											>
												<CornerUpLeftIcon
													className="size-3.5"
													aria-hidden="true"
												/>
												Continued from earlier
												conversation
											</button>
										</div>
									) : null}

									{/* Messages */}
									<div className="copilotKitMessages flex-1 overflow-y-auto px-4 py-4">
										<ViewerBody
											selected={selected}
											isActiveSelected={isActiveSelected}
											byIdLoading={byIdQuery.isLoading}
											byIdData={byIdQuery.data}
											onForkFromMessage={
												isAuthor && onForked
													? handleFork
													: undefined
											}
											isForkPending={
												forkMutation.isPending
											}
										/>
									</div>
								</>
							) : (
								<div className="hidden flex-1 flex-col items-center justify-center px-6 text-center sm:flex">
									<p className="text-sm text-muted-foreground">
										Select a conversation to read it here.
									</p>
								</div>
							)}
						</div>
					</div>
				</SheetContent>
			</Sheet>

			{/* Rename dialog — rendered outside the Sheet so the focus
			    trap is owned by Radix's Dialog and not nested inside the
			    Sheet's. */}
			{selected ? (
				<RenameChatDialog
					open={renameOpen}
					onOpenChange={setRenameOpen}
					currentTitle={selected.title?.trim() || "New conversation"}
					onConfirm={handleRenameSubmit}
				/>
			) : null}

			{/* Destructive delete confirm */}
			<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete this conversation?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently removes the conversation from
							history. Teammates with the link will no longer be
							able to read it.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleDeleteConfirm}
							variant="destructive"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/**
 * Render the viewer body for the selected conversation. Three branches:
 *
 *   - Active thread selected → render messages from the list-derived
 *     payload immediately (no extra fetch).
 *   - byId query returned `{ conversation: null }` → render the "not found"
 *     line. This is the same null branch the procedure uses to hide
 *     cross-tenant / deleted / private-non-author cases (info-leak avoidance).
 *   - byId query still loading → render a small skeleton.
 *   - Otherwise → render the persisted messages.
 */
function ViewerBody({
	selected,
	isActiveSelected,
	byIdLoading,
	byIdData,
	onForkFromMessage,
	isForkPending,
}: {
	selected: SelectedConversation;
	isActiveSelected: boolean;
	byIdLoading: boolean;
	byIdData: { conversation: unknown } | undefined;
	onForkFromMessage?: (messageId: string) => void;
	isForkPending: boolean;
}) {
	// Active-thread branch — messages came from `activeQuery` (already in
	// `selected.messages`).
	if (isActiveSelected) {
		return (
			<ConversationViewer
				messages={selected.messages}
				onForkFromMessage={onForkFromMessage}
				isForkPending={isForkPending}
			/>
		);
	}

	// byId returned an explicit null — conversation no longer accessible
	// (deleted by author, or private and visibility predicate excluded us).
	if (byIdData && byIdData.conversation === null) {
		return (
			<p className="text-xs italic text-muted-foreground">
				Conversation not found.
			</p>
		);
	}

	// byId still loading — show the same skeleton idiom as the list.
	if (byIdLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-16 w-full rounded-md" />
				<Skeleton className="h-12 w-2/3 rounded-md" />
				<Skeleton className="h-16 w-full rounded-md" />
			</div>
		);
	}

	// byId resolved with a conversation, or list-derived fallback messages.
	return (
		<ConversationViewer
			messages={selected.messages}
			onForkFromMessage={onForkFromMessage}
			isForkPending={isForkPending}
		/>
	);
}

/**
 * Empty-state for the no-conversations case. Uses the editorial label
 * pattern (thin red bar prefix + uppercase tracked) and a serif heading
 * via the global `--font-serif` token.
 */
function EmptyState() {
	return (
		<div className="flex flex-col items-start gap-3 px-4 py-10">
			<div className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className="block h-3 w-0.5 rounded-sm bg-primary"
				/>
				<span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
					Chat history
				</span>
			</div>
			<h2
				className="text-xl font-normal leading-snug text-foreground"
				style={{ fontFamily: "var(--font-serif)" }}
			>
				No conversations yet.
			</h2>
			<p className="text-xs text-muted-foreground">
				Chat with the AI Assistant — your team's conversations will
				appear here.
			</p>
		</div>
	);
}
