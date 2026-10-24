/** The bound prompt travels separately in run-scoped agent state. */
export function buildCleanSpecRefreshMessage(kindWord: string): string {
	return `Refresh the Full Spec for this ${kindWord}, folding in the latest connected project context (meeting transcripts, uploaded documents, and team messages) that has been provided to you. Apply all changes using the write_document_local tool.`;
}
