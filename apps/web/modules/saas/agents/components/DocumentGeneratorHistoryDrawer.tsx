"use client";

/**
 * `DocumentGeneratorHistoryDrawer`.
 *
 * Persistent session-history surface for the standalone Document Generator
 * AI Assistant (`DocumentGeneratorEditor`). It is the AgentConversation-backed
 * analogue of the project editors' `CopilotHistoryDrawer`
 * (`modules/saas/projects/components/copilot/CopilotHistoryDrawer.tsx`).
 *
 * Why a separate drawer (NOT a reuse of `CopilotHistoryDrawer`)
 * -----------------------------------------------------------
 * `CopilotHistoryDrawer` is hard-bound to the document-assistant persistence
 * model: its props require `documentRefKind` / `documentRefId` / `projectId`
 * and it reads through the `*ForDocument` oRPC procedures + per-conversation
 * visibility. The Document Generator persists into the generic
 * **AgentConversation** model (no document ref, no per-conversation
 * visibility), so that drawer cannot back this surface. We instead reuse the
 * shared, domain-agnostic pieces:
 *   - `<ChatHistoryGroup variant="editorial">` — the SAME bucketed list the
 *     project drawer renders (title, preview, message count, relative time).
 *   - `useConversationHistory(...)` — the existing AgentConversation list hook.
 *   - The project drawer's `<Sheet>` chrome + editorial header + empty-state
 *     idiom, so the two surfaces look identical.
 *
 * Visual constraints (project CLAUDE.md design context):
 *   - `bg-card` surface, `border-l border-border`; NO `backdrop-blur`, NO
 *     gradient orbs, NO hardcoded hex.
 *   - Editorial section label (thin red bar + uppercase tracked) + serif
 *     empty-state heading via `--font-serif`.
 */

import type { ChatHistoryGroupItem } from "@saas/ai/components/ChatHistoryGroup";
import { ChatHistoryGroup } from "@saas/ai/components/ChatHistoryGroup";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { useEffect, useMemo } from "react";
import {
	type ConversationSummary,
	useConversationHistory,
} from "../hooks/useConversationHistory";

/** Date buckets, mirrored from `CopilotHistoryDrawer`. */
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

export interface DocumentGeneratorHistoryDrawerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Surface agent id — scopes the AgentConversation list (XOR with org). */
	agentId: string;
	/** Active organization id (null in personal context). */
	organizationId: string | null;
	/** Conversation id of the currently-active (live) thread, highlighted. */
	activeConversationId: string | null;
	/**
	 * Loads the selected conversation into the live CopilotKit transcript.
	 * The drawer closes itself after invoking this.
	 */
	onSelectConversation: (conversationId: string) => void;
}

export function DocumentGeneratorHistoryDrawer({
	open,
	onOpenChange,
	agentId,
	organizationId,
	activeConversationId,
	onSelectConversation,
}: DocumentGeneratorHistoryDrawerProps) {
	// Pass the org id through as-is (string | null). `null` (personal context)
	// must NOT become `undefined`, or the server would session-fallback and list
	// a different tenant's conversations than where the writes target.
	const { conversations, isLoadingList, refetchList } =
		useConversationHistory({
			organizationId,
			agentId,
			limit: 50,
		});

	// Refetch on open so a turn persisted since the last fetch is reflected
	// immediately. The editor persists turns via `orpcClient` directly (not the
	// TanStack mutation hooks), so it never invalidates this list query; and this
	// drawer stays mounted (Radix Sheet toggles visibility, not mount), so
	// opening it does NOT remount the hook to trigger a stale refetch. An
	// explicit refetch on the open transition guarantees the just-created
	// conversation appears. `refetchList` is React Query's stable `refetch`.
	useEffect(() => {
		if (open) {
			void refetchList();
		}
	}, [open, refetchList]);

	// Bucket the conversations into Today / Yesterday / Last 7 days / Earlier
	// and adapt them to `ChatHistoryGroupItem`. Sort within each bucket by
	// `updatedAt DESC`.
	const buckets = useMemo(() => {
		const now = new Date();
		const map: Record<Bucket, ConversationSummary[]> = {
			today: [],
			yesterday: [],
			last7: [],
			earlier: [],
		};
		for (const item of conversations) {
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
	}, [conversations]);

	const groupItemsFor = (
		rows: ConversationSummary[],
	): ChatHistoryGroupItem[] =>
		rows.map((row) => ({
			id: row.id,
			title: row.title,
			previewText: row.lastMessage,
			messageCount: row.messageCount,
			updatedAt: row.updatedAt,
		}));

	const handleSelect = (id: string) => {
		onSelectConversation(id);
		onOpenChange(false);
	};

	const isEmpty = !isLoadingList && conversations.length === 0;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex h-full w-full max-w-full flex-col gap-0 border-l border-border bg-card p-0 sm:max-w-[420px]"
				aria-label="Document generator chat history"
			>
				<SheetTitle className="sr-only">
					Document generator chat history
				</SheetTitle>
				<SheetDescription className="sr-only">
					Browse and reopen prior AI Assistant conversations.
				</SheetDescription>

				{/* Editorial header */}
				<div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-3">
					<span
						aria-hidden="true"
						className="block h-3 w-0.5 rounded-sm bg-primary"
					/>
					<h2 className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						Chat history
					</h2>
				</div>

				{/* List */}
				<div
					role="listbox"
					aria-label="Conversations"
					className="flex-1 overflow-y-auto px-2 py-3"
				>
					{isLoadingList ? (
						<div className="space-y-2 px-2">
							<Skeleton className="h-16 w-full rounded-md" />
							<Skeleton className="h-16 w-full rounded-md" />
							<Skeleton className="h-16 w-full rounded-md" />
						</div>
					) : isEmpty ? (
						<EmptyState />
					) : (
						BUCKET_ORDER.map((key) =>
							buckets[key].length > 0 ? (
								<ChatHistoryGroup
									key={key}
									variant="editorial"
									label={BUCKET_LABEL[key]}
									items={groupItemsFor(buckets[key])}
									selectedId={activeConversationId}
									onSelect={handleSelect}
								/>
							) : null,
						)
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

/**
 * Empty-state for the no-conversations case. Mirrors the project drawer's
 * editorial label + serif heading.
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
				Chat with the AI Assistant — your conversations will appear
				here.
			</p>
		</div>
	);
}
