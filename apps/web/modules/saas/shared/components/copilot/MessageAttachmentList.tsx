"use client";

/**
 * `MessageAttachmentList` — shared attachment renderer used by BOTH the live
 * user message bubble (`<CopilotUserMessage>`) and the historical
 * read-only viewer (`<ConversationViewer>`). Lives in the shared `copilot/`
 * module so both consumers reach for the same visual idiom without one
 * importing from the other (the live message can't depend on the document-
 * assistant package).
 *
 * Image attachments render inline as `<a><img></a>` previews so a click
 * opens the full-size download in a new tab. File attachments render as a
 * Paperclip chip linking to the same signed URL. When `previewUrl` is
 * missing (signing failed, no key yet) the chip degrades to a plain text
 * label so the row still tells the truth.
 *
 * The shape mirrors `MessageAttachmentSchema` on the server and the
 * `PendingAttachment` envelope the persistence pipeline ships; consumers
 * that hold a data URL (e.g. fresh paperclip upload before the persisted
 * round-trip) can pass it as `previewUrl` and the renderer treats it
 * identically.
 */

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Paperclip } from "lucide-react";
import { useTranslations } from "next-intl";

export interface MessageAttachmentListItem {
	id?: string;
	s3Path?: string;
	name?: string;
	mimeType?: string;
	sizeBytes?: number;
	kind?: "image" | "file";
	/**
	 * Filled by `getActiveForDocument` / `getByIdForDocument` with a
	 * freshly-signed time-limited GET URL, or by the input pipeline with
	 * a base64 data URL for instant in-session preview. Optional because
	 * signing can fail and the live pipeline may settle on the URL after
	 * the chip first renders.
	 */
	previewUrl?: string;
}

function isImageAttachment(att: MessageAttachmentListItem): boolean {
	if (att.kind === "image") {
		return true;
	}
	if (att.kind === "file") {
		return false;
	}
	return (
		typeof att.mimeType === "string" && att.mimeType.startsWith("image/")
	);
}

interface Props {
	attachments: MessageAttachmentListItem[];
	/**
	 * Anchor alignment for the row. Defaults to `"end"` so the
	 * attachment captions stack right under a user bubble that's
	 * right-aligned in the chat. Set to `"start"` for an assistant or
	 * left-aligned source.
	 */
	align?: "start" | "end";
}

/**
 * Render a row's attachments. Images first (inline previews), then file
 * chips. When `attachments` is empty / undefined, returns `null` so a
 * caller can mount this unconditionally without an outer guard.
 */
export function MessageAttachmentList({ attachments, align = "end" }: Props) {
	// Declared before the empty-list early return so the hook order stays stable.
	const t = useTranslations("tooltips.copilot");
	if (!attachments || attachments.length === 0) {
		return null;
	}
	const images = attachments.filter(isImageAttachment);
	const files = attachments.filter((att) => !isImageAttachment(att));
	const containerAlign = align === "end" ? "items-end" : "items-start";
	const chipAlign = align === "end" ? "justify-end" : "justify-start";
	return (
		<div className={`mt-1 flex flex-col gap-1.5 ${containerAlign}`}>
			{images.length > 0 ? (
				<div className={`flex flex-wrap gap-1.5 ${chipAlign}`}>
					{images.map((att, idx) =>
						att.previewUrl ? (
							// The nested `<img alt>` already names this link, so no
							// `aria-label` — it would replace that name. The tooltip
							// only describes what the click does.
							<Tooltip key={att.id ?? `img-${idx}`}>
								<TooltipTrigger asChild>
									<a
										href={att.previewUrl}
										target="_blank"
										rel="noreferrer"
										className="block overflow-hidden rounded-md border border-border bg-muted/40 shadow-sm motion-safe:transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
									>
										{/* biome-ignore lint/a11y/useAltText: dynamic */}
										<img
											src={att.previewUrl}
											alt={att.name ?? "Attached image"}
											loading="lazy"
											className="block max-h-56 max-w-[280px] object-contain"
										/>
									</a>
								</TooltipTrigger>
								<TooltipContent>
									{t("attachedImage")}
								</TooltipContent>
							</Tooltip>
						) : (
							<Tooltip key={att.id ?? `img-${idx}`}>
								<TooltipTrigger asChild>
									<span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
										<Paperclip
											className="size-3"
											aria-hidden="true"
										/>
										<span className="max-w-[220px] truncate">
											{att.name ?? "Image"}
										</span>
										{/* Not focusable, so the portalled tooltip is
											pointer-only. `aria-label` would replace the
											visible filename in the accessible name — an
											`sr-only` child adds the reason alongside it. */}
										<span className="sr-only">
											{t("attachmentPreviewUnavailable")}
										</span>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									{t("attachmentPreviewUnavailable")}
								</TooltipContent>
							</Tooltip>
						),
					)}
				</div>
			) : null}
			{files.length > 0 ? (
				<div
					className={`flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground/80 ${chipAlign}`}
				>
					{files.map((att, idx) => {
						const label = att.name ?? "Attached file";
						return att.previewUrl ? (
							<Tooltip key={att.id ?? `file-${idx}`}>
								<TooltipTrigger asChild>
									<a
										href={att.previewUrl}
										target="_blank"
										rel="noreferrer"
										className="inline-flex items-center gap-1 rounded-sm hover:text-foreground motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
									>
										<Paperclip
											className="size-2.5"
											aria-hidden="true"
										/>
										<span className="max-w-[220px] truncate">
											{label}
										</span>
									</a>
								</TooltipTrigger>
								<TooltipContent>{label}</TooltipContent>
							</Tooltip>
						) : (
							<Tooltip key={att.id ?? `file-${idx}`}>
								<TooltipTrigger asChild>
									<span className="inline-flex items-center gap-1">
										<Paperclip
											className="size-2.5"
											aria-hidden="true"
										/>
										<span className="max-w-[220px] truncate">
											{label}
										</span>
										{/* Not focusable, so the portalled tooltip is
											pointer-only. `aria-label` would replace the
											visible filename in the accessible name — an
											`sr-only` child adds the reason alongside it. */}
										<span className="sr-only">
											{t("attachmentDownloadUnavailable")}
										</span>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									{t("attachmentDownloadUnavailable")}
								</TooltipContent>
							</Tooltip>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
