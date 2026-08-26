"use client";

import type {
	AiChatExtractedSheet,
	AiChatExtractionOutcome,
} from "@repo/utils/ai-chat-attachment";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangle,
	CheckCircle2,
	FileIcon,
	FileText,
	ImageIcon,
	Loader2,
	X,
	XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type RefObject, useEffect, useRef } from "react";
import type { AttachedFile } from "./use-copilot-document-upload";

/**
 * Name every sheet that was read, marking the ones Excel hides (R10).
 *
 * This is the line that makes extraction visible rather than WYSIWYG-assumed. A
 * user attaching a third-party workbook has no way to know it carries a hidden
 * tab, and attaching it publishes that tab's contents into the chat and, via the
 * chunking workflow, into the tenant knowledge base. Naming the sheets is what
 * turns that from a silent side effect into a decision.
 */
function formatSheetList(sheets: readonly AiChatExtractedSheet[]): string {
	return sheets
		.map((sheet) => (sheet.hidden ? `${sheet.name} (hidden)` : sheet.name))
		.join(", ");
}

function sheetLines(sheets: readonly AiChatExtractedSheet[]): string[] {
	if (sheets.length === 0) {
		return [];
	}
	const lines = [`Sheets read: ${formatSheetList(sheets)}`];
	if (sheets.some((sheet) => sheet.hidden)) {
		lines.push("Hidden sheets are included in what the assistant reads.");
	}
	return lines;
}

interface ExtractionNotice {
	/** Whether this warrants the amber marker rather than the plain check. */
	warn: boolean;
	lines: string[];
}

/**
 * What the chip has to say about what was actually read, or `null` when there is
 * nothing worth saying.
 *
 * `warn` and `lines` are separate because they answer different questions. A
 * clean two-sheet workbook has lines (the sheet list — R10 wants it available
 * whatever the outcome) but nothing wrong with it, so it keeps the green check.
 * A hidden sheet flips `warn` on its own: that disclosure is the whole reason
 * R10 exists, and a marker the user has to hover to discover would not deliver
 * it.
 *
 * Copy is hardcoded per the plan's constraint, and follows
 * `fabric/standards/ai/ai-copy-tone.md` — advisory, never commanding.
 *
 * KNOWN EXEMPTION, and it grew. Every sentence below is English in the source
 * rather than a translation key, which the tooltip standard forbids. It was
 * already the case for the workbook outcomes; the character-budget variant
 * ("N characters omitted") and the count-less fallback were added on top, and
 * this note is here so that widening is on the record rather than silent.
 *
 * Moving it is not a rename: these strings interpolate counts and a joined
 * sheet list, so they need ICU plural and list formatting, not string swaps —
 * and this component now renders on all three attachment surfaces, so the keys
 * have to be right the first time. Worth doing as its own change; not worth
 * half-doing inside a security and parity one.
 */
function describeExtraction(
	extraction: AiChatExtractionOutcome | undefined,
): ExtractionNotice | null {
	// Undefined for text/image chips (read client-side, never server-extracted).
	// `skipped` means extraction never ran because the document was already
	// processed — nothing was attempted, so there is nothing to report.
	if (!extraction || extraction.status === "skipped") {
		return null;
	}

	switch (extraction.status) {
		case "failed":
			// Already a rendered, user-facing sentence naming the cause and the
			// next step — the server is the only layer that knows which it was.
			return { warn: true, lines: [extraction.reason] };

		case "empty":
			return {
				warn: true,
				lines: [
					"This file carries no text the assistant can read.",
					...sheetLines(extraction.sheets),
				],
			};

		case "truncated": {
			// Two producers reach this state and they count different things:
			// the workbook walk omits rows, the client-side character budget
			// omits characters. Naming rows for a `.md` file would be a lie, and
			// naming neither would leave the user with "part of this file" and
			// no sense of how much.
			const omittedRowCount = extraction.omittedRowCount;
			const omittedCharCount = extraction.omittedCharCount;
			const scale =
				typeof omittedRowCount === "number" && omittedRowCount > 0
					? `${omittedRowCount.toLocaleString()} row${omittedRowCount === 1 ? "" : "s"} omitted`
					: typeof omittedCharCount === "number" &&
							omittedCharCount > 0
						? `${omittedCharCount.toLocaleString()} character${omittedCharCount === 1 ? "" : "s"} omitted`
						: null;
			const lines = [
				scale
					? `Only part of this file was read — ${scale}.`
					: "Only part of this file was read.",
			];
			if (extraction.truncatedSheetNames?.length) {
				lines.push(
					`Sheets not fully read: ${extraction.truncatedSheetNames.join(", ")}`,
				);
			}
			lines.push(...sheetLines(extraction.sheets));
			return { warn: true, lines };
		}

		case "extracted": {
			const lines = sheetLines(extraction.sheets);
			if (lines.length === 0) {
				return null;
			}
			return {
				warn: extraction.sheets.some((sheet) => sheet.hidden),
				lines,
			};
		}
	}
}

