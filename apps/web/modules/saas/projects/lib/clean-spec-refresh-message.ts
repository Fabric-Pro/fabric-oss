/**
 * Builds the "Update Full Spec" refresh message posted into the Feature
 * Assistant chat (#1794).
 *
 * The message carries only the instruction + bound prompt. Pre-fetched
 * connected project context (meeting transcripts, uploaded docs, team messages)
 * is delivered to the agent out-of-band on the dedicated `refreshSpecContexts`
 * agent-state field — it must reach the model, but was never meant to be shown
 * to the product owner as a wall of raw transcript in the visible chat.
 * The caller (`handleRefreshCleanSpec`) `flushSync`s that field
 * into CopilotKit's outgoing state snapshot immediately before posting this
 * message, and the unified-server merges it into `ragContexts`.
 */
export function buildCleanSpecRefreshMessage(
	kindWord: string,
	promptContent: string,
): string {
	return `Refresh the Full Spec for this ${kindWord}, folding in the latest connected project context (meeting transcripts, uploaded documents, and team messages) that has been provided to you. Apply all changes using the write_document_local tool.\n\nFollow these instructions:\n\n${promptContent}`;
}
