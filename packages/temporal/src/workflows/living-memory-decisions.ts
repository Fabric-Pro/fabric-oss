/**
 * Living Memory decision extraction: read one confirmed content version of a
 * synced knowledge file and record the decisions it holds as review
 * candidates for the project's Decisions tab.
 *
 * Started by `startLivingMemoryDecisionExtraction` after the file's embedding
 * succeeds, with the id `living-memory-decisions-<contextId>-<contentHash>`,
 * so each version runs at most once at a time. Separate from the embedding
 * workflow on purpose: a failed or slow extraction never touches the index.
 *
 * `livingMemoryDecisionFirstSyncScanWorkflow` is the scan a member asks for
 * from the Decisions tab: the files not read for decisions yet (skipped by a
 * repository's first sync, or never read), started a page at a time so a
 * large repository cannot flood the worker with AI requests. One per project,
 * by its workflow id. Its input names the member who asked, whom the
 * extractions' notifications leave out.
 */

import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	ExtractLivingMemoryDecisionsInput,
	ExtractLivingMemoryDecisionsResult,
} from "../activities/living-memory-decisions/extract-decisions";
import type { ScanLivingMemoryFirstSyncFilesInput } from "../activities/living-memory-decisions/scan-first-sync-files";

const { extractLivingMemoryDecisionsActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10 minutes",
	retry: {
		initialInterval: "30s",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { scanLivingMemoryFirstSyncFilesActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "5 minutes",
	retry: {
		initialInterval: "30s",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function livingMemoryDecisionExtractionWorkflow(
	input: ExtractLivingMemoryDecisionsInput,
): Promise<ExtractLivingMemoryDecisionsResult> {
	return extractLivingMemoryDecisionsActivity(input);
}

export async function livingMemoryDecisionFirstSyncScanWorkflow(
	input: Omit<ScanLivingMemoryFirstSyncFilesInput, "afterId">,
): Promise<{ started: number; failed: number }> {
	let started = 0;
	let failed = 0;
	let afterId: string | undefined;
	while (true) {
		const page = await scanLivingMemoryFirstSyncFilesActivity({
			...input,
			...(afterId ? { afterId } : {}),
		});
		started += page.started;
		failed += page.failed;
		if (!page.nextAfterId) {
			return { started, failed };
		}
		afterId = page.nextAfterId;
		await sleep("1 minute");
	}
}
