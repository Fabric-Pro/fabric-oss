"use client";

import { resolveContextUploadMime } from "@repo/utils";
import { isValidExcalidrawContent } from "@repo/utils/attachment";
import { useLiveAnnouncer } from "@saas/shared/components/LiveAnnouncer";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
	ContextSourceAdded,
	ContextSourceSubmitAdapter,
} from "../lib/submit-adapter";

// Per-file row shape for the multi-file upload list. Mirrors the
// `UploadedFile` shape from `WizardFileUploader.tsx:24-34` (status / progress
// vocabulary) so a future cross-component visual refactor stays mechanical.
// Spec ref: 2026-05-23-unified-context-uploader-wizard/spec.md §7.1.
type FileUploadRowStatus =
	| "queued"
	| "uploading"
	| "processing"
	| "completed"
	| "failed";

export type UploadedFileRow = {
	id: string;
	file: File;
	name: string;
	size: number;
	/** What the browser claimed, or the octet-stream placeholder when it claimed nothing. */
	mimeType: string;
	status: FileUploadRowStatus;
	error?: string;
};

interface UseFileSourceFormOptions {
	adapter: ContextSourceSubmitAdapter;
	/** Fires once per file that uploaded and started processing. */
	onSourceAdded?: (added: ContextSourceAdded) => void;
	/** Every queued file landed: close and reset the dialog. */
	onComplete: () => void;
}

/**
 * State and submit for the File tab. The tab body
 * (`FileSourceTabContent`) owns intake — the drop zone, the picker and the
 * gate that decides what may be queued — and writes rows through the setters
 * returned here; this hook uploads what was queued.
 */
