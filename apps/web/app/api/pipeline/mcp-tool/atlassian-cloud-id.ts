/**
 * Atlassian Rovo cloudId injection.
 *
 * Atlassian's Rovo MCP server requires a `cloudId` on nearly every tool call
 * (getConfluenceSpaces, getPagesInConfluenceSpace, getConfluencePage,
 * searchConfluenceUsingCql, the Jira tools…). The OAuth flow already resolves
 * and persists that cloudId on the MCP config (`atlassianCloudCloudId`), so the
 * generic tool-execution route can inject it transparently — callers don't need
 * to resolve it per request.
 *
 * Kept as a pure, dependency-free module so the guard logic is unit-testable
 * without standing up the route, the DB, or a live MCP connection.
 */

/**
 * Extract the declared input parameter names of an AI-SDK / MCP tool object.
 * Mirrors the schema-unwrapping in `packages/api/.../list-tools.ts`: the tool
 * exposes either a JSON Schema (possibly wrapped as `{ jsonSchema }` by
 * `dynamicTool()`) or a Zod schema under `parameters._def.shape`.
 */
export function getToolParamNames(tool: unknown): string[] {
	const t = tool as {
		inputSchema?: unknown;
		parameters?: { _def?: { shape?: unknown } };
	} | null;

	if (!t) {
		return [];
	}

	let schema = t.inputSchema as
		| {
				jsonSchema?: { properties?: Record<string, unknown> };
				properties?: Record<string, unknown>;
		  }
		| undefined;

	if (schema && typeof schema === "object" && "jsonSchema" in schema) {
		schema = (
			schema as { jsonSchema?: { properties?: Record<string, unknown> } }
		).jsonSchema;
	}

	if (schema?.properties && typeof schema.properties === "object") {
		return Object.keys(schema.properties);
	}

	// Zod schema (AI SDK): shape is a function (v3) or an object (v4).
	const rawShape = t.parameters?._def?.shape;
	const shape =
		typeof rawShape === "function"
			? (rawShape as () => Record<string, unknown>)()
			: (rawShape as Record<string, unknown> | undefined);
	if (shape && typeof shape === "object") {
		return Object.keys(shape);
	}

	return [];
}

/** Whether the tool declares a `cloudId` parameter (case-insensitive). */
export function toolDeclaresCloudId(tool: unknown): boolean {
	return getToolParamNames(tool).some((p) => /^cloudid$/i.test(p));
}

/**
 * Inject the persisted Atlassian `cloudId` into a tool call's params.
 *
 * No-ops (returns the original params) when:
 *  - no cloudId is stored on the config (not an Atlassian Cloud connection),
 *  - the caller already supplied a `cloudId` (their value wins), or
 *  - the tool doesn't declare a `cloudId` param (protects `atlassianUserInfo`,
 *    `getAccessibleAtlassianResources`, and every non-Atlassian server).
 */
export function injectAtlassianCloudId(
	params: Record<string, unknown>,
	tool: unknown,
	storedCloudId: string | null | undefined,
): Record<string, unknown> {
	if (!storedCloudId) {
		return params;
	}
	if (params.cloudId != null && params.cloudId !== "") {
		return params;
	}
	if (!toolDeclaresCloudId(tool)) {
		return params;
	}
	return { ...params, cloudId: storedCloudId };
}
