/**
 * Whether anything will ever index a project's repositories.
 *
 * Two switches, both required: the deployment's `FEATURE_CODE_INDEXING` and
 * the project's own `codeSearchEnabled` RAG setting, which defaults off. The
 * trigger that starts indexing asks exactly this, and so does capability
 * gating — which must not tell someone to wait for an index nothing will
 * build. One predicate, so the two can never disagree about it.
 *
 * Kept free of the trigger's own imports (Temporal, provider tokens) so a
 * reader that only needs the answer does not load the machinery.
 */

/** The deployment-level half: is code indexing switched on here at all? */
export function isCodeIndexingDeploymentEnabled(): boolean {
	return process.env.FEATURE_CODE_INDEXING === "true";
}

/** Both halves, given the project's own code-search setting. */
export function isCodeIndexingEnabled(
	codeSearchEnabled: boolean | null | undefined,
): boolean {
	return isCodeIndexingDeploymentEnabled() && codeSearchEnabled === true;
}
