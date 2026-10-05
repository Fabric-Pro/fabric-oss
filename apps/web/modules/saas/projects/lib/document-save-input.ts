/**
 * What an editor save sends.
 *
 * An explicit Save is the author's own call on the document, so it also asks
 * the server to complete a draft. An autosave only keeps their text: it fires
 * ten seconds into a pause in typing, and completing the document then would
 * mark it finished — embedded, counted as usable, served as project context —
 * while it is still being written.
 */
export function buildDocumentSaveInput({
	projectId,
	documentId,
	content,
	isManualSave,
}: {
	projectId: string;
	documentId: string;
	content: string;
	isManualSave: boolean;
}) {
	return {
		projectId,
		id: documentId,
		content,
		...(isManualSave ? { completeDraft: true as const } : {}),
	};
}
