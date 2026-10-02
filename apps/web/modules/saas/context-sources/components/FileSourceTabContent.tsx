"use client";

import {
	CONTEXT_UPLOAD_ACCEPT_ATTR,
	contextUploadConfigFor,
	resolveContextUploadCategory,
	resolveContextUploadMime,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";
import {
	CONTEXT_UPLOAD_FORMATS_AND_LIMITS,
	oversizeReason,
	unsupportedTypeReason,
} from "@saas/projects/lib/context-upload-copy";
import { LiveAnnouncerRegion } from "@saas/shared/components/LiveAnnouncer";
import { TruncatedText } from "@shared/components/TruncatedText";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	ImageIcon,
	LoaderIcon,
	UploadCloudIcon,
	XCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useCallback } from "react";
import type {
	FileSourceForm,
	UploadedFileRow,
} from "../hooks/use-file-source-form";

// Supported-format copy is derived from the shared vocabulary and lives in
// `@saas/projects/lib/context-upload-copy` — the wizard's own uploader renders
// the same sentences, and two derivations of one sentence is the drift a
// single derivation exists to prevent.

type FileSourceTabContentProps = {
	form: FileSourceForm;
	isLoading: boolean;
	/** Owner-only fields, rendered below the title (e.g. "Tag as Document"). */
	children?: ReactNode;
};

/**
 * The File tab body: drop zone, picker, per-file queue and title. Intake lives
 * here with the picker it serves — the `accept` attribute and the gate behind
 * it read one vocabulary (`@repo/utils` context-upload), so the picker never
 * offers a file the gate then refuses.
 */
