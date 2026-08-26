/**
 * Azure DevOps MCP tool-surface resolver.
 *
 * Microsoft's `@azure-devops/mcp` 2.9.0 (2026-07-29) consolidated ~90 granular
 * tools into ~40 action-dispatched ones. `wit_get_work_item_type` became
 * `wit_work_item { action: "get_type" }`, `wit_get_work_items_batch_by_ids`
 * became `{ action: "get_batch" }`, and so on. The catalog spawns the server
 * unpinned (`npx -y @azure-devops/mcp`), so a given connection may be on either
 * surface — re-creating a server (e.g. after a PAT expiry) pulls whichever is
 * `latest`.
 *
 * Rather than hardcode one surface's names at every call site, callers resolve
 * a LOGICAL operation here and get back the right `{ toolName, args }` pair for
 * whatever the connected server actually exposes. Argument names are identical
 * across both surfaces; the consolidated form only adds the `action` key.
 */

/** Logical work-item operations this resolver can dispatch. */
export type AdoToolOp =
	| "get"
	| "get_batch"
	| "get_type"
	| "list_comments"
	| "wiql";

/**
 * Granular (<= 2.8.x) tool names, matched by suffix so both bare
 * (`wit_get_work_item`) and prefixed (`mcp__azure-devops__wit_get_work_item`)
 * registrations resolve.
 */
const GRANULAR_PATTERNS: Record<AdoToolOp, RegExp> = {
	get: /wit_get_work_item$/i,
	get_batch: /wit_get_work_items_batch_by_ids$/i,
	get_type: /wit_get_work_item_type$/i,
	list_comments: /wit_list_work_item_comments$/i,
	wiql: /wit_query_by_wiql$/i,
};

/** Consolidated (>= 2.9.0) host tool that carries the operation as `action`. */
const CONSOLIDATED_PATTERNS: Record<AdoToolOp, RegExp> = {
	get: /wit_work_item$/i,
	get_batch: /wit_work_item$/i,
	get_type: /wit_work_item$/i,
	list_comments: /wit_work_item$/i,
	wiql: /wit_query$/i,
};

/** `action` value the consolidated tool expects for each logical operation. */
const CONSOLIDATED_ACTIONS: Record<AdoToolOp, string> = {
	get: "get",
	get_batch: "get_batch",
	get_type: "get_type",
	list_comments: "list_comments",
	wiql: "wiql",
};

export interface ResolvedAdoTool {
	toolName: string;
	args: Record<string, unknown>;
	/** Which upstream tool surface satisfied the request (useful for logs). */
	surface: "granular" | "consolidated";
}

/**
 * Resolve a logical ADO operation against a server's advertised tool list.
 *
 * Granular names win when present: a server on the old surface has no
 * action-dispatched `wit_work_item`, and a server on the new surface has none of
 * the granular names, so the two branches are mutually exclusive in practice.
 *
 * Returns `null` when neither surface is available, letting the caller raise an
 * error that names the operation rather than one version's tool.
 */
export function resolveAdoTool(
	availableTools: readonly string[],
	op: AdoToolOp,
	args: Record<string, unknown>,
): ResolvedAdoTool | null {
	const granular = availableTools.find((t) => GRANULAR_PATTERNS[op].test(t));
	if (granular) {
		return { toolName: granular, args, surface: "granular" };
	}

	const consolidated = availableTools.find((t) =>
		CONSOLIDATED_PATTERNS[op].test(t),
	);
	if (consolidated) {
		return {
			toolName: consolidated,
			args: { action: CONSOLIDATED_ACTIONS[op], ...args },
			surface: "consolidated",
		};
	}

	return null;
}

/**
 * Human-readable description of the tool(s) an operation needs, for error
 * messages — naming both surfaces keeps the failure diagnosable regardless of
 * which build the server is on.
 */
export function describeAdoToolRequirement(op: AdoToolOp): string {
	const granular = GRANULAR_PATTERNS[op].source.replace(/\$$|\\/g, "");
	const consolidated = CONSOLIDATED_PATTERNS[op].source.replace(
		/\$$|\\/g,
		"",
	);
	return `${granular} (Azure DevOps MCP <= 2.8) or ${consolidated} with action "${CONSOLIDATED_ACTIONS[op]}" (>= 2.9)`;
}
