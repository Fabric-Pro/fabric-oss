"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { LockIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { SwipeableChatItem } from "./SwipeableChatItem";

/**
 * Generic item rendered inside `<ChatHistoryGroup>`. Two callers consume
 * this component today:
 *
 *   1. The standalone Fabric AI page (`<ChatHistorySidebar>`) — uses the
 *      `swipeable` rendering variant which mounts `<SwipeableChatItem>`
 *      so it can keep its existing swipe-to-delete affordance and
 *      hover-only delete button.
 *   2. The document-assistant `<CopilotHistoryDrawer>` (Group F) — uses
 *      the `editorial` rendering variant which shows the richer row
 *      payload (author chip, visibility badge, preview, message count,
 *      relative timestamp) per spec §3.4 FR-13.
 *
 * Refactor history: this component used to be tightly coupled to the
 * standalone Fabric AI shape (`group: GroupedChats<any>`). Spec
 * 2026-05-19-ai-assistant-document-chat-history §6.5 requires reusing
 * (NOT forking) it for the document-assistant drawer, so the API was
 * widened to accept a generic items array and the standalone caller now
 * flattens `groupedChats` into the new prop shape.
 */
export interface ChatHistoryGroupItem {
	/** Stable identifier used as the React key and the callback arg. */
	id: string;
	/** Conversation title — falls back to "New conversation" when null. */
	title: string | null;
	/** Optional first-prompt preview shown beneath the title in the
	 * `editorial` variant. The standalone surface omits this. */
	previewText?: string | null;
	/** Total message count rendered as a quiet metric in the
	 * `editorial` variant. */
	messageCount?: number;
	/** ISO timestamp used to compute the relative "Xh ago" string in the
	 * `editorial` variant. */
	updatedAt?: string;
	/** Author chip — drawer variant only. Standalone surface relies on
	 * the swipeable variant which has no author chip. */
	authorId?: string;
	authorName?: string | null;
	authorAvatarUrl?: string | null;
	/** Visibility chip — drawer variant only. */
	visibility?: "SHARED" | "PRIVATE";
	/** Marks the row as the current user's own thread so the visibility
	 * chip reads "Private — only you" instead of just "Private". */
	isOwn?: boolean;
}

interface ChatHistoryGroupBaseProps {
	/** Section heading rendered above the rows. */
	label: string;
	/** Sorted, bucketed items for this group. */
	items: ChatHistoryGroupItem[];
	/** Selected/active item id (highlighted). */
	selectedId: string | null;
	/** Row click — opens the conversation. */
	onSelect: (id: string) => void;
	className?: string;
}

interface ChatHistoryGroupSwipeableProps extends ChatHistoryGroupBaseProps {
	variant?: "swipeable";
	/** Delete affordance — wired into the existing swipe row. */
	onDelete: (id: string) => void;
}

interface ChatHistoryGroupEditorialProps extends ChatHistoryGroupBaseProps {
	variant: "editorial";
	/** Optional inline delete affordance — drawer variant uses a kebab
	 * menu in the viewer pane instead, so this is typically omitted. */
	onDelete?: (id: string) => void;
}

export type ChatHistoryGroupProps =
	| ChatHistoryGroupSwipeableProps
	| ChatHistoryGroupEditorialProps;

/**
 * Relative-time string used by the editorial variant. Computed inline so
 * the drawer doesn't have to pull in `date-fns` on its own; this avoids
 * an extra import surface for a single helper.
 */
function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) {
		return "";
	}
	const diff = Date.now() - then;
	if (diff < 60_000) {
		return "just now";
	}
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) {
		return `${mins}m ago`;
	}
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) {
		return `${hrs}h ago`;
	}
	const days = Math.floor(hrs / 24);
	if (days < 7) {
		return `${days}d ago`;
	}
	const weeks = Math.floor(days / 7);
	if (weeks < 4) {
		return `${weeks}w ago`;
	}
	const months = Math.floor(days / 30);
	if (months < 12) {
		return `${months}mo ago`;
	}
	const years = Math.floor(days / 365);
	return `${years}y ago`;
}

function initialsFrom(name: string | null | undefined): string {
	if (!name) {
		return "?";
	}
	const parts = name.trim().split(/\s+/);
	if (parts.length === 0) {
		return "?";
	}
	const first = parts[0]?.[0] ?? "";
	const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
	return (first + second).toUpperCase() || "?";
}

/**
 * Editorial row used by the document-assistant drawer. Each row is a
 * `<button>` so it's keyboard-focusable and announces correctly. The
 * row carries data-attributes the drawer's roving-tabindex helper
 * keys off.
 */
