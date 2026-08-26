"use client";

import { useCopilotChatInternal } from "@copilotkit/react-core";
import { useChatContext } from "@copilotkit/react-ui";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	HistoryIcon,
	LockIcon,
	PlusIcon,
	UsersIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.3 FR-10,
 *       §3.5 FR-17 / FR-18, §6.2, §6.6, AC-8, AC-13, AC-16.
 *
 * Custom CopilotSidebar header rendered via the `Header` slot on
 * `<CopilotSidebar>` (see `apps/web/node_modules/@copilotkit/react-ui/src/
 * components/chat/Modal.tsx`, line 70 — `Header?: React.ComponentType<HeaderProps>`).
 * The slot is instantiated by CopilotKit with NO props, so this module exposes
 * a `createCopilotSidebarHeader(config)` factory that closes over the wiring
 * the parent component already has — mirrors the same pattern used by
 * `createCopilotSidebarInput()` (`apps/web/modules/saas/shared/components/
 * copilot/CopilotSidebarInput.tsx`).
 *
 * Layout: left to right —
 *   1. Title (FR copy supplied by parent or default "AI Assistant").
 *   2. Visibility chip — toggle pre-lock, locked `<span>` post-lock.
 *   3. Plus-icon "New conversation" button.
 *   4. History-icon "Open chat history" button.
 *
 * Visual constraints (project CLAUDE.md design context):
 *   - `bg-card` surface; `border-b border-border`; NO `backdrop-blur`,
 *     NO gradient orbs, NO hardcoded hex.
 *   - All transitions `transition-colors` / `transition-opacity`. No
 *     `transition-all`. No `group-hover:scale-110`.
 *   - Tooltip copy lives in `tooltips.documentEditor.*` (i18n).
 */

export interface CopilotSidebarHeaderConfig {
	title?: string;
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	documentRefId: string;
	projectId: string;
	organizationId: string | null;
	/**
	 * Active conversation row id, or null when no thread has been persisted
	 * yet (pre-first-send). Drives both:
	 *   - whether the visibility toggle calls `setVisibilityForDocument`
	 *     (server has nothing to set yet → local optimistic only), and
	 *   - whether the plus-icon archives anything before resetting state.
	 */
	conversationId: string | null;
	visibility: "SHARED" | "PRIVATE";
	visibilityLockedAt: string | null;
	onNewConversation: () => void;
	onOpenHistory: () => void;
	/**
	 * Lifts the pre-first-send visibility toggle up to the parent so the
	 * `requestedVisibility` prop on `CopilotPersistenceHook` matches what
	 * the user picked. Without this, toggling the chip to PRIVATE before
	 * sending updates only the chip's local optimistic state — the parent
	 * keeps sending SHARED to `appendTurnForDocument` on lazy-create.
	 *
	 * Optional because non-document surfaces that mount this header may
	 * not care; if omitted, the toggle still flips the UI but the
	 * lazy-create will use the parent's last-known visibility.
	 */
	onVisibilityChange?: (next: "SHARED" | "PRIVATE") => void;
}

interface VisibilityChipProps {
	conversationId: string | null;
	organizationId: string | null;
	visibility: "SHARED" | "PRIVATE";
	visibilityLockedAt: string | null;
	onVisibilityChange?: (next: "SHARED" | "PRIVATE") => void;
}

/**
 * Two visual states driven from `visibilityLockedAt`:
 *
 *   - **Pre-first-send** (`visibilityLockedAt === null`): a `<button>` with
 *     `role="switch"` + `aria-pressed`. Click flips local optimistic state
 *     AND (when a conversation row exists already from an earlier turn
 *     that was archived but visibility-set) calls
 *     `agents.conversations.setVisibilityForDocument`. When `conversationId
 *     === null` there is no row to mutate yet — the new visibility is
 *     applied on the next `appendTurnForDocument` call via its
 *     `requestedVisibility` input (Group B append procedure).
 *
 *   - **Post-first-send** (`visibilityLockedAt !== null`): a non-focusable
 *     `<span>` with a lock-icon prefix. Per spec §6.6, this is NOT a
 *     disabled button — that would convey the wrong affordance. The chip
 *     stays out of the tab order so keyboard users skip it.
 */
