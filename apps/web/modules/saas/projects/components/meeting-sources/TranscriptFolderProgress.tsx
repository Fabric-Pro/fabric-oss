"use client";

/**
 * How the OneDrive folder imports are going, in the Meeting Digest and on the
 * Context tab (Fizzy #3507, FR15).
 *
 * A large folder imports in the background, and someone who connected it and
 * moved on should find out where it stands from either page. The totals stay
 * marked as found-so-far until the whole folder has been listed. A folder that
 * stopped says why, since its admins otherwise see only that nothing arrives.
 */

import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import {
	isFolderImporting,
	type TranscriptFolderRow,
	useTranscriptFolders,
} from "./TranscriptFolderSettings";

function describeImport(folder: TranscriptFolderRow): string {
	const { discovered, imported, skipped, failed } = folder.counts;
	const settled = imported + skipped + failed;
	return folder.discoveryComplete
		? `${folder.name}: ${settled} of ${discovered} files done`
		: `${folder.name}: ${settled} of ${discovered} found so far done, still looking for more`;
}

export function TranscriptFolderProgress({
	projectId,
	organizationId,
	onFinished,
	onImported,
	onReview,
}: {
	projectId: string;
	organizationId: string | null;
	/** Called when the last import finishes, so the page can refresh. */
	onFinished?: () => void;
	/**
	 * Called whenever more files have been imported, so a page listing them can
	 * show each as it lands rather than only when a large folder is done.
	 */
	onImported?: () => void;
	/** Opens the folder settings, where a stopped folder can be reconnected. */
	onReview?: () => void;
}) {
	const { folders } = useTranscriptFolders({ projectId, organizationId });
	const importing = folders.filter(isFolderImporting);
	const stopped = folders.filter((folder) => folder.lastSyncError);

	const imported = folders.reduce(
		(sum, folder) => sum + folder.counts.imported,
		0,
	);
	const lastImported = useRef<number | null>(null);
	useEffect(() => {
		if (lastImported.current !== null && imported > lastImported.current) {
			onImported?.();
		}
		lastImported.current = imported;
	}, [imported, onImported]);

	const wasImporting = useRef(false);
	useEffect(() => {
		if (wasImporting.current && importing.length === 0) {
			onFinished?.();
		}
		wasImporting.current = importing.length > 0;
	}, [importing.length, onFinished]);

	if (importing.length === 0 && stopped.length === 0) {
		return null;
	}

	return (
		<div className="space-y-1">
			{importing.length > 0 && (
				<output className="flex items-start gap-2 rounded border bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
					<Loader2Icon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 animate-spin"
					/>
					<span>
						Importing from OneDrive.{" "}
						{importing.map(describeImport).join("; ")}.
					</span>
				</output>
			)}
			{stopped.map((folder) => (
				<div
					key={folder.id}
					role="alert"
					className="flex flex-wrap items-center justify-between gap-2 rounded border border-highlight/50 bg-highlight/10 px-3 py-2 text-sm"
				>
					<p>
						{folder.name}: {folder.lastSyncError}
					</p>
					{onReview && (
						<button
							type="button"
							className="text-sm underline"
							onClick={onReview}
						>
							Review folders
						</button>
					)}
				</div>
			))}
		</div>
	);
}
