/**
 * Databricks base-URL normalization — the single source of truth for turning a
 * stored workspace URL into its OpenAI-compatible inference base.
 *
 * Databricks exposes OpenAI-compatible inference two ways:
 *  - Classic Model Serving (GA): `<host>/serving-endpoints` (a bare workspace
 *    host defaults to this).
 *  - Unity AI Gateway (Beta): a full path such as `<host>/ai-gateway/mlflow/v1`,
 *    which is respected verbatim.
 *
 * Shared by `@repo/ai`'s model factory and `@repo/api`'s connection tester so the
 * "bare host → append `/serving-endpoints`, explicit path → verbatim" contract
 * lives in exactly one place. (The LangGraph agent bundle in `@repo/agent-core`
 * keeps its own inline copy on purpose — it must not import `@repo/ai`, which
 * would pull the entire Vercel AI SDK into every agent's tsup bundle.)
 */

/** True when the stored base URL carries a path beyond the workspace root. */
export function hasDatabricksExplicitPath(baseUrl: string): boolean {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	try {
		const { pathname } = new URL(trimmed);
		return pathname !== "" && pathname !== "/";
	} catch {
		// Unparseable (shouldn't happen for a validated https URL): fall back to
		// recognizing the known inference path suffixes.
		return /\/serving-endpoints$|\/ai-gateway\//.test(trimmed);
	}
}

/**
 * Resolve the OpenAI-compatible inference base URL. A bare workspace host
 * defaults to the GA classic path `<host>/serving-endpoints`; a URL that already
 * carries a path (e.g. the Unity AI Gateway) is respected verbatim.
 */
export function toDatabricksServingBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return hasDatabricksExplicitPath(trimmed)
		? trimmed
		: `${trimmed}/serving-endpoints`;
}

/**
 * Normalize a stored Databricks base URL down to the bare workspace host
 * (origin). The workspace-level surfaces — the native REST APIs (`/api/2.0/…`)
 * and the OIDC token endpoint (`/oidc/v1/token`) — always live at the root,
 * regardless of the inference path a tenant stored (`/serving-endpoints`,
 * `/ai-gateway/mlflow/v1`, …). Feeding a full inference URL to the token
 * endpoint yields a 404, so every OAuth exchange must go through this first.
 */
export function toDatabricksWorkspaceHost(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	try {
		return new URL(trimmed).origin;
	} catch {
		// Unparseable (shouldn't happen for a validated https URL): strip the
		// known inference path suffixes as a best effort.
		return trimmed
			.replace(/\/serving-endpoints$/, "")
			.replace(/\/ai-gateway\/.*$/, "");
	}
}
