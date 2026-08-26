"use client";

/**
 * `ConversationViewer` — Group F.13.
 *
 * Read-only renderer for a persisted document-assistant conversation. Used
 * by `<CopilotHistoryDrawer>` for both the active-thread branch (data from
 * `useActiveDocumentAssistantConversation`) and the prior-conversation
 * branch (data from `useDocumentAssistantConversationById`). Extracting
 * this into its own file keeps the drawer's data orchestration distinct
 * from the message-render layer and gives the unit tests a stable surface
 * to mount.
 *
 * Why we don't mount `<CopilotAssistantMessage>` / `<CopilotUserMessage>`
 * directly: those components depend on CopilotKit's `useChatContext` /
 * `useCoAgent` runtime, neither of which is available when rendering a
 * historical conversation. Re-using the `copilotKit*` CSS classes keeps
 * the visual idiom identical without dragging in the live-chat runtime.
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.4 FR-14, §3.8
 * FR-23, §6.3.
 */

import { formatMessageTimestamp } from "@saas/shared/components/copilot/formatMessageTimestamp";
import { MessageAttachmentList } from "@saas/shared/components/copilot/MessageAttachmentList";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { GitForkIcon, Loader2Icon, Paperclip } from "lucide-react";
import { useTranslations } from "next-intl";
import { DiffOutcomeChip } from "./DiffOutcomeChip";

/**
 * Per-message "Fork from here" button. Mounted under user-message bubbles
 * when the parent surface accepted an `onForkFromMessage` callback (i.e.
 * the author owns the conversation and the parent is wired for fork
 * routing). The mount point under a USER message is intentional — forking
 * mid-assistant-reply would split a response in half, which is rarely
 * what a PM wants. Forking after a user prompt copies the exact context
 * the agent saw to produce that reply, which is what the AC asks for.
 *
 * Disabled while the mutation is in flight to keep the user from
 * triple-clicking it on a slow request.
 */
function ForkFromHereButton({
	messageId,
	onFork,
	disabled,
}: {
	messageId: string;
	onFork: (messageId: string) => void;
	disabled: boolean;
}) {
	const t = useTranslations("tooltips.copilot");
	return (
		<div className="mt-1 flex justify-end px-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={() => onFork(messageId)}
						disabled={disabled}
						className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 motion-safe:transition-colors disabled:opacity-50"
						// No `aria-label`: the visible text ("Fork from here") names
						// this button. The label that used to sit here did not contain
						// that visible string, so it replaced the accessible name with
						// something that did not match what was on screen (WCAG 2.5.3
						// Label in Name). The long explanation now lives in the tooltip,
						// which Radix exposes as the button's description.
					>
						{disabled ? (
							<Loader2Icon
								className="size-3 animate-spin"
								aria-hidden="true"
							/>
						) : (
							<GitForkIcon
								className="size-3"
								aria-hidden="true"
							/>
						)}
						Fork from here
					</button>
				</TooltipTrigger>
				<TooltipContent>{t("forkFromHere")}</TooltipContent>
			</Tooltip>
		</div>
	);
}

/**
 * Read-only timestamp rendered under each persisted message in the
 * drawer's viewer pane. Visual treatment matches the live chat
 * (`CopilotUserMessage` / `CopilotAssistantMessage`) so the bubble
 * idiom stays identical: small, muted `<time>` with the local-timezone
 * date + time in the `title` attribute for hover precision.
 *
 * Returns `null` when the persisted message has no `timestamp` field,
 * which can happen for very old rows persisted before the schema bump.
 */
function ReadOnlyMessageTimestamp({
	source,
	align,
}: {
	source: { timestamp?: string | null };
	align: "end" | "start";
}) {
	const formatted = formatMessageTimestamp(source);
	if (!formatted) {
		return null;
	}
	const alignClass = align === "end" ? "justify-end" : "justify-start";
	return (
		<div
			className={`mt-0.5 flex ${alignClass} px-1 text-[10px] text-muted-foreground/60`}
		>
			<time dateTime={formatted.iso} title={formatted.tooltip}>
				{formatted.label}
			</time>
		</div>
	);
}

/**
 * The CopilotSidebarInput appends a trailing `[Attached: name1, name2]`
 * line to the user message body before send (see
 * `createCopilotSidebarInput`). The live `<CopilotUserMessage>` strips
 * this line and renders the names as discreet Paperclip chips beneath
 * the bubble. We mirror that here so the historical viewer doesn't
 * surface the raw text "[Attached: foo.png]" inside the user bubble.
 *
 * Image-blob persistence is intentionally NOT handled here: the
 * `MessageSchema` (`packages/api/.../update-conversation.ts`) does not
 * round-trip the live `image` field, and signed S3 URLs would expire
 * within the hour anyway. Re-signing requires a schema bump + new
 * activity on the server to mint fresh URLs from the stored S3 key on
 * each read. Tracked separately so we don't ship a half-working preview
 * that 403s in production.
 */
