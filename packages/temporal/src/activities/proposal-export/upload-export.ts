/**
 * Store a finished Proposal export (Fizzy #2946). Not an activity of its own:
 * the export activity calls it with the file it built.
 *
 * Exports live under `proposal-exports/{projectId}/` in the project contexts
 * bucket: the project deletion sweep removes them with the project, and the
 * cleanup schedule removes them once they are older than the retention
 * window. The key is the export's own id, so a retried attempt overwrites its
 * own object and never leaves a second one behind. The object is private;
 * the status read signs a short-lived download for the user who started it.
 *
 * This is also where a later change records which brand an export was
 * printed with.
 */

import { config } from "@repo/config";
import { uploadFile } from "@repo/storage";
import {
	PROPOSAL_EXPORT_CONTENT_TYPES,
	type ProposalExportFormat,
	proposalExportProjectPrefix,
} from "../../lib/proposal-export/types";

export interface UploadProposalExportInput {
	exportId: string;
	projectId: string;
	format: ProposalExportFormat;
	bytes: Buffer;
}

/** The storage key of one export's file. */
export function proposalExportKey(
	projectId: string,
	exportId: string,
	format: ProposalExportFormat,
): string {
	return `${proposalExportProjectPrefix(projectId)}${exportId}.${format}`;
}

/** Upload the file and return its key and type. */
export async function uploadProposalExport(
	input: UploadProposalExportInput,
): Promise<{ key: string; contentType: string }> {
	const key = proposalExportKey(
		input.projectId,
		input.exportId,
		input.format,
	);
	const contentType = PROPOSAL_EXPORT_CONTENT_TYPES[input.format];
	await uploadFile(key, input.bytes, {
		bucket: config.storage.bucketNames.projectContexts,
		contentType,
		access: "private",
	});
	return { key, contentType };
}
