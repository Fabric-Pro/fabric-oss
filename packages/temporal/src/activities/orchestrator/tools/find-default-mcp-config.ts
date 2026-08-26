/**
 * Find Default MCP Config Activity
 *
 * Resolves the user's MCPConfig for a specific managed-default server (keyed
 * by `args.serverKey` against `MCPServer.key`), scoped to the caller's tenant
 * (XOR pattern — personal context uses `organizationId: null`, org context
 * uses the supplied id).
 *
 * Used by the generalized default-MCP eager-routing helper
 * (`applyDefaultMcpEagerRouting`) to decide whether to:
 *   - eager-load the server's `eagerToolName` so the model can call it
 *     directly, or
 *   - emit a "service-down"/CTA short-circuit (the status card path).
 *
 * `enabledMcpConfigIds` semantics for this lookup:
 *   - `null` or `[]` → no agent-level restriction. Falls back to the
 *     tenant-level managed-default config so the routing helper can
 *     surface a connected MCP server even when the active agent has no
 *     inherent scope (e.g., a model-as-agent like "Claude Sonnet 4.5"
 *     which the frontend defaults to `[]`).
 *   - non-empty array → restricts the lookup to those ids so an agent
 *     with an explicit non-default scope (e.g., a template instance
 *     wired to GitHub + Notion) does not have a default server silently
 *     promoted into its tool set.
 *
 * Returns `null` when no enabled config exists in the resolved scope —
 * the caller is responsible for emitting the CTA / status card.
 *
 * @example
 *   await findDefaultMcpConfigActivity({
 *     serverKey: "excalidraw",
 *     enabledMcpConfigIds: input.enabledMcpConfigIds ?? null,
 *     userId: input.userId,
 *     organizationId: input.organizationId,
 *   });
 */

import { db } from "@repo/database";

export interface FindDefaultMcpConfigArgs {
	/**
	 * Registry `MCPServer.key` to resolve (e.g. "excalidraw"). Parameterized
	 * so the same activity covers every managed-default server.
	 */
	serverKey: string;
	/**
	 * Optional config-id restriction. `null` and `[]` both mean
	 * "no agent-level scope, fall back to tenant-level lookup". A
	 * non-empty array narrows the lookup to those ids.
	 */
	enabledMcpConfigIds: string[] | null;
	/** Tenant — required. */
	userId: string;
	/** Tenant — undefined means personal context (organizationId: null). */
	organizationId: string | undefined;
}

export interface FindDefaultMcpConfigResult {
	configId: string;
	mcpServerKey: string;
}

export async function findDefaultMcpConfigActivity(
	args: FindDefaultMcpConfigArgs,
): Promise<FindDefaultMcpConfigResult | null> {
	return findExcalidrawConfigActivity(args);
}

/**
 * Replay-compat alias. Pre-rename workflow histories scheduled this
 * activity under the legacy name `findExcalidrawConfigActivity`. Keeping
 * the original name registered ensures dev histories from before this
 * feature rolled out still replay deterministically. The implementation
 * is fully parameterized on `serverKey`, so no Excalidraw-specific
 * behavior lives here — only the activity name is historical.
 */
export async function findExcalidrawConfigActivity(
	args: FindDefaultMcpConfigArgs,
): Promise<FindDefaultMcpConfigResult | null> {
	const { serverKey, enabledMcpConfigIds, userId, organizationId } = args;

	// XOR tenant filter — never use OR. Personal context REQUIRES
	// organizationId: null (a missing key would match every org's rows).
	const tenantFilter = {
		userId,
		organizationId: organizationId ?? null,
	};

	// Apply the id restriction only when the caller passed a non-empty
	// array. An empty array is the frontend default for model-as-agent
	// (no inherent scope) and is treated the same as `null` here so the
	// tenant-level connection still surfaces. Other code paths
	// (search-tools.ts, pre-loading) keep their existing empty-array
	// behavior — only this default-MCP routing lookup falls back.
	const config = await db.mCPConfig.findFirst({
		where: {
			...tenantFilter,
			enabled: true,
			mcpServer: {
				key: serverKey,
			},
			...(enabledMcpConfigIds && enabledMcpConfigIds.length > 0
				? { id: { in: enabledMcpConfigIds } }
				: {}),
		},
		select: {
			id: true,
		},
	});

	if (!config) {
		return null;
	}

	return {
		configId: config.id,
		mcpServerKey: serverKey,
	};
}
