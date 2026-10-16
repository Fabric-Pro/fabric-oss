/**
 * Fabric MCP Gateway - Types
 *
 * Type definitions for the unified MCP gateway that aggregates
 * platform tools and user-connected MCP servers.
 */

import type { ConfirmationMeta } from "@repo/temporal/fabric-tool-definition";

/**
 * What proved the caller's identity for this session.
 *
 * The gateway used to forget this the moment authentication finished, which
 * made an API-key request indistinguishable from a browser one. Two things
 * depend on telling them apart: an organization key is bound to the tenant it
 * was issued for and may not be steered out of it, and the scopes chosen when a
 * key was created only mean something if the surface consuming them knows a key
 * was involved.
 */
export type GatewayCredential =
	/** `org_` key — tenant fixed by the key record. */
	| "organization-key"
	/** `fab_` key — tenant resolved per request from the owner's memberships. */
	| "personal-key"
	/**
	 * A coding agent signed in over OAuth. Like an organization key its tenant
	 * is fixed (at consent time) and may not be steered by a request header.
	 */
	| "oauth"
	/** Browser cookie. Carries the user's full interactive authority. */
	| "session"
	/**
	 * Fabric's own agent runtime (the Temporal worker), acting for the user and
	 * organization it names. Proven by the shared agent service secret; the
	 * named user must belong to the named organization, whose tenant is then
	 * fixed for the session. Holds `SERVICE_CREDENTIAL_SCOPES`, not a wildcard.
	 */
	| "service";

/**
 * Where the acting user is when Fabric's own agent calls a tool: the page the
 * chat was opened from and the run that is calling. Tools read it as the
 * default placement for what they create; it never widens access.
 */
export interface GatewayActingContext {
	projectId?: string;
	workspaceId?: string;
	/** The kind of page the chat was opened from; a new page defaults to it. */
	surface?: "artifact" | "workspace";
	conversationId?: string;
	sourceRunType?: string;
	sourceRunId?: string;
}

export interface GatewaySession {
	sessionId: string;
	userId: string;
	organizationId: string | null;
	/**
	 * The one project this session reaches, when it was opened from a project's
	 * URL; absent or null for an organization-wide session. A bound session's
	 * organization is the one hosting the project, and `./project-binding` is
	 * what keeps every tool call on it.
	 */
	projectId?: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
	/** How this session authenticated. See `GatewayCredential`. */
	credential: GatewayCredential;
	/**
	 * The `OauthClient` row of the agent that signed in, for the `oauth`
	 * credential; absent for every other. Writes name it as their author's agent.
	 */
	oauthClientId?: string;
	/** Set only for the `service` credential. See `GatewayActingContext`. */
	actingContext?: GatewayActingContext;
	/**
	 * Scopes granted by the API key that opened this session.
	 *
	 * A browser session carries `["*"]`: there is no key to have chosen scopes,
	 * and the interactive permission checks that already govern the UI are not
	 * loosened by anything here.
	 */
	scopes: string[];
	/**
	 * The servers and tools this session's client asked to see, by the
	 * `servers` query parameter of the URL it opened the session at. Absent or
	 * null means every server. Set by `createGatewaySession` and `readonly`
	 * after that, so a later request's query string does not move it;
	 * `./server-selection` reads it. It narrows what the client sees and may
	 * call, and grants nothing.
	 */
	readonly serverSelection?: ServerSelection | null;
	/**
	 * How `tools/list` presents this session's tools, by the `mode` query
	 * parameter of the URL it was opened at: every tool (`full`, also when
	 * absent) or three meta-tools that search, describe and call them
	 * (`discovery`, see `./discovery-tools`). Set by `createGatewaySession` and
	 * `readonly` after that, like `serverSelection`. It changes presentation
	 * only: what a session may call is the same in either mode.
	 */
	readonly toolListMode?: ToolListMode;
	createdAt: Date;
	expiresAt: Date;
}

/** See `GatewaySession.toolListMode`. */
export type ToolListMode = "full" | "discovery";

/**
 * A session's server selection: one entry per server named, with every tool of
 * it (`"*"`) or only the tools listed. `server` is `fabric` for the platform
 * tools or a connected server's tool prefix; a listed tool is the full platform
 * name for `fabric`, and the server's own name (what follows `<prefix>__`) for a
 * connected server. Parsed by `parseServerSelection` in `./server-selection`.
 */
export type ServerSelection = ReadonlyArray<{
	readonly server: string;
	readonly tools: "*" | readonly string[];
}>;

/** The MCP tool annotations the gateway reads. A server's own claims, not Fabric's. */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface GatewayToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** Source: "platform" for Fabric tools, or MCPConfig displayName for connected servers */
	_gateway_source?: string;
	/** MCPConfig ID if this tool comes from a connected server */
	_gateway_config_id?: string;
	/** MCP tool annotations */
	annotations?: ToolAnnotations;
	/**
	 * MCP `_meta` for a Fabric platform tool: when a chat must have the person
	 * confirm a call before it runs (`ConfirmationPolicy`, as it travels on the
	 * wire). A gateway client that does not know the key ignores it, and the
	 * gateway itself stays prompt-free (keys are governed by scopes).
	 */
	_meta?: ConfirmationMeta;
}

export interface ToolCallResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	structuredContent?: unknown;
}

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

/**
 * Connected MCP server info for tool aggregation
 */
export interface ConnectedServerInfo {
	configId: string;
	displayName: string;
	toolPrefix: string;
	tools: Array<{
		name: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
		annotations?: ToolAnnotations;
	}>;
}

/**
 * Credentials whose tenant is fixed when they are issued, so a request may not
 * move them to another organization — an organization key at creation, an OAuth
 * token at consent. Every "may this reach that organization" decision asks this
 * rather than comparing against one credential kind.
 */
export function isOrganizationBoundCredential(
	credential: GatewayCredential,
): boolean {
	return (
		credential === "organization-key" ||
		credential === "oauth" ||
		credential === "service"
	);
}

/**
 * Credentials that act for a person without being that person at a keyboard —
 * a coding agent signed in over OAuth, an organization key, or Fabric's own
 * agent runtime. What they may do is whatever the person consented to, the
 * key's creator chose or the runtime's scope ceiling allows, so they are held
 * to declared facts (a server's own `readOnlyHint`, the granted scopes) and
 * never to a guess made from a tool's name.
 */
export function isDelegatedCredential(credential: GatewayCredential): boolean {
	return (
		credential === "organization-key" ||
		credential === "oauth" ||
		credential === "service"
	);
}
