/**
 * One page of a scan a member asked for: start decision extraction for the
 * synced files not read for decisions yet — those a repository's first sync
 * skipped, and those whose current version was never read, such as files
 * synced before decisions were read from Living Memory.
 *
 * A file leaves the list once its extraction has been handed over. A file whose
 * start failed keeps its mark, so "Scan for decisions" still offers it, and the
 * cursor moves past it, so one bad file cannot hold the scan in a loop.
 * Retrying a page is safe: the extraction's own id and checks never read a
 * version twice.
 *
 * `requestedByUserId` is the member who asked. Each extraction announces its
 * candidates to the project's reviewers, leaving that member out.
 */
import {
	clearLivingMemoryDecisionScanSkip,
	listLivingMemoryFilesAwaitingDecisionScan,
} from "@repo/database";
import { startLivingMemoryDecisionExtraction } from "../lib/living-memory-decision-start";

/** Files started per page; the workflow waits between pages. */
const SCAN_PAGE_SIZE = 20;

export interface ScanLivingMemoryFirstSyncFilesInput {
	projectId: string;
	organizationId: string | null;
	/** Absent from a scan started before scans notified reviewers. */
	requestedByUserId?: string;
	afterId?: string;
}

interface ScanLivingMemoryFirstSyncFilesResult {
	started: number;
	failed: number;
	/** Where the next page starts; null when this was the last page. */
	nextAfterId: string | null;
}

export async function scanLivingMemoryFirstSyncFilesActivity(
	input: ScanLivingMemoryFirstSyncFilesInput,
): Promise<ScanLivingMemoryFirstSyncFilesResult> {
	const files = await listLivingMemoryFilesAwaitingDecisionScan({
		projectId: input.projectId,
		organizationId: input.organizationId,
		afterId: input.afterId,
		limit: SCAN_PAGE_SIZE,
	});
	let started = 0;
	let failed = 0;
	for (const file of files) {
		const outcome = await startLivingMemoryDecisionExtraction({
			contextId: file.id,
			scanRequested: true,
			...(input.requestedByUserId
				? { requestedByUserId: input.requestedByUserId }
				: {}),
		});
		if (outcome === "failed") {
			failed += 1;
			continue;
		}
		await clearLivingMemoryDecisionScanSkip(file);
		started += 1;
	}
	return {
		started,
		failed,
		nextAfterId:
			files.length === SCAN_PAGE_SIZE ? (files.at(-1)?.id ?? null) : null,
	};
}
