import { DOCUMENT_SAVE_BASE_REQUIRED } from "@repo/utils/document-save-base";
import type { DocumentAiReviewDescriptor } from "@repo/utils/proposal-artifact/scoped-revision-codes";

/**
 * The saved body a save's content descends from (Fizzy #2946): its version
 * and the `contentHash` the server returned for it. A save that names it is
 * refused with CONFLICT, and writes nothing, when the document no longer
 * holds that body, so a save based on an older body than the last server
 * write cannot land over it. The editor never computes the hash: it only
 * keeps and sends the one `projects.documents.get` or a save answered with.
 */
export interface DocumentSaveBase {
	version: number;
	contentHash: string;
}

/**
 * How long an editor waits into a pause in typing before it autosaves. An
 * object read when the timer is set, so a test can shorten it.
 */
export const DOCUMENT_AUTOSAVE_TIMINGS = { delayMs: 10_000 };

/**
 * What an editor save sends.
 *
 * An explicit Save is the author's own call on the document, so it also asks
 * the server to complete a draft. An autosave only keeps their text: it fires
 * ten seconds into a pause in typing, and completing the document then would
 * mark it finished — embedded, counted as usable, served as project context —
 * while it is still being written.
 *
 * `base`, when given, goes out whole — version and body identity together,
 * never one without the other. Every save whose body comes from a
 * collaborative room names the room's stamp, and the single-user editor names
 * the body it loaded or last adopted (Fizzy #2946). `expectedVersion` alone is
 * the older guard of an accepted assistant proposal that carries visual
 * slots; a `base` supersedes it.
 *
 * `aiReview` marks the save as the accept of an AI change to a
 * client-document Proposal (a chat proposal or a finding-driven revision),
 * which the server checks before it writes; it goes out only when given.
 */
export function buildDocumentSaveInput({
	projectId,
	documentId,
	content,
	isManualSave,
	base,
	expectedVersion,
	skipVersionBump,
	organizationId,
	aiReview,
}: {
	projectId: string;
	documentId: string;
	content: string;
	isManualSave: boolean;
	base?: DocumentSaveBase | null;
	expectedVersion?: number;
	/** The Reject fallback rewrites the body without a new version. */
	skipVersionBump?: boolean;
	organizationId?: string | null;
	aiReview?: DocumentAiReviewDescriptor;
}) {
	return {
		projectId,
		id: documentId,
		content,
		...(isManualSave ? { completeDraft: true as const } : {}),
		...(base
			? {
					expectedVersion: base.version,
					expectedContentHash: base.contentHash,
				}
			: expectedVersion !== undefined
				? { expectedVersion }
				: {}),
		...(skipVersionBump ? { skipVersionBump: true as const } : {}),
		...(organizationId !== undefined ? { organizationId } : {}),
		...(aiReview ? { aiReview } : {}),
	};
}

/**
 * Whether a save was refused because it named no base while the server
 * requires one (`DOCUMENT_SAVE_BASE_REQUIRED`): the editor bundle is older
 * than the server, and the person has to reload to keep editing.
 */
export function isSaveBaseRequiredRefusal(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const { code, data } = error as { code?: unknown; data?: unknown };
	return (
		code === "PRECONDITION_FAILED" &&
		typeof data === "object" &&
		data !== null &&
		(data as { code?: unknown }).code === DOCUMENT_SAVE_BASE_REQUIRED
	);
}
