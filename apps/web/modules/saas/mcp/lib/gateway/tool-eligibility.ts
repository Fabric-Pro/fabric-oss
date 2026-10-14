/**
 * Fabric MCP Gateway - Tool Eligibility
 *
 * Which scope a tool requires of the session's credential, and whether a call
 * to it needs a runtime-authority grant, answered from the tool's name and
 * annotations alone. Nothing here reads the database or the tool's arguments.
 *
 * The call path and discovery mode both ask these functions: `dispatchToolCall`
 * in `../gateway-endpoint` checks a connected tool's scope with
 * `connectedToolScope`, `executePlatformTool` checks a platform tool's with
 * `platformToolScope`, and `search_tools` and `get_tool_schema` offer only the
 * tools `credentialAllowsTool` passes. A tool search lists therefore passes the
 * scope check a direct call makes before running it. A handler can still check
 * a further scope of its own (`fabric_search_project_knowledge` also requires
 * `features:read`), which this table does not see.
 *
 * What these functions cannot answer is left to the call: project and other
 * resource permissions depend on the arguments, and a runtime-authority grant
 * on state that changes while the session runs.
 */

import { classifyConnectedToolAccess } from "./authority-service";
import { platformToolScope } from "./platform-tools";
import { isPlatformToolName } from "./server-selection";
import { scopeSatisfied, type ToolScope } from "./tool-scope";
import type {
	GatewayCredential,
	GatewaySession,
	ToolAnnotations,
} from "./types";

/** The part of a tool definition eligibility is decided from. */
type EligibilityTool = { name: string; annotations?: ToolAnnotations };

export { isPlatformToolName };

/**
 * The scope a connected server's tool requires: `mcp:read` for a tool
 * `classifyConnectedToolAccess` reads as READ for this credential, `mcp:write`
 * otherwise.
 */
export function connectedToolScope(
	toolName: string,
	annotations:
		| Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint">
		| undefined,
	credential: GatewayCredential,
): ToolScope {
	return classifyConnectedToolAccess(toolName, annotations, credential) ===
		"READ"
		? { scope: "mcp:read", kind: "read" }
		: { scope: "mcp:write", kind: "write" };
}

/** The scope a tool requires of the session's credential. */
function requiredToolScope(
	session: Pick<GatewaySession, "credential">,
	tool: EligibilityTool,
): ToolScope {
	return isPlatformToolName(tool.name)
		? platformToolScope(tool.name)
		: connectedToolScope(tool.name, tool.annotations, session.credential);
}

/**
 * Whether the session's credential holds the scope `tool` requires: the same
 * scope check a direct `tools/call` makes before running it.
 */
export function credentialAllowsTool(
	session: Pick<GatewaySession, "credential" | "scopes">,
	tool: EligibilityTool,
): boolean {
	return scopeSatisfied(
		session.scopes,
		requiredToolScope(session, tool),
		session.credential,
	);
}

/**
 * Whether a call to `tool` goes through the runtime-authority gate with a
 * chance of being refused there. `enforceAuthority` passes a connected tool it
 * classifies as READ without a grant and asks for one for a WRITE. Platform
 * tools are routed to `executePlatformTool` by `dispatchToolCall` and do not
 * reach it.
 */
export function toolRequiresAuthority(
	session: Pick<GatewaySession, "credential">,
	tool: EligibilityTool,
): boolean {
	if (isPlatformToolName(tool.name)) {
		return false;
	}
	return (
		classifyConnectedToolAccess(
			tool.name,
			tool.annotations,
			session.credential,
		) === "WRITE"
	);
}
