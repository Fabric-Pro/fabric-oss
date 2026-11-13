"use client";

/**
 * Where uploaded transcripts stand, shown in the Meeting Digest (Fizzy #3507,
 * FR11).
 *
 * An upload reaches the digest only once it has been read, so without this the
 * page says nothing at all between "Upload" and the meeting appearing, and a
 * file that failed never appears and never says why. The rows are the
 * uploader's own query, so the two cannot disagree about a file.
 */

import {
	isProcessing,
	type UploadedTranscriptRow,
	uploadedTranscriptTitle,
	useUploadedTranscripts,
} from "@saas/projects/components/TranscriptFileUpload";
import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";

function describeProcessing(rows: UploadedTranscriptRow[]): string {
	const [only] = rows;
	return rows.length === 1 && only
		? `Reading ${uploadedTranscriptTitle(only)}.`
		: `Reading ${rows.length} uploaded transcripts.`;
}

function describeFailed(rows: UploadedTranscriptRow[]): string {
	const [only] = rows;
	return rows.length === 1 && only
		? `${uploadedTranscriptTitle(only)} could not be processed: ${only.extractionError ?? "the file could not be read."}`
		: `${rows.length} uploaded transcripts could not be processed.`;
}

export function UploadedTranscriptProgress({
	projectId,
	organizationId,
	onFinished,
	onReview,
}: {
	projectId: string;
	organizationId: string | null;
	/**
	 * Called when the digest has something new to show: the last file in
	 * progress finished, or a removed file is really gone.
	 */
	onFinished?: () => void;
	/** Opens the uploader, where a failed file can be removed and sent again. */
	onReview?: () => void;
}) {
	const { uploads, storedIds } = useUploadedTranscripts({
		projectId,
		organizationId,
	});
	const processing = uploads.filter(isProcessing);
	const failed = uploads.filter((row) => row.extractionStatus === "FAILED");

	// Only transitions count: the first read of a project with nothing in
	// progress is not a file finishing.
	const wasProcessing = useRef(false);
	useEffect(() => {
		if (wasProcessing.current && processing.length === 0) {
			onFinished?.();
		}
		wasProcessing.current = processing.length > 0;
	}, [processing.length, onFinished]);

	// A removal finishes in a worker, after the dialog that started it may have
	// closed, so the meeting leaves the digest only once its row is gone.
	const previousIds = useRef<string | null>(null);
	useEffect(() => {
		const before = previousIds.current;
		previousIds.current = storedIds;
		if (before === null || before === storedIds) {
			return;
		}
		const now = new Set(storedIds.split(","));
		if (before.split(",").some((id) => id && !now.has(id))) {
			onFinished?.();
		}
	}, [storedIds, onFinished]);

	if (processing.length === 0 && failed.length === 0) {
		return null;
	}

	return (
		<div className="space-y-1">
			{processing.length > 0 && (
				<output className="flex items-center gap-2 rounded border bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
					<Loader2Icon
						aria-hidden="true"
						className="size-4 shrink-0 animate-spin"
					/>
					{describeProcessing(processing)} They appear on the calendar
					once read.
				</output>
			)}
			{failed.length > 0 && (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-2 rounded border border-destructive/40 px-3 py-2 text-sm"
				>
					<p className="text-destructive">{describeFailed(failed)}</p>
					{onReview && (
						<button
							type="button"
							className="text-sm underline"
							onClick={onReview}
						>
							Review uploads
						</button>
					)}
				</div>
			)}
		</div>
	);
}
