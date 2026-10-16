/**
 * A family of platform tools — the workflow tools, the frame tools — as the
 * gateway registers it: each tool's definition, the scope it needs and its
 * handler, in one table built the same way for every family.
 *
 * The definition, scope and confirmation policy of a tool are Fabric's one list
 * (`@repo/temporal/fabric-*-tool-definitions`), which the Orchestrator and the
 * workflow sandbox read too; a family adds the handlers and refuses to exist
 * when the two disagree, so a tool cannot be offered without something to run
 * it or run without being offered.
 */

import {
	confirmationMeta,
	type FabricToolDefinition,
	toolAccess,
} from "@repo/temporal/fabric-tool-definition";
import type { ToolScope } from "../tool-scope";
import type {
	GatewaySession,
	GatewayToolDefinition,
	ToolCallResult,
} from "../types";

export type PlatformToolHandler = (
	args: Record<string, unknown>,
	session: GatewaySession,
) => Promise<ToolCallResult>;

export interface ToolFamily {
	definitions: GatewayToolDefinition[];
	scopes: Record<string, ToolScope>;
	handlers: ReadonlyMap<string, PlatformToolHandler>;
}

/** What the gateway tells a client about a tool: its definition, plus where it is served from. */
function gatewayDefinition(tool: FabricToolDefinition): GatewayToolDefinition {
	const meta = confirmationMeta(tool);
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
		...(meta ? { _meta: meta } : {}),
		_gateway_source: "platform",
	};
}

/**
 * Pairs a family's definitions with its handlers. Throws at load when a
 * definition has no handler or a handler has no definition: the one place a
 * tool is added is the shared list, and this is where forgetting the rest
 * shows.
 */
export function toolFamily(
	tools: readonly FabricToolDefinition[],
	handlers: ReadonlyMap<string, PlatformToolHandler>,
): ToolFamily {
	const names = new Set(tools.map((tool) => tool.name));
	const unhandled = tools.filter((tool) => !handlers.has(tool.name));
	const undefinedHandlers = [...handlers.keys()].filter(
		(name) => !names.has(name),
	);
	if (unhandled.length > 0 || undefinedHandlers.length > 0) {
		throw new Error(
			`Tool family is out of step: no handler for ${unhandled.map((tool) => tool.name).join(", ") || "none"}; no definition for ${undefinedHandlers.join(", ") || "none"}.`,
		);
	}
	return {
		definitions: tools.map(gatewayDefinition),
		scopes: Object.fromEntries(
			tools.map((tool) => [
				tool.name,
				{
					scope: tool.scope,
					kind: toolAccess(tool) === "READ" ? "read" : "write",
				} satisfies ToolScope,
			]),
		),
		handlers,
	};
}
