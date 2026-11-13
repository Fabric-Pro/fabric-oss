/**
 * One per project: reads its connected OneDrive transcript folders and imports
 * what they hold (Fizzy #3507).
 *
 * Started, or woken, when a folder is connected, so the files already in it
 * are imported at once without anyone asking. It then reads the folders again
 * on an interval to pick up new files, and ends once the project has no
 * connected folder left. Each file goes through the upload's own ingest
 * workflow, as a child, so a file from a folder is read exactly like one a
 * person uploaded.
 *
 * A large folder is imported in batches, folder by folder, so the first
 * meetings appear while the rest are still being copied.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 */

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	ActivityFailure,
	ChildWorkflowFailure,
	condition,
	continueAsNew,
	defineSignal,
	executeChild,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { uploadedTranscriptIngestWorkflow } from "./uploaded-transcript-ingest";

const {
	listTranscriptFoldersToSync,
	readTranscriptFolder,
	importTranscriptFolderFile,
	markTranscriptFolderFileFailed,
	recordTranscriptFolderFileOutcome,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	// A folder listing pages through Graph; a file download is at most 25 MB.
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "10s",
		backoffCoefficient: 2,
		maximumInterval: "2m",
		maximumAttempts: 5,
		nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
	},
});

/** How long a project's folders rest between reads. */
export const TRANSCRIPT_FOLDER_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** Files imported per folder per pass, so one large folder cannot starve another. */
export const TRANSCRIPT_FOLDER_IMPORT_BATCH = 20;

/** Wakes the sync at once: a folder was just connected. */
export const syncTranscriptFoldersNowSignal = defineSignal(
	"syncTranscriptFoldersNow",
);

export interface TranscriptFolderSyncWorkflowInput {
	projectId: string;
}

export function transcriptFolderSyncWorkflowId(projectId: string): string {
	return `transcript-folder-sync-${projectId}`;
}

/** Import one file. False when it is still waiting, so it settled nothing. */
async function importFile(fileId: string): Promise<boolean> {
	let imported: Awaited<ReturnType<typeof importTranscriptFolderFile>>;
	try {
		imported = await importTranscriptFolderFile({ fileId });
	} catch (error) {
		if (!(error instanceof ActivityFailure)) {
			throw error;
		}
		// The copy kept failing on our side or OneDrive's. The file says so and
		// stops here; reconnecting the folder tries it again.
		await markTranscriptFolderFileFailed({ fileId });
		return true;
	}
	if (imported.outcome === "waiting") {
		return false;
	}
	if (imported.outcome === "ingest") {
		try {
			await executeChild(uploadedTranscriptIngestWorkflow, {
				// The upload's own id, so a file can never be ingested twice.
				workflowId: `uploaded-transcript-ingest-${imported.contextId}`,
				args: [
					{
						contextId: imported.contextId,
						projectId: imported.projectId,
						userId: imported.userId,
						organizationId: imported.organizationId,
					},
				],
			});
		} catch (error) {
			// Started by an earlier run of this step, or failed: either way the
			// context row now says what happened, and that is what is recorded.
			if (
				!(error instanceof WorkflowExecutionAlreadyStartedError) &&
				!(error instanceof ChildWorkflowFailure)
			) {
				throw error;
			}
		}
	}
	await recordTranscriptFolderFileOutcome({ fileId });
	return true;
}

export async function transcriptFolderSyncWorkflow(
	input: TranscriptFolderSyncWorkflowInput,
): Promise<void> {
	let syncRequested = false;
	setHandler(syncTranscriptFoldersNowSignal, () => {
		syncRequested = true;
	});

	for (;;) {
		syncRequested = false;
		const { folderIds } = await listTranscriptFoldersToSync({
			projectId: input.projectId,
		});
		if (folderIds.length === 0) {
			// A folder connected while the list was being read signals this
			// run, which a fresh start would not hear: read the list again
			// rather than end with the new folder unread.
			if (syncRequested) {
				continue;
			}
			return;
		}

		let moreWaiting = false;
		for (const folderId of folderIds) {
			const { pendingFileIds } = await readTranscriptFolder({
				folderId,
				limit: TRANSCRIPT_FOLDER_IMPORT_BATCH,
			});
			let settled = 0;
			for (const fileId of pendingFileIds) {
				if (await importFile(fileId)) {
					settled += 1;
				}
			}
			// A full batch that moved means the folder may hold more: come back
			// at once rather than after the interval. One that moved nothing is
			// waiting on a connection, and waits for the interval.
			if (
				pendingFileIds.length === TRANSCRIPT_FOLDER_IMPORT_BATCH &&
				settled > 0
			) {
				moreWaiting = true;
			}
		}

		if (workflowInfo().continueAsNewSuggested) {
			await continueAsNew<typeof transcriptFolderSyncWorkflow>(input);
		}
		if (!moreWaiting) {
			await condition(
				() => syncRequested,
				TRANSCRIPT_FOLDER_SYNC_INTERVAL_MS,
			);
		}
	}
}