export function FileSourceTabContent({
	form,
	isLoading,
	children,
}: FileSourceTabContentProps) {
	const t = useTranslations("tooltips.contextSources");
	const {
		files,
		setFiles,
		fileTitle,
		setFileTitle,
		isDragOver,
		setIsDragOver,
		announcement,
		announce,
	} = form;

	// Drag and drop handlers
	const handleDragOver = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(true);
		},
		[setIsDragOver],
	);

	const handleDragLeave = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);
		},
		[setIsDragOver],
	);

	// Convert a list of native `File` objects into validated row entries.
	//
	// The single funnel both the drop path and the picker path go through, so
	// the gates here are the gates for every way a file can enter the queue.
	// Files failing either gate are kept as `failed` rows so the user sees the
	// rejection inline rather than silently dropped (spec §7.1, decision Q12 —
	// rejected siblings must not block the batch), and each file is judged on
	// its own. Returns rows in the same order as the input so the user can
	// correlate the rejection with the file they just dropped.
	//
	// Two gates, type before size:
	//   1. Type — `contextUploadConfigFor` is the allowlist lookup, and
	//      `undefined` means this surface does not admit the type. Do NOT test
	//      the resolved MIME for null instead: the resolver hands back the
	//      caller's own value when nothing resolves, so it is never null. An
	//      unadvertised type used to queue as "Ready", enable the Upload
	//      button, and only be refused by the server's 400 after the round-trip.
	//   2. Size — against the limit the *resolved* category carries.
	const buildRowsFromFiles = useCallback(
		(picked: File[]): UploadedFileRow[] => {
			const refusals: string[] = [];
			const rows = picked.map((picked_file): UploadedFileRow => {
				const mimeType = picked_file.type || "application/octet-stream";
				const { resolvedMimeType, category } =
					resolveContextUploadCategory(mimeType, picked_file.name);
				const base = {
					id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${picked_file.name}`,
					file: picked_file,
					name: picked_file.name,
					size: picked_file.size,
					mimeType,
				};

				if (!contextUploadConfigFor(resolvedMimeType)) {
					const reason = unsupportedTypeReason(
						picked_file.name,
						resolvedMimeType,
					);
					refusals.push(reason);
					return { ...base, status: "failed", error: reason };
				}

				const maxSize = UPLOAD_SIZE_LIMITS[category];
				if (picked_file.size > maxSize) {
					// Announced like the type refusal above: both are queue-time
					// refusals that insert an already-failed row, and assistive
					// technology does not reliably announce a newly inserted node.
					// Worded by the shared helper so this surface and the wizard
					// phrase an oversize file identically.
					const reason = oversizeReason(picked_file.name, maxSize);
					refusals.push(reason);
					return { ...base, status: "failed", error: reason };
				}

				return { ...base, status: "queued" };
			});

			// One announcement per batch, naming every file it refused.
			if (refusals.length > 0) {
				announce(refusals.join(" "));
			}

			return rows;
		},
		[announce],
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);

			// Mirrors the Browse button and the hidden file input, both
			// `disabled={isLoading}` — the dropzone is a plain `<div>` with its
			// own drag/drop handlers, so it needs its own gate. Without it, a
			// file dropped mid-upload queues silently and can be discarded when
			// the in-flight batch's own success closes the dialog.
			if (isLoading) {
				return;
			}

			const droppedFiles = Array.from(e.dataTransfer.files);
			if (droppedFiles.length === 0) {
				return;
			}
			// Append rather than replace — sequential drops accumulate.
			// The first dropped file seeds an empty `fileTitle`
			// only if none has been set yet — preserves the legacy single-file
			// UX where the title input is pre-populated with the filename, but
			// stays out of the way for multi-file batches where there's no
			// one canonical title.
			const newRows = buildRowsFromFiles(droppedFiles);
			setFiles((prev) => [...prev, ...newRows]);
			if (!fileTitle && droppedFiles.length === 1) {
				setFileTitle(droppedFiles[0].name.replace(/\.[^/.]+$/, ""));
			}
		},
		[
			buildRowsFromFiles,
			fileTitle,
			isLoading,
			setFiles,
			setFileTitle,
			setIsDragOver,
		],
	);

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		// The input already carries `disabled={isLoading}`, which blocks the
		// picker UI; this guard covers the same in-flight window defensively,
		// matching the dropzone above.
		if (isLoading) {
			e.target.value = "";
			return;
		}
		const selectedFiles = Array.from(e.target.files ?? []);
		if (selectedFiles.length === 0) {
			return;
		}
		const newRows = buildRowsFromFiles(selectedFiles);
		setFiles((prev) => [...prev, ...newRows]);
		if (!fileTitle && selectedFiles.length === 1) {
			setFileTitle(selectedFiles[0].name.replace(/\.[^/.]+$/, ""));
		}
		// Reset input value so re-selecting the same file fires `onChange` again.
		e.target.value = "";
	};

	const removeFileRow = (id: string) => {
		setFiles((prev) => prev.filter((row) => row.id !== id));
	};

	return (
		<div
			className="space-y-4 motion-safe:animate-stagger"
			role="tabpanel"
			id="context-tabpanel-file"
			aria-labelledby="context-tab-file"
		>
			{/* Drag and Drop Zone — always shows the "drop here"
			    affordance even when files are already queued, so
			    multi-file accumulation feels obvious. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: file drop zone uses drag events, not click; file input inside handles keyboard/click access */}
			<div
				className={cn(
					"relative overflow-hidden rounded-xl border-2 border-dashed bg-card transition-colors",
					isDragOver
						? "border-primary bg-accent"
						: "border-border hover:border-muted-foreground",
				)}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<div className="relative z-10 flex flex-col items-center justify-center p-8">
					<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-primary">
						<UploadCloudIcon className="size-8" />
					</div>
					<p className="mb-1 font-medium">
						{files.length > 0
							? "Drop more files or browse"
							: "Drag and drop your files here"}
					</p>
					<p className="mb-3 max-w-md text-pretty text-center text-muted-foreground text-sm">
						{CONTEXT_UPLOAD_FORMATS_AND_LIMITS}
					</p>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={(e) => {
									e.stopPropagation();
									document
										.getElementById("context-file-input")
										?.click();
								}}
								disabled={isLoading}
							>
								Browse Files
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("browseFiles")}</TooltipContent>
					</Tooltip>
				</div>

				<input
					id="context-file-input"
					type="file"
					className="sr-only"
					accept={CONTEXT_UPLOAD_ACCEPT_ATTR}
					multiple
					onChange={handleFileSelect}
					disabled={isLoading}
				/>
			</div>

			{/* Per-file status list. Renders once any file is in
			    the queue. Each row carries (filename, size, status
			    pill, remove button). Spec §7.4. */}
			{files.length > 0 && (
				<ul className="space-y-2" aria-label="Selected files">
					{files.map((row) => (
						<FileQueueRow
							key={row.id}
							row={row}
							onRemove={() => removeFileRow(row.id)}
							disabled={isLoading}
						/>
					))}
				</ul>
			)}

			{/* Title input */}
			<div>
				<Label htmlFor="file-title">Title (Optional)</Label>
				<Input
					id="file-title"
					placeholder="Enter a title or leave empty to use filename"
					value={fileTitle}
					onChange={(e) => setFileTitle(e.target.value)}
					disabled={isLoading}
					className="mt-2"
				/>
			</div>

			{children}

			{/* Mounted with the tab, before any file can be
			    picked, so a refusal written into it later reads
			    as an update to an existing live region rather
			    than an inserted node a screen reader would skip.
			    Last in the panel because `sr-only` is
			    position-absolute: `space-y-4` cannot give it a
			    visible gap here, whereas placing it first would
			    push the dropzone down by one step. */}
			<LiveAnnouncerRegion
				announcement={announcement}
				data-testid="context-upload-announcer"
			/>
		</div>
	);
}

// File type icons
function getFileIcon(mimeType: string) {
	if (mimeType.includes("image")) {
		return ImageIcon;
	}
	if (
		mimeType.includes("spreadsheet") ||
		mimeType.includes("csv") ||
		mimeType.includes("excel")
	) {
		return FileSpreadsheetIcon;
	}
	return FileTextIcon;
}

// ── File queue row ────────────────────────────────────
//
// Per-file row in the multi-file upload list. Surfaces filename + size +
// status pill + a remove button. Status copy maps:
//   - queued       → "Ready"
//   - uploading    → "Uploading…"
//   - processing   → "Processing…"
//   - completed    → "Done"
//   - failed       → "Failed: {error}"
//
// Accessibility:
//   - Each row is a list item with the file's name as its accessible name.
//   - The remove button carries `aria-label="Remove {filename}"`.
//   - The status pill carries an `aria-label` mirroring the visible text so
//     screen readers announce state transitions ("Uploading", "Done", etc.).
//
// Editorial aesthetic: warm-neutral card (`bg-card border border-border`),
// `text-destructive` for failures (not red hex), `text-secondary` for the
// success done-state (rose-tint matches the rest of the dialog).

type FileQueueRowProps = {
	row: UploadedFileRow;
	onRemove: () => void;
	disabled: boolean;
};

function FileQueueRow({ row, onRemove, disabled }: FileQueueRowProps) {
	// Pick the icon from the resolved type, not the browser's claim: an untyped
	// file carries the octet-stream placeholder, which would show every one of
	// them as a generic document. #2139.
	const FileTypeIcon = getFileIcon(
		resolveContextUploadMime(row.mimeType, row.name),
	);
	const sizeMb = (row.size / (1024 * 1024)).toFixed(2);

	const isInFlight =
		row.status === "uploading" || row.status === "processing";
	const isTerminal = row.status === "completed" || row.status === "failed";
	const isFailed = row.status === "failed";

	const pillText: string = (() => {
		switch (row.status) {
			case "queued":
				return "Ready";
			case "uploading":
				return "Uploading…";
			case "processing":
				return "Processing…";
			case "completed":
				return "Done";
			case "failed":
				// Marker only. The reason renders on its own line below the
				// filename — see the error paragraph in the content column.
				return "Failed";
		}
	})();

	const failureReason = row.error ?? "Unknown error";

	// SR-visible state. Mirrors the visible pill copy so screen readers do
	// not need to parse the icon-color combination.
	const pillAriaLabel = pillText;

	return (
		<li
			data-testid={`file-queue-row-${row.id}`}
			className={cn(
				"flex items-center gap-3 rounded-lg border bg-card p-3",
				isFailed
					? "border-destructive/30"
					: isTerminal
						? "border-secondary/40"
						: "border-border",
			)}
		>
			<div
				className={cn(
					"shrink-0 rounded-md border border-border bg-card p-2",
					isFailed ? "text-destructive" : "text-muted-foreground",
				)}
			>
				<FileTypeIcon className="size-4" />
			</div>

			<div className="min-w-0 flex-1">
				<TruncatedText
					as="p"
					text={row.name}
					className="font-medium text-sm text-foreground"
				/>
				<p className="text-xs text-muted-foreground">{sizeMb} MB</p>
				{isFailed ? (
					<p className="mt-1 text-destructive text-xs">
						{failureReason}
					</p>
				) : null}
			</div>

			{/* Status pill */}
			<span
				role="status"
				aria-label={pillAriaLabel}
				className={cn(
					// `shrink-0`: the pill sits beside a `min-w-0 flex-1` name
					// column. Without it, pill copy longer than a word steals
					// the column's width and the filename disappears from the
					// row — which is what put the reason on its own line.
					"inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
					isFailed
						? "border-destructive/30 text-destructive"
						: row.status === "completed"
							? "border-secondary/40 text-secondary"
							: isInFlight
								? "border-border text-primary"
								: "border-border text-muted-foreground",
				)}
			>
				{isInFlight ? (
					<LoaderIcon className="size-3 motion-safe:animate-spin" />
				) : row.status === "completed" ? (
					<CheckCircleIcon className="size-3" />
				) : isFailed ? (
					<AlertCircleIcon className="size-3" />
				) : null}
				<span>{pillText}</span>
			</span>

			<Button
				variant="ghost"
				size="sm"
				onClick={onRemove}
				disabled={disabled && isInFlight}
				aria-label={`Remove ${row.name}`}
				className="shrink-0"
			>
				<XCircleIcon className="size-4" aria-hidden="true" />
			</Button>
		</li>
	);
}
