import { isPrivateDeliverySourceCaptureEnabled } from "@repo/temporal/delivery-source-readiness";
import {
	FRAME_ORGANIZATION_AUTHORING_TOOL_NAMES,
	FRAME_REVIEW_TOOL_NAMES,
} from "@repo/temporal/fabric-frame-tool-definitions";
import {
	FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS,
	FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS,
} from "@repo/temporal/fabric-gateway-tools";
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

/** These handlers deliberately require exact consent; discovery must apply the same rule. */
const PRIVATE_DELIVERY_SOURCE_TOOLS: ReadonlySet<string> = new Set(
	FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS.map((tool) => tool.name),
);
const EXACT_SCOPE_TOOLS: ReadonlySet<string> = new Set([
	...FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS.map((tool) => tool.name),
	...PRIVATE_DELIVERY_SOURCE_TOOLS,
	...FRAME_REVIEW_TOOL_NAMES,
	...FRAME_ORGANIZATION_AUTHORING_TOOL_NAMES,
	"fabric_get_frame_branding",
	"fabric_apply_frame_branding",
	"fabric_get_report_branding",
	"fabric_get_report_instance_branding",
	"fabric_apply_report_branding",
]);

/** Full and discovery-mode lists use the same exact consent, including additional read scopes. */
export function brandingToolConsentSatisfied(
	session: Pick<GatewaySession, "credential" | "scopes"> &
		Partial<Pick<GatewaySession, "pageProjectId">>,
	tool: EligibilityTool,
): boolean {
	if (
		PRIVATE_DELIVERY_SOURCE_TOOLS.has(tool.name) &&
		(!isPrivateDeliverySourceCaptureEnabled() ||
			session.credential === "service" ||
			session.pageProjectId !== undefined)
	) {
		return false;
	}
	if (!EXACT_SCOPE_TOOLS.has(tool.name)) {
		return true;
	}
	const required = requiredToolScope(session, tool);
	return (
		session.credential === "session" ||
		scopeSatisfied(
			session.scopes,
			{ ...required, exact: true },
			session.credential,
		)
	);
}

/**
 * Whether the session's credential holds the scope `tool` requires: the same
 * scope check a direct `tools/call` makes before running it. OAuth agents
 * holding `mcp:read` may also discover non-chat Fabric platform write tools so
 * they can request human approval for them.
 */
export function credentialAllowsTool(
	session: Pick<GatewaySession, "credential" | "scopes"> &
		Partial<Pick<GatewaySession, "pageProjectId">>,
	tool: EligibilityTool,
): boolean {
	const required = requiredToolScope(session, tool);
	if (EXACT_SCOPE_TOOLS.has(tool.name)) {
		return brandingToolConsentSatisfied(session, tool);
	}

	// Discovery has no arguments: offer the brand reader when either its
	// organization or project read is consented. Execution selects the scope
	// from the resolved project binding, then repeats live object permission.
	if (tool.name === "fabric_get_artifact_brand") {
		return (
			scopeSatisfied(
				session.scopes,
				{ scope: "orgs:read", kind: "read" },
				session.credential,
			) ||
			scopeSatisfied(
				session.scopes,
				{ scope: "projects:read", kind: "read" },
				session.credential,
			)
		);
	}
	if (scopeSatisfied(session.scopes, required, session.credential)) {
		return true;
	}
	return (
		session.credential === "oauth" &&
		!required.exact &&
		session.scopes.includes("mcp:read") &&
		required.kind === "write" &&
		required.scope !== "orgs:write" &&
		!required.scope.startsWith("chats:")
	);
}

/**
 * Whether a call to `tool` goes through the runtime-authority gate with a
 * chance of being refused there. `enforceAuthority` passes a connected tool it
 * classifies as READ without a grant and asks for one for a WRITE. Platform
 * tools require runtime authority only when called by an OAuth agent relying on
 * human-approved write elevation.
 */
export function toolRequiresAuthority(
	session: Pick<GatewaySession, "credential"> & {
		scopes?: readonly string[];
	},
	tool: EligibilityTool,
): boolean {
	if (isPlatformToolName(tool.name)) {
		if (session.credential !== "oauth") {
			return false;
		}
		const required = requiredToolScope(session, tool);
		const scopes = session.scopes ?? [];
		return (
			required.kind === "write" &&
			required.scope !== "orgs:write" &&
			!required.scope.startsWith("chats:") &&
			!scopeSatisfied(scopes, required, session.credential)
		);
	}
	return (
		classifyConnectedToolAccess(
			tool.name,
			tool.annotations,
			session.credential,
		) === "WRITE"
	);
}