function EditorialRow({
	item,
	isSelected,
	onSelect,
}: {
	item: ChatHistoryGroupItem;
	isSelected: boolean;
	onSelect: () => void;
}) {
	const title = item.title?.trim() || "New conversation";
	const visibilityLabel =
		item.visibility === "PRIVATE"
			? item.isOwn
				? "Private — only you"
				: "Private"
			: "Shared";
	const visibilityIcon =
		item.visibility === "PRIVATE" ? (
			<LockIcon className="size-3" aria-hidden="true" />
		) : (
			<UsersIcon className="size-3" aria-hidden="true" />
		);

	return (
		<button
			type="button"
			onClick={onSelect}
			role="option"
			aria-selected={isSelected}
			data-history-row="true"
			data-history-row-id={item.id}
			className={cn(
				"w-full rounded-md border border-transparent px-3 py-2.5 text-left",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
				"motion-safe:transition-colors motion-safe:duration-150",
				isSelected
					? "border-border bg-accent text-foreground"
					: "text-foreground hover:bg-muted",
			)}
		>
			<div className="flex items-start gap-3">
				<Avatar className="mt-0.5 size-7 shrink-0">
					{item.authorAvatarUrl ? (
						<AvatarImage
							src={item.authorAvatarUrl}
							alt={item.authorName ?? "Author"}
						/>
					) : null}
					<AvatarFallback className="text-[10px] font-medium">
						{initialsFrom(item.authorName)}
					</AvatarFallback>
				</Avatar>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="truncate text-sm font-medium text-foreground">
							{title}
						</span>
						{item.updatedAt ? (
							<span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
								{relativeTime(item.updatedAt)}
							</span>
						) : null}
					</div>
					{item.previewText ? (
						<p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
							{item.previewText}
						</p>
					) : null}
					<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
						{item.authorName ? (
							<span className="truncate">{item.authorName}</span>
						) : null}
						{typeof item.messageCount === "number" ? (
							<span>
								{item.messageCount} message
								{item.messageCount === 1 ? "" : "s"}
							</span>
						) : null}
						{item.visibility ? (
							<span className="inline-flex items-center gap-1 rounded border border-border bg-background/40 px-1.5 py-0.5">
								{visibilityIcon}
								<span>{visibilityLabel}</span>
							</span>
						) : null}
					</div>
				</div>
			</div>
		</button>
	);
}

export function ChatHistoryGroup(props: ChatHistoryGroupProps) {
	if (props.items.length === 0) {
		return null;
	}

	if (props.variant === "editorial") {
		return (
			<section
				className={cn("mb-5 w-full", props.className)}
				aria-label={props.label}
			>
				<header className="mb-2 flex items-center gap-2 px-3">
					<span
						aria-hidden="true"
						className="block h-3 w-0.5 rounded-sm bg-primary"
					/>
					<h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						{props.label}
					</h3>
				</header>
				<div className="flex flex-col gap-0.5 px-1">
					{props.items.map((item) => (
						<div key={item.id} className="group relative">
							<EditorialRow
								item={item}
								isSelected={props.selectedId === item.id}
								onSelect={() => props.onSelect(item.id)}
							/>
							{/*
							 * Inline delete trigger — only rendered when the
							 * row is the caller's own conversation AND the
							 * parent passed an `onDelete` callback. We don't
							 * pop a native `window.confirm` here: the parent
							 * owns the confirmation flow so it can use a
							 * styled `<AlertDialog>` matching the rest of
							 * the app. Hover-only opacity transition keeps
							 * the row visually quiet at rest.
							 */}
							{props.onDelete && item.isOwn ? (
								// Anchored to the BOTTOM-RIGHT of the card so the
								// trash icon never overlaps the "Xm ago" timestamp,
								// which lives in the top-right of `EditorialRow`.
								// `pointer-events-none` on the wrapper keeps the
								// row clickable through the empty bottom band;
								// the inner button re-enables pointer events on
								// itself. The button now carries a card/border
								// background so it reads as a proper affordance
								// when revealed on hover, instead of a floating
								// silhouette.
								<div className="pointer-events-none absolute bottom-1.5 right-1.5 opacity-0 motion-safe:transition-opacity motion-safe:duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Delete conversation: ${
											item.title?.trim() ||
											"New conversation"
										}`}
										className="pointer-events-auto size-7 rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
										onClick={(e) => {
											e.stopPropagation();
											props.onDelete?.(item.id);
										}}
									>
										<Trash2Icon className="size-3.5" />
									</Button>
								</div>
							) : null}
						</div>
					))}
				</div>
			</section>
		);
	}

	// Default: standalone Fabric AI swipeable variant (unchanged behaviour
	// from the pre-refactor shape — same DOM tree, same hover/swipe row).
	return (
		<div className={cn("mb-5 w-full px-2.5", props.className)}>
			<h3 className="mb-2 px-2 text-[10px] font-semibold tracking-[-0.01em] text-muted-foreground/65">
				{props.label}
			</h3>
			<div className="w-full space-y-0.5">
				{props.items.map((item) => (
					<SwipeableChatItem
						key={item.id}
						chat={{
							id: item.id,
							title: item.title,
							createdAt:
								item.updatedAt ?? new Date().toISOString(),
							updatedAt:
								item.updatedAt ?? new Date().toISOString(),
						}}
						isActive={props.selectedId === item.id}
						onSelect={() => props.onSelect(item.id)}
						onDelete={() => props.onDelete(item.id)}
					/>
				))}
			</div>
		</div>
	);
}