function VisibilityChip({
	conversationId,
	organizationId,
	visibility,
	visibilityLockedAt,
	onVisibilityChange,
}: VisibilityChipProps) {
	const t = useTranslations("tooltips.documentEditor");
	// Local optimistic state — driven by props on mount, then by the user's
	// click while a mutation is in flight, and reverted on failure.
	const [optimisticVisibility, setOptimisticVisibility] =
		useState(visibility);
	const [optimisticLockedAt, setOptimisticLockedAt] =
		useState(visibilityLockedAt);
	const [isMutating, setIsMutating] = useState(false);

	// Re-sync from props if the parent receives a fresh
	// `getActiveForDocument` snapshot (e.g. after a "New conversation"
	// reset). Without this the chip would freeze on its last optimistic
	// value across conversation resets.
	useEffect(() => {
		setOptimisticVisibility(visibility);
		setOptimisticLockedAt(visibilityLockedAt);
	}, [visibility, visibilityLockedAt]);

	// Lock semantics: the conversation visibility is
	// frozen as soon as the first user-role message lands. The server
	// stamps `visibilityLockedAt` inside the `appendTurnForDocument`
	// transaction (`packages/api/.../append-turn-for-document.ts:387-394`),
	// but the server's response does NOT carry the new timestamp back
	// (see `return { conversationId, persistedAt, spilledTo }`), so the
	// prop-only chip used to stay in "unlocked" state until the next page
	// reload. Users saw "I just sent a message and the chip is still
	// toggleable" — exactly the symptom called out in the bug report.
	//
	// Fix: derive an EXTRA lock signal from the live CopilotKit messages
	// array. Once any user-role message is present, the conversation is
	// locked by spec definition — we don't need to wait for the server
	// round-trip to reflect that fact in the UI. The lock is either:
	//   - explicitly set on the prop (SSR-hydrated from DB, or set by a
	//     server response we DO propagate one day), OR
	//   - inferred from the live message store the sidebar reads from.
	const { messages: liveMessages } = useCopilotChatInternal();
	const liveHasUserMessage = liveMessages.some(
		(m) => (m as { role?: unknown }).role === "user",
	);
	const isLocked = optimisticLockedAt !== null || liveHasUserMessage;
	const isPrivate = optimisticVisibility === "PRIVATE";

	if (isLocked) {
		// Post-first-send: read-only chip. `tabIndex={-1}` keeps it out of the
		// tab order. `role="status"` makes the chip an accessible name
		// target so screen readers announce the locked state without
		// requiring an interactive role. Title-case label + people/lock
		// icons so the chip reads as a status indicator rather than a
		// shouty all-caps badge.
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span
						role="status"
						tabIndex={-1}
						aria-label={`Conversation visibility: ${
							isPrivate ? "Private" : "Shared"
						} (locked)`}
						className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-muted-foreground border border-border bg-muted/40"
					>
						{isPrivate ? (
							<LockIcon className="size-3" aria-hidden="true" />
						) : (
							<UsersIcon className="size-3" aria-hidden="true" />
						)}
						<span>{isPrivate ? "Private" : "Shared"}</span>
						<LockIcon
							className="size-2.5 text-muted-foreground/60"
							aria-label="Locked"
						/>
					</span>
				</TooltipTrigger>
				<TooltipContent>
					<p>{t("assistantVisibilityLocked")}</p>
				</TooltipContent>
			</Tooltip>
		);
	}

	const handleToggle = async () => {
		if (isMutating) {
			return;
		}
		const previous = optimisticVisibility;
		const next: "SHARED" | "PRIVATE" =
			previous === "PRIVATE" ? "SHARED" : "PRIVATE";

		// Optimistic flip — UI updates immediately, mutation reconciles.
		setOptimisticVisibility(next);

		// Lift the new value to the parent so the persistence hook's
		// `requestedVisibility` prop matches the user's choice on lazy-
		// create. Fires for BOTH the pre-conversation case (no server row
		// yet — this is the ONLY place the parent learns about the toggle)
		// AND the post-conversation case (parent state stays in sync with
		// what the server is also being told below).
		onVisibilityChange?.(next);

		// Pre-conversation case: no row to update yet. The `requestedVisibility`
		// input on `appendTurnForDocument` (Group B) will apply this on the
		// next persisted turn. No network call needed.
		if (conversationId === null) {
			return;
		}

		setIsMutating(true);
		try {
			const result =
				await orpcClient.agents.conversations.setVisibilityForDocument({
					conversationId,
					organizationId,
					visibility: next,
				});
			// Server is the authority. If the server returned `lockedAt`
			// (because we raced a first-send), reflect that locally so the
			// chip immediately becomes the read-only variant.
			if (result.conversation.visibilityLockedAt) {
				setOptimisticLockedAt(result.conversation.visibilityLockedAt);
			}
		} catch (err) {
			// Revert optimistic state and surface the server's message
			// (covers CONFLICT on raced lock per FR-18 / AC-8 as well as
			// FORBIDDEN / feature-flag-disabled).
			setOptimisticVisibility(previous);
			const message =
				err instanceof Error
					? err.message
					: "Could not change conversation visibility.";
			toast.error(message);
		} finally {
			setIsMutating(false);
		}
	};

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					role="switch"
					aria-checked={isPrivate}
					aria-label={`Conversation visibility: ${
						isPrivate ? "Private" : "Shared"
					}`}
					onClick={handleToggle}
					disabled={isMutating}
					className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:opacity-60 disabled:cursor-not-allowed border-border bg-background hover:bg-muted text-foreground"
				>
					{isPrivate ? (
						<LockIcon className="size-3" aria-hidden="true" />
					) : (
						<UsersIcon className="size-3" aria-hidden="true" />
					)}
					<span>{isPrivate ? "Private" : "Shared"}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent>
				<p>
					{isPrivate
						? t("assistantVisibilityPrivate")
						: t("assistantVisibilityShared")}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

