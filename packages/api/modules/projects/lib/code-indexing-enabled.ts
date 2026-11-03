/**
 * Whether anything will ever index a project's repositories.
 *
 * One switch: the project's code search mode (spec 2026-10-29
 * code-index-sync §6a). Only RAG chunks and embeds code; OFF searches nothing
 * and CODE_SEARCH reads the provider live. The trigger that starts indexing
 * asks exactly this, and so does capability gating — which must not tell
 * someone to wait for an index nothing will build. One predicate, so the two
 * can never disagree about it. Each repository is further included or not
 * on its own row (`includedInCodeSearch`).
 *
 * Kept free of the trigger's own imports (Temporal, provider tokens) so a
 * reader that only needs the answer does not load the machinery.
 */

export type CodeSearchMode = "OFF" | "CODE_SEARCH" | "RAG";

/** Whether the project's code search mode builds a code index. */
export function isCodeIndexingEnabled(
	codeSearchMode: CodeSearchMode | null | undefined,
): boolean {
	return codeSearchMode === "RAG";
}