const ATTACHED_LINE_RE = /\n*\[Attached:\s*([^\]\n]+)\]\s*$/;

function parseAttachedLine(text: string): {
	cleanText: string;
	attachmentNames: string[];
} {
	const match = text.match(ATTACHED_LINE_RE);
	if (!match) {
		return { cleanText: text, attachmentNames: [] };
	}
	const names = (match[1] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const cleanText = text.replace(ATTACHED_LINE_RE, "").trim();
	return { cleanText, attachmentNames: names };
}

function AttachmentCaption({ names }: { names: string[] }) {
	if (names.length === 0) {
		return null;
	}
	return (
		<div className="mt-1 flex flex-wrap justify-end gap-x-3 gap-y-0.5 px-1 text-[11px] text-muted-foreground/70">
			{names.map((name) => (
				<span key={name} className="inline-flex items-center gap-1">
					<Paperclip className="size-2.5" aria-hidden="true" />
					<span className="max-w-[220px] truncate">{name}</span>
				</span>
			))}
		</div>
	);
}

// Per-message attachment rendering is shared with the live
// `<CopilotUserMessage>` via `<MessageAttachmentList>` so the historical
// viewer and the live chat bubble look identical (same border, same
// preview clamp, same chip styling). This file used to duplicate the
// component; the duplication was removed when the live-chat parity work
// landed.

interface PersistedToolCall {
	id?: string;
	name?: string;
	args?: Record<string, unknown>;
	result?: string;
	status?: string;
	acceptedAt?: string | null;
	rejectedAt?: string | null;
}

/**
 * Persisted attachment as read back by `getActiveForDocument` /
 * `getByIdForDocument` (which sign a fresh `previewUrl` from `s3Path`
 * on every call — see `resignMessageAttachments` in `_shared.ts`).
 *
 * `kind` discriminates rendering: `image` MIMEs get an inline preview;
 * everything else renders as a Paperclip chip with a download link.
 * Older rows may not carry `kind` (the field was added in this PR), so
 * the viewer infers it from `mimeType` as a fallback.
 */
interface PersistedAttachment {
	id?: string;
	s3Path?: string;
	name?: string;
	mimeType?: string;
	sizeBytes?: number;
	kind?: "image" | "file";
	previewUrl?: string;
}

export interface PersistedConversationMessage {
	id?: string;
	role?: "user" | "assistant" | "system" | string;
	content?: string;
	timestamp?: string;
	toolCalls?: PersistedToolCall[];
	reasoningText?: string;
	reasoningDurationMs?: number;
	streamStatus?: string;
	cancelledAt?: string | null;
	attachments?: PersistedAttachment[];
}

/**
 * Render one persisted message turn. Uses the same `copilotKit*` CSS
 * classes the live chat renders so the visual idiom is identical without
 * dragging in CopilotKit's chat context.
 */
function ReadOnlyMessage({
	message,
	onForkFromMessage,
	isForkPending,
}: {
	message: PersistedConversationMessage;
	/** When provided, render a "Fork from here" button under user-role
	 * messages that have a stable id. Omit to suppress the affordance. */
	onForkFromMessage?: (messageId: string) => void;
	/** Disable the fork button while a mutation is in flight (any fork in
	 * this drawer instance, not just this specific message). */
	isForkPending: boolean;
}) {
	const role = message.role;
	const canForkFromHere =
		role === "user" &&
		typeof message.id === "string" &&
		message.id.length > 0 &&
		typeof onForkFromMessage === "function";
	if (role === "user") {
		const { cleanText, attachmentNames } = parseAttachedLine(
			message.content ?? "",
		);
		// Prefer the new persisted-attachments shape when present (richer:
		// includes S3-signed previewUrls + MIME so we can render images
		// inline). Fall back to the legacy `[Attached: …]` filename
		// parsing for messages persisted before the schema bump — the
		// History drawer should never lose attachment context on a
		// reload.
		const persistedAttachments = message.attachments ?? [];
		const hasPersistedAttachments = persistedAttachments.length > 0;
		// File-only send: empty text + no persisted attachments + only the
		// legacy `[Attached: …]` filename hint. Skip the empty bubble.
		if (
			!cleanText &&
			!hasPersistedAttachments &&
			attachmentNames.length > 0
		) {
			return (
				<>
					<AttachmentCaption names={attachmentNames} />
					<ReadOnlyMessageTimestamp source={message} align="end" />
					{canForkFromHere && message.id ? (
						<ForkFromHereButton
							messageId={message.id}
							// Non-null assertion: `canForkFromHere` is true
							// only when `onForkFromMessage` is a function.
							onFork={onForkFromMessage!}
							disabled={isForkPending}
						/>
					) : null}
				</>
			);
		}
		// File-only send with the new persisted shape — no bubble either.
		if (!cleanText && hasPersistedAttachments) {
			return (
				<>
					<MessageAttachmentList attachments={persistedAttachments} />
					<ReadOnlyMessageTimestamp source={message} align="end" />
					{canForkFromHere && message.id ? (
						<ForkFromHereButton
							messageId={message.id}
							// Non-null assertion: `canForkFromHere` is true
							// only when `onForkFromMessage` is a function.
							onFork={onForkFromMessage!}
							disabled={isForkPending}
						/>
					) : null}
				</>
			);
		}
		return (
			<>
				<div className="copilotKitMessage copilotKitUserMessage">
					{cleanText}
				</div>
				{hasPersistedAttachments ? (
					<MessageAttachmentList attachments={persistedAttachments} />
				) : (
					<AttachmentCaption names={attachmentNames} />
				)}
				<ReadOnlyMessageTimestamp source={message} align="end" />
				{canForkFromHere && message.id ? (
					<ForkFromHereButton
						messageId={message.id}
						// Non-null assertion: `canForkFromHere` is true only
						// when `onForkFromMessage` is a function — see the
						// boolean expression at the top of this component.
						onFork={onForkFromMessage!}
						disabled={isForkPending}
					/>
				) : null}
			</>
		);
	}
	if (role === "assistant") {
		return (
			<>
				<div className="copilotKitMessage copilotKitAssistantMessage">
					{message.reasoningText ? (
						<details className="mb-2 rounded border border-border bg-muted/40 p-2 text-xs">
							<summary className="cursor-pointer text-muted-foreground">
								Reasoning
								{typeof message.reasoningDurationMs === "number"
									? ` (${Math.round(
											message.reasoningDurationMs / 1000,
										)}s)`
									: ""}
							</summary>
							<pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-muted-foreground">
								{message.reasoningText}
							</pre>
						</details>
					) : null}
					<div className="whitespace-pre-wrap text-sm">
						{message.content}
					</div>
					{Array.isArray(message.toolCalls) &&
					message.toolCalls.length > 0 ? (
						<div className="mt-3 space-y-1.5">
							{message.toolCalls.map((tc, idx) => (
								<div
									key={
										tc.id ??
										`${message.id ?? "msg"}-tc-${idx}`
									}
									className="flex items-center gap-2 rounded border border-border bg-background/40 px-2 py-1 text-xs"
								>
									<span className="font-mono text-muted-foreground">
										{tc.name ?? "tool"}
									</span>
									<DiffOutcomeChip toolCall={tc} />
								</div>
							))}
						</div>
					) : null}
				</div>
				<ReadOnlyMessageTimestamp source={message} align="start" />
			</>
		);
	}
	// System / unknown roles — render as muted note for completeness.
	return (
		<>
			<div className="text-xs italic text-muted-foreground">
				{message.content}
			</div>
			<ReadOnlyMessageTimestamp source={message} align="start" />
		</>
	);
}

export interface ConversationViewerProps {
	messages: PersistedConversationMessage[];
	/**
	 * Optional empty-state copy when `messages` is empty. Default copy
	 * assumes the active-thread fallback path; the prior-conversation path
	 * passes its own ("Conversation not found") via `emptyCopy`.
	 */
	emptyCopy?: string;
	/**
	 * Per-message fork callback. When provided, each user-role message
	 * renders a "Fork from here" button that calls this with the
	 * message's id. The drawer holds the actual mutation + slice
	 * derivation; this component just hooks the click into the parent.
	 *
	 * Omit to suppress the affordance entirely (e.g. non-author viewers,
	 * unit-test mounts).
	 */
	onForkFromMessage?: (messageId: string) => void;
	/** True while a fork mutation is in flight — disables the per-message
	 * buttons so the user can't fire two forks back-to-back. */
	isForkPending?: boolean;
}

/**
 * Read-only conversation viewer. Renders each turn with the `copilotKit*`
 * CSS idiom; the parent owns scroll containment + headers + continuation
 * linkage.
 */
export function ConversationViewer({
	messages,
	emptyCopy,
	onForkFromMessage,
	isForkPending = false,
}: ConversationViewerProps) {
	if (messages.length === 0) {
		return (
			<p className="text-xs italic text-muted-foreground">
				{emptyCopy ??
					"Open the conversation in the live thread to view its messages."}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			{messages.map((message, idx) => (
				<ReadOnlyMessage
					key={message.id ?? `msg-${idx}`}
					message={message}
					onForkFromMessage={onForkFromMessage}
					isForkPending={isForkPending}
				/>
			))}
		</div>
	);
}