export function useFileSourceForm({
	adapter,
	onSourceAdded,
	onComplete,
}: UseFileSourceFormOptions) {
	const queryClient = useQueryClient();

	// File upload state — multi-file. Files accumulate on drop /
	// pick; submit fans out as N parallel `createUploadUrl → PUT → processFile`
	// round-trips via Promise.allSettled (mirrors the bulk-URL pattern in
	// `useUrlSourceForm`). `fileTitle` applies to all queued files (per spec
	// §7.1 — multi-file is "drop a batch", not a per-file editor; granular
	// title editing would warrant a richer surface).
	const [files, setFiles] = useState<UploadedFileRow[]>([]);
	const [fileTitle, setFileTitle] = useState("");
	const [isDragOver, setIsDragOver] = useState(false);
	// Queue-time refusals insert a row that is *already* failed. A newly
	// inserted node is not an update to a live region, so screen readers stay
	// silent on it — this pre-mounted region is what carries the refusal.
	const { announcement, announce } = useLiveAnnouncer();
	// Tracks whether the queue is actively uploading. `false` until handler
	// fires the first round-trip, then resets to `false` once Promise.allSettled
	// resolves.
	const [isBatchUploading, setIsBatchUploading] = useState(false);

	// The dropzone is gated on `isLoading` (see FileSourceTabContent), but a
	// row can still land between this submit starting and its own re-render.
	// `upload()`'s own `files` closure is a snapshot from before its
	// `await`s; this ref tracks the truly current queue so the post-settle
	// auto-close decision below sees a row dropped mid-upload.
	const filesRef = useRef(files);
	useEffect(() => {
		filesRef.current = files;
	}, [files]);

	// Multi-file upload. Fans out N parallel
	// `createUploadUrl → PUT → processFile` round-trips via Promise.allSettled
	// — mirrors the bulk-URL pattern in `useUrlSourceForm`. Each
	// per-file failure surfaces inline on its own row and does NOT block
	// siblings. Already-`failed` rows (oversize from drop-time validation)
	// are skipped without re-attempting.
	//
	// Group 3 audit (`process-context-file.concurrent.test.ts`) confirms the
	// procedure is parallel-safe with distinct contextIds against the same
	// projectId, so no client-side serialization is required.
	const upload = async () => {
		const queueable = files.filter((row) => row.status === "queued");
		if (queueable.length === 0) {
			toast.error("Please select a file");
			return;
		}

		// Rows the gate already refused. They never enter the fan-out, so they
		// never reach `failCount` — and without counting them here a batch of
		// one refused file plus one good upload closed the dialog and reset the
		// form, destroying a refusal the user may not have read. A refused file
		// keeps its row until the user deals with it, whatever its siblings did.
		const refusedCount = files.filter(
			(row) => row.status === "failed",
		).length;

		setIsBatchUploading(true);

		// Mark queueable rows as uploading before kicking off the fan-out so
		// the submit button's disabled state catches the in-flight set.
		setFiles((prev) =>
			prev.map((row) =>
				row.status === "queued"
					? { ...row, status: "uploading" as const }
					: row,
			),
		);

		// Per-row counters scoped to this submit. React state can't be read
		// synchronously after `setFiles` because the updates are batched, so
		// we tally success/failure in-closure to drive the final toast +
		// auto-close decision below.
		let successCount = 0;
		let failCount = 0;

		await Promise.allSettled(
			queueable.map(async (row) => {
				try {
					// Excalidraw content pre-check (#1942): advisory; the extractor
					// stores the raw JSON, so reject a malformed file before upload.
					if (row.name.toLowerCase().endsWith(".excalidraw")) {
						const text = await row.file.text();
						if (!isValidExcalidrawContent(text)) {
							throw new Error(
								"The file is not a valid Excalidraw document.",
							);
						}
					}

					// 1. Get signed upload URL
					const { signedUploadUrl, contextId, contentType } =
						await adapter.createUploadUrl({
							filename: row.name,
							mimeType: row.mimeType,
							size: row.size,
						});

					// 2. Upload file to storage.
					//
					// Send the type the server resolved rather than the
					// browser's placeholder, so the stored object's
					// Content-Type matches the row the server persisted. Falls
					// back to resolving locally so a new bundle talking to a
					// server that predates the field still stores the right
					// type. #2139.
					const uploadResponse = await fetch(signedUploadUrl, {
						method: "PUT",
						body: row.file,
						headers: {
							"Content-Type":
								contentType ??
								resolveContextUploadMime(
									row.mimeType,
									row.name,
								),
						},
					});

					if (!uploadResponse.ok) {
						throw new Error("Failed to upload file to storage");
					}

					// Flip to processing while the procedure runs.
					setFiles((prev) =>
						prev.map((r) =>
							r.id === row.id
								? { ...r, status: "processing" as const }
								: r,
						),
					);

					// 3. Trigger file processing
					await adapter.processFile({ contextId });

					setFiles((prev) =>
						prev.map((r) =>
							r.id === row.id
								? { ...r, status: "completed" as const }
								: r,
						),
					);

					successCount++;

					// Fires exactly once per successful row so the bulk-add
					// flow reports N sources for N completed files. Per-row
					// failures land in the `catch` block below and
					// intentionally do NOT report — it measures successful
					// attachment, not attempt volume.
					onSourceAdded?.({ contextType: "FILE" });
				} catch (error) {
					console.error("File upload error:", error);
					const message =
						error instanceof Error && error.message
							? error.message
							: "Unknown error";
					setFiles((prev) =>
						prev.map((r) =>
							r.id === row.id
								? {
										...r,
										status: "failed" as const,
										error: message,
									}
								: r,
						),
					);
					failCount++;
				}
			}),
		);

		setIsBatchUploading(false);

		// Branch on outcome: only auto-close + green toast when every row
		// succeeded. On any failure, keep the dialog open so the user can
		// read inline error messages on the failed rows and either remove
		// + retry them or close manually. Always invalidate the pending list
		// so successful rows surface immediately in the wizard cards (Group 8).
		queryClient.invalidateQueries({ queryKey: adapter.listQueryKey });

		if (failCount === 0 && refusedCount === 0) {
			toast.success(
				successCount === 1
					? "File uploaded"
					: `${successCount} files uploaded`,
			);
			// A file dropped while this batch was in flight is still `queued`
			// in the live queue even though this batch itself fully
			// succeeded — closing now would discard it with no error, toast,
			// or trace. Leave the dialog open so it gets its own submit.
			const stillQueued = filesRef.current.some(
				(row) => row.status === "queued",
			);
			if (!stillQueued) {
				onComplete();
			}
		} else if (successCount > 0) {
			const unresolved = failCount + refusedCount;
			toast.warning(
				`${successCount} uploaded, ${unresolved} not uploaded — review the remaining items.`,
			);
		} else {
			toast.error(
				failCount === 1
					? "Upload failed — see error details on the row."
					: `All ${failCount} uploads failed — see error details on each row.`,
			);
		}
	};

	const reset = () => {
		setFiles([]);
		setFileTitle("");
		setIsBatchUploading(false);
	};

	// Submit-button disabled while *any* file row is mid-flight (uploading or
	// processing). Mirrors the old single-file `uploadStatus === "uploading"`
	// gate but generalized to a list. Spec §7.5.
	const hasInFlightFile = files.some(
		(row) => row.status === "uploading" || row.status === "processing",
	);

	return {
		files,
		setFiles,
		fileTitle,
		setFileTitle,
		isDragOver,
		setIsDragOver,
		announcement,
		announce,
		upload,
		reset,
		isLoading: isBatchUploading || hasInFlightFile,
		/** Rows still waiting to upload — the File tab submits only these. */
		queueableCount: files.filter((row) => row.status === "queued").length,
	};
}

export type FileSourceForm = ReturnType<typeof useFileSourceForm>;
