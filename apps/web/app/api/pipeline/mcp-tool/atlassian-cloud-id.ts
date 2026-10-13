/**
 * Atlassian Rovo cloudId injection.
 *
 * Atlassian's Rovo MCP server requires a `cloudId` on nearly every tool call
 * (getConfluenceSpaces, getPagesInConfluenceSpace, getConfluencePage,
 * searchConfluenceUsingCql, the Jira tools…). The OAuth flow resolves
 * and persists that cloudId on the MCP config (`atlassianCloudCloudId`), or
 * falls back to resolving it via Rovo on demand, so the generic tool-execution
 * route can inject it transparently — callers don't need to resolve it per request.
 *
 * Kept lightweight so the guard and resolution logic is unit-testable
 * without standing up the route, the DB, or a live MCP connection.
 */

import { extractAtlassianSiteId } from "@repo/utils";

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

// Rovo-resolved site ids, per config and grant generation: a new grant misses.
const SITE_ID_TTL_MS = 10 * 60_000;
const SITE_ID_CACHE_MAX = 500;
const siteIdCache = new Map<string, { siteId: string; expiresAt: number }>();

export function clearSiteIdCacheForTests(): void {
	siteIdCache.clear();
}

/**
 * Resolves the Atlassian site id when none is stored on the config yet.
 * Asks Rovo via `getAccessibleAtlassianResources` if available,
 * extracts the first site ID, and caches it in memory under `cacheKey`.
 */
export async function resolveAtlassianSiteId({
	storedSiteId,
	resolverTool,
	cacheKey,
	parseResult,
}: {
	storedSiteId?: string | null;
	resolverTool?: {
		execute: (
			params: Record<string, unknown>,
			context: { toolCallId: string; messages: unknown[] },
		) => Promise<unknown>;
	} | null;
	cacheKey?: string;
	parseResult?: (result: unknown) => unknown;
}): Promise<string | null> {
	if (storedSiteId) {
		return storedSiteId;
	}
	if (!resolverTool || typeof resolverTool.execute !== "function") {
		return null;
	}
	const hit = cacheKey ? siteIdCache.get(cacheKey) : undefined;
	if (hit && hit.expiresAt > Date.now()) {
		return hit.siteId;
	}
	let siteId: string | null = null;
	try {
		const raw = await resolverTool.execute(
			{},
			{ toolCallId: `site-${Date.now()}`, messages: [] },
		);
		siteId = extractAtlassianSiteId(parseResult ? parseResult(raw) : raw);
	} catch (err) {
		console.warn(
			"[MCP Tool API] Atlassian site id lookup failed",
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
	if (siteId && cacheKey) {
		if (siteIdCache.size >= SITE_ID_CACHE_MAX) {
			const firstKey = siteIdCache.keys().next().value;
			if (firstKey !== undefined) {
				siteIdCache.delete(firstKey);
			}
		}
		siteIdCache.set(cacheKey, {
			siteId,
			expiresAt: Date.now() + SITE_ID_TTL_MS,
		});
	}
	return siteId;
}
