/**
 * Databricks inference routing depends on both the stored URL and model ID.
 * For a bare workspace host or exactly `/serving-endpoints`, three-part Unity
 * Catalog names use `/ai-gateway/mlflow/v1`; other names use `/serving-endpoints`.
 * Other explicit paths are preserved (apart from surrounding whitespace and
 * trailing slashes). Workspace APIs and OAuth use the workspace origin instead.
 *
 * The model factory, CopilotKit, delegated executor and API helpers share this.
 * `@repo/agent-core` mirrors it inline to avoid importing the Vercel AI SDK
 * into agent bundles.
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

/** Resolve an inference URL using the model's three-part catalog identity. */
export function toDatabricksInferenceBaseUrl(
	baseUrl: string,
	modelId: string,
): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	try {
		const { origin, pathname } = new URL(trimmed);
		if (
			pathname === "/" ||
			pathname === "" ||
			pathname === "/serving-endpoints"
		) {
			const path = /^[^./]+\.[^./]+\.[^./]+$/.test(modelId)
				? "/ai-gateway/mlflow/v1"
				: "/serving-endpoints";
			return `${origin}${path}`;
		}
		return trimmed;
	} catch {
		// Preserve the previous best-effort behavior for unparseable stored values.
		return toDatabricksServingBaseUrl(trimmed);
	}
}

/** Model-less normalization retained for endpoint discovery. */
export function toDatabricksServingBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return hasDatabricksExplicitPath(trimmed)
		? trimmed
		: `${trimmed}/serving-endpoints`;
}

/**
 * Normalize a stored Databricks base URL down to the bare workspace host
 * (origin). The workspace-level surfaces — the native REST APIs (`/api/2.0/…`)
 * and the OIDC token endpoint (`/oidc/v1/token`) — use the workspace root,
 * regardless of the inference path a tenant stored (`/serving-endpoints`,
 * `/ai-gateway/mlflow/v1`, …). Feeding a full inference URL to the token
 * endpoint yields a 404; normalize inference URLs before workspace requests.
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
