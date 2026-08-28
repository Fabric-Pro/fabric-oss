/**
 * Shared by the Direct (`stream/route.ts`) and Orchestrator
 * (`orchestrator-temporal/stream/route.ts`) chat routes, which both union
 * managed-default MCP servers into the caller's selection before starting a
 * workflow. The union lived inline in both, and both got it wrong the same
 * way — hence one implementation with the contract stated once.
 *
 * `enabledMcpConfigIds` is a THREE-state contract (see `getDetailedMcpToolInfo`
 * in `@repo/agent-core`, which is the consumer that enforces it):
 *
 *   `null` / `undefined`  -> no filter: every enabled config for the tenant
 *   `[]`                  -> explicitly none: the user disabled all MCP servers
 *   `["id", ...]`         -> exactly these configs
 *
 * Managed defaults (`mcpServer.defaultEnabled && isSystemProvided`, e.g.
 * Excalidraw) are unioned in so they stay reachable when the caller restricted
 * the set — but ONLY into that third state. Unioning into the first two
 * *narrows* them: "all my servers" and "none of my servers" both collapse to
 * "only the managed defaults", because the previous implementation folded a
 * non-array into `[]` before spreading.
 *
 * That collapse is not hypothetical. Fizzy #2040: a six-server selection
 * reached `orchestratorExecutionWorkflow` as the single managed-default id,
 * the model correctly reported it had no Fizzy tools, and the control deck
 * showed 6/6 green throughout because it renders local state and never sees
 * the workflow input.
 *
 * Unrestricted callers lose nothing by being left alone — "every enabled
 * config" already contains the managed defaults by definition.
 */
export function unionDefaultMcpConfigIds<T extends string[] | null | undefined>(
	enabledMcpConfigIds: T,
	defaultIds: string[],
): T | string[] {
	// States 1 and 2 pass through untouched.
	if (
		!Array.isArray(enabledMcpConfigIds) ||
		enabledMcpConfigIds.length === 0
	) {
		return enabledMcpConfigIds;
	}

	if (defaultIds.length === 0) {
		return enabledMcpConfigIds;
	}

	return Array.from(new Set([...enabledMcpConfigIds, ...defaultIds]));
}
