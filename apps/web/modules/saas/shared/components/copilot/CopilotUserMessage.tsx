"use client";

import type { UserMessageProps } from "@copilotkit/react-ui";
import { Paperclip } from "lucide-react";
import { useAttachmentRegistry } from "./AttachmentRegistry";
import { MessageAttachmentList } from "./MessageAttachmentList";
import {
	formatMessageTimestamp,
	type TimestampSource,
} from "./formatMessageTimestamp";

/**
 * Defense-in-depth strip for the legacy `<attached_documents>` envelope from
 * older chat-history persisted before PR #722 / #723. Current
 * `createCopilotSidebarInput` no longer inlines attachment content into the
 * user message — content is delivered to the agent via the rag-context
 * channel (`useCopilotReadable` with description containing "rag context").
 */
const ATTACHED_DOCUMENTS_BLOCK_RE =
	/\n*<attached_documents>[\s\S]*?<\/attached_documents>\n*/g;

/**
 * Compact attachment hint line the factory now appends so the bubble can
 * render attachment chips beneath the typed prompt and the agent has a
 * lightweight reminder (filename only, no IDs / no content) that files are
 * staged for this turn.
 *
 *   …user prompt…
 *   [Attached: a.txt, b.png]
 */
const ATTACHED_LINE_RE = /\n*\[Attached:\s*([^\]\n]+)\]\s*$/;

type UserMessageContent = NonNullable<UserMessageProps["message"]>["content"];
type ContentPart = Extract<UserMessageContent, readonly unknown[]>[number];

function getTextContent(
	content: UserMessageContent | undefined,
): string | undefined {
	if (typeof content === "undefined") {
		return undefined;
	}

	if (typeof content === "string") {
		return content;
	}

	return (
		content
			.map((part: ContentPart) => {
				if (part.type === "text") {
					return part.text;
				}
				return undefined;
			})
			.filter(
				(value: string | undefined): value is string =>
					typeof value === "string" && value.length > 0,
			)
			.join(" ")
			.trim() || undefined
	);
}

function parseAttachedLine(text: string): {
	cleanText: string;
	attachmentNames: string[];
} {
	const match = text.match(ATTACHED_LINE_RE);
	if (!match) {
		return { cleanText: text, attachmentNames: [] };
	}
	const namesPart = match[1] ?? "";
	const names = namesPart
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const cleanText = text.replace(ATTACHED_LINE_RE, "").trim();
	return { cleanText, attachmentNames: names };
}

/**
 * Render attachment names as a discreet caption rendered OUTSIDE the user
 * bubble (right-aligned beneath it, no surface, no border) so the
 * filename reads like metadata rather than a chip. Uses
 * `text-muted-foreground` so it adapts to both light and dark themes via
 * the design-system tokens.
 */
function renderAttachmentCaption(names: string[]) {
	if (names.length === 0) {
		return null;
	}
	return (
		<div className="mt-1 flex flex-wrap justify-end gap-x-3 gap-y-0.5 px-1 text-[11px] text-muted-foreground/70">
			{names.map((name) => (
				<span key={name} className="inline-flex items-center gap-1">
					<Paperclip className="h-2.5 w-2.5" aria-hidden="true" />
					<span className="max-w-[220px] truncate">{name}</span>
				</span>
			))}
		</div>
	);
}

/**
 * Render the per-message timestamp as a small, muted `<time>` element
 * below the bubble (right-aligned for user messages). The `title`
 * attribute carries the full date + time in the reader's local timezone
 * so hovering shows the exact moment in their own wall-clock.
 *
 * Returns `null` when there is no usable timestamp on the source —
 * callers can mount this unconditionally.
 */
function renderMessageTimestamp(
	source: TimestampSource,
	align: "end" | "start",
) {
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
 * Custom CopilotKit UserMessage:
 *   1. Strips any legacy `<attached_documents>` envelope from old chat
 *      history (defense in depth).
 *   2. Parses the trailing `[Attached: …]` hint and renders the
 *      filenames as a discreet caption *underneath* the bubble (no
 *      background, themed muted text).
 *
 * The bubble itself only contains the typed prompt — keeping the chip
 * outside the wrapper means it does not pick up the bubble's background
 * colour and does not visually compete with the message content.
 */
export function CopilotUserMessage(props: UserMessageProps) {
	const { message, ImageRenderer } = props;
	const isImageMessage =
		message && "image" in message && Boolean(message.image);

	const rawContent = getTextContent(message?.content) ?? "";
	const withoutEnvelope = rawContent
		.replace(ATTACHED_DOCUMENTS_BLOCK_RE, "")
		.trim();
	const { cleanText, attachmentNames } = parseAttachedLine(withoutEnvelope);

	// Live attachment registry — surfaces with the document-assistant
	// chat-history feature ON (DocumentEditor + StoryWorkspace) mount the
	// `<AttachmentRegistryProvider>` above their `<CopilotSidebar>`, so
	// `useAttachmentRegistry()` returns a populated registry here. When
	// the user just sent a message with one or more file uploads, the
	// registry already has the batch keyed by this message id and we
	// render the rich `<MessageAttachmentList>` (inline image previews +
	// file chips) instead of the legacy filename-only caption. Surfaces
	// WITHOUT the provider (e.g. the standalone Fabric AI page) get back
	// `null` and the legacy caption path stays in place.
	const messageId =
		message && typeof (message as { id?: unknown }).id === "string"
			? (message as { id: string }).id
			: null;
	const registry = useAttachmentRegistry();
	const registeredAttachments = messageId
		? (registry?.get(messageId) ?? null)
		: null;
	const hasRichAttachments =
		Array.isArray(registeredAttachments) &&
		registeredAttachments.length > 0;

	// `message` carries the runtime timestamp on `createdAt` (CopilotKit
	// runtime) or our persisted `timestamp` (when SSR-hydrated). The
	// formatter takes both shapes so we don't need to coerce here.
	const timestampSource = (message ?? {}) as TimestampSource;

	if (isImageMessage) {
		const imageMessage = message!;
		return (
			<>
				<div className="copilotKitMessage copilotKitUserMessage">
					<ImageRenderer
						image={imageMessage.image!}
						content={cleanText}
					/>
				</div>
				{hasRichAttachments ? (
					<MessageAttachmentList
						attachments={registeredAttachments!}
					/>
				) : (
					renderAttachmentCaption(attachmentNames)
				)}
				{renderMessageTimestamp(timestampSource, "end")}
			</>
		);
	}

	// File-only send: typed text is empty after parsing the [Attached: …]
	// line out, so we skip the empty bubble entirely and let the
	// attachment row stand on its own. Without this an empty
	// `<div class="…UserMessage">` renders as a tiny coloured square
	// (just the bubble background) above the filename.
	if (!cleanText) {
		if (hasRichAttachments) {
			return (
				<>
					<MessageAttachmentList
						attachments={registeredAttachments!}
					/>
					{renderMessageTimestamp(timestampSource, "end")}
				</>
			);
		}
		if (attachmentNames.length > 0) {
			return (
				<>
					{renderAttachmentCaption(attachmentNames)}
					{renderMessageTimestamp(timestampSource, "end")}
				</>
			);
		}
	}

	return (
		<>
			<div className="copilotKitMessage copilotKitUserMessage">
				{cleanText}
			</div>
			{hasRichAttachments ? (
				<MessageAttachmentList attachments={registeredAttachments!} />
			) : (
				renderAttachmentCaption(attachmentNames)
			)}
			{renderMessageTimestamp(timestampSource, "end")}
		</>
	);
}