/**
 * The `ready` chip's status marker, carrying the extraction notice.
 *
 * Mirrors the `error` chip below it — icon inside a `<Tooltip>` — so the two
 * read as one system. The `sr-only` copy is additive: a tooltip only opens on
 * hover or focus, and this icon is not focusable, so without it the disclosure
 * would be unavailable to a screen reader entirely.
 */
function ExtractionStatusIcon({ notice }: { notice: ExtractionNotice | null }) {
	if (!notice) {
		return <CheckCircle2 className="size-3 shrink-0 text-secondary" />;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex shrink-0 items-center">
					{notice.warn ? (
						<AlertTriangle className="size-3 text-highlight" />
					) : (
						<CheckCircle2 className="size-3 text-secondary" />
					)}
					<span className="sr-only">{notice.lines.join(" ")}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent side="top">
				<div className="max-w-[220px] space-y-0.5">
					{notice.lines.map((line) => (
						<p key={line} className="text-xs">
							{line}
						</p>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

interface CopilotSidebarAttachmentsProps {
	files: AttachedFile[];
	onRemove: (fileId: string) => void;
	/**
	 * Optional ref to the textarea so that, when the last chip is removed via
	 * keyboard, focus returns to the textarea instead of being lost to
	 * `<body>`. Per spec §4.3 (Task 4.2). Mouse-driven removal also lands here
	 * when no chips remain.
	 */
	textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

export function CopilotSidebarAttachments({
	files,
	onRemove,
	textareaRef,
}: CopilotSidebarAttachmentsProps) {
	const t = useTranslations("tooltips.copilot");

	// Track the chip remove buttons by file id so we can shift focus to the
	// previous chip after a removal (Task 4.2). `useRef<Map>` is referentially
	// stable; `Map.delete` runs in the cleanup ref-callback so stale entries
	// do not pile up across renders.
	const removeButtonRefsRef = useRef<Map<string, HTMLButtonElement | null>>(
		new Map(),
	);

	// Snapshot of the previous render's chip ids and the id most recently
	// removed via the chip-X button. The effect below compares the snapshot
	// against the current render to decide where focus should land.
	const previousIdsRef = useRef<string[]>([]);
	const lastRemovedIdRef = useRef<string | null>(null);

	useEffect(() => {
		const previousIds = previousIdsRef.current;
		const currentIds = files.map((f) => f.id);
		const removedId = lastRemovedIdRef.current;

		// Only restore focus when the shrink was caused by an explicit chip-X
		// activation (not, e.g., a `clearAttachments()` after Send, which
		// should leave focus management to the send handler).
		if (removedId && currentIds.length < previousIds.length) {
			const removedIndex = previousIds.indexOf(removedId);
			if (removedIndex !== -1) {
				// Walk left from the removed index and grab the first chip
				// whose remove button is still in the DOM (chips in
				// `uploading` / `processing` render no remove button).
				let target: HTMLButtonElement | null = null;
				for (let i = removedIndex - 1; i >= 0; i--) {
					const candidateId = previousIds[i];
					const btn =
						candidateId !== undefined
							? removeButtonRefsRef.current.get(candidateId)
							: null;
					if (btn) {
						target = btn;
						break;
					}
				}
				if (target) {
					target.focus();
				} else {
					textareaRef?.current?.focus();
				}
			}
		}

		// Drop ref entries for chips that no longer exist so the map does not
		// grow unbounded across long-lived input sessions.
		const currentIdSet = new Set(currentIds);
		for (const key of Array.from(removeButtonRefsRef.current.keys())) {
			if (!currentIdSet.has(key)) {
				removeButtonRefsRef.current.delete(key);
			}
		}

		previousIdsRef.current = currentIds;
		lastRemovedIdRef.current = null;
	}, [files, textareaRef]);

	if (files.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-wrap gap-1.5 px-1 pb-2">
			{files.map((file) => {
				const extractionNotice = describeExtraction(file.extraction);
				// A `ready` chip whose content came back short, empty, or
				// unreadable must not look identical to a clean one — that
				// equivalence is the bug this closes.
				const readyWarns =
					file.status === "ready" && extractionNotice?.warn === true;

				return (
					<div
						key={file.id}
						className={cn(
							"flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs",
							"border bg-card transition-colors",
							file.status === "error" &&
								"border-destructive/40 bg-destructive/5",
							file.status === "uploading" &&
								"border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/20",
							file.status === "processing" &&
								"border-highlight/40 bg-highlight/5",
							file.status === "ready" &&
								!readyWarns &&
								"border-secondary/40 bg-secondary/5",
							readyWarns && "border-highlight/40 bg-highlight/5",
							file.status === "pending" && "border-border",
						)}
					>
						{/* File icon */}
						{file.isImage || file.type.startsWith("image/") ? (
							<ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
						) : file.type.includes("pdf") ||
							file.type.includes("document") ? (
							<FileText className="size-3.5 shrink-0 text-muted-foreground" />
						) : (
							<FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
						)}

						<span className="max-w-[120px] truncate text-foreground">
							{file.name}
						</span>

						{/* Status indicator */}
						{file.status === "uploading" && (
							<Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />
						)}
						{file.status === "processing" && (
							<Loader2 className="size-3 shrink-0 animate-spin text-highlight" />
						)}
						{file.status === "ready" && (
							<ExtractionStatusIcon notice={extractionNotice} />
						)}
						{file.status === "error" && (
							<Tooltip>
								<TooltipTrigger asChild>
									<XCircle className="size-3 shrink-0 text-destructive" />
								</TooltipTrigger>
								<TooltipContent side="top">
									<p className="text-xs">
										{file.error || "Upload failed"}
									</p>
								</TooltipContent>
							</Tooltip>
						)}

						{/*
						 * Remove button is hidden (not just disabled) during
						 * `uploading` / `processing` per spec §3.3 — once the upload
						 * is in flight, the user has no useful interaction with this
						 * chip until the request resolves to `ready` or `error`.
						 *
						 * Wrapped in `<Tooltip>` per `fabric/standards/frontend/tooltips.md`
						 * §"Icon-only control" (Task 4.4) — the chip-X is icon-only,
						 * so it carries both an `aria-label` (file-specific) and a
						 * `<Tooltip>` (generic copy).
						 */}
						{file.status !== "uploading" &&
							file.status !== "processing" && (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											ref={(node) => {
												removeButtonRefsRef.current.set(
													file.id,
													node,
												);
											}}
											type="button"
											onClick={() => {
												lastRemovedIdRef.current =
													file.id;
												onRemove(file.id);
											}}
											className="ml-0.5 p-0.5 rounded hover:bg-muted transition-colors"
											aria-label={`Remove ${file.name}`}
										>
											<X className="size-3 text-muted-foreground hover:text-foreground" />
										</button>
									</TooltipTrigger>
									<TooltipContent side="top">
										{t("removeAttachment")}
									</TooltipContent>
								</Tooltip>
							)}
					</div>
				);
			})}
		</div>
	);
}