interface CopilotSidebarHeaderProps {
	config: CopilotSidebarHeaderConfig;
}

export function CopilotSidebarHeader({ config }: CopilotSidebarHeaderProps) {
	const t = useTranslations("tooltips.documentEditor");
	// CopilotKit's open/close state for this sidebar. The default CopilotKit
	// header exposes a close button via this same hook (see `Header.tsx` in
	// `@copilotkit/react-ui`); when this custom header replaced that slot it
	// dropped the close affordance, so re-add one below.
	const { setOpen } = useChatContext();
	const {
		title = "AI Assistant",
		conversationId,
		organizationId,
		visibility,
		visibilityLockedAt,
		onNewConversation,
		onOpenHistory,
		onVisibilityChange,
	} = config;

	return (
		<TooltipProvider delayDuration={300}>
			<div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card">
				<div className="flex-1 min-w-0">
					<span className="text-sm font-medium text-foreground truncate">
						{title}
					</span>
				</div>

				<VisibilityChip
					conversationId={conversationId}
					organizationId={organizationId}
					visibility={visibility}
					visibilityLockedAt={visibilityLockedAt}
					onVisibilityChange={onVisibilityChange}
				/>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={onNewConversation}
							aria-label="Start a new conversation"
							className="text-muted-foreground hover:text-foreground transition-colors duration-150"
						>
							<PlusIcon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>{t("assistantNewConversation")}</p>
					</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={onOpenHistory}
							aria-label="Open chat history"
							className="text-muted-foreground hover:text-foreground transition-colors duration-150"
						>
							<HistoryIcon
								className="size-4"
								aria-hidden="true"
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>{t("assistantOpenHistory")}</p>
					</TooltipContent>
				</Tooltip>

				{/* Panel chrome: a thin divider sets the close control apart
				    from the conversation actions (new conversation / history). */}
				<div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() => setOpen(false)}
							aria-label="Close the AI Assistant panel"
							className="text-muted-foreground hover:text-foreground transition-colors duration-150"
						>
							<XIcon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>{t("assistantClose")}</p>
					</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
}

/**
 * Factory that wraps `<CopilotSidebarHeader>` so it can be passed to
 * `<CopilotSidebar Header={...}>`. CopilotKit instantiates the `Header`
 * component with no props, so the closure captures the wiring.
 */
export function createCopilotSidebarHeader(config: CopilotSidebarHeaderConfig) {
	function CopilotSidebarHeaderSlot() {
		return <CopilotSidebarHeader config={config} />;
	}
	return CopilotSidebarHeaderSlot;
}
