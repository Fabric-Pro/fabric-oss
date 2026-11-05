import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "@repo/api/lib/audit";
import {
	canUpdateOrganizationMcpServers,
	findOwnedCustomMcpServer,
	setOwnedCustomMcpServerIcon,
} from "@repo/database";
import {
	decideServerIconWrite,
	type McpServerIconEntry,
} from "@saas/mcp/lib/server-provided-icon";

export type RecordServerIconInput = {
	headers: Headers;
	user: NonNullable<AuditRequestContext["user"]>;
	session: AuditRequestContext["session"];
	/** The config's server, as loaded by the route. */
	mcpServerId: string | null | undefined;
	isSystemProvided: boolean | null | undefined;
	/** The config's organization; personal (null) configs are never written. */
	organizationId: string | null | undefined;
	/** The URL the handshake reached, already matched to the configured one. */
	serverUrl: string;
	icons: readonly McpServerIconEntry[] | undefined;
	websiteUrl: string | undefined;
};

export type RecordServerIconOutcome =
	| "written"
	| "unchanged"
	| "not-applicable"
	| "not-owner"
	| "forbidden"
	| "failed";

/**
 * After a successful test connection, store the icon the server listed for
 * itself as its `MCPServer.iconUrl`, when:
 * - the server is a custom one (never system or catalog);
 * - the caller owns it in the config's organization;
 * - the caller holds MCP_UPDATE there, as `mcp.registry.update` requires;
 * - `decideServerIconWrite` says the stored icon is empty or the server's own.
 *
 * Never throws: an icon is decoration, and a failure here must not fail the
 * connection test.
 */
export async function recordServerProvidedIcon(
	input: RecordServerIconInput,
): Promise<RecordServerIconOutcome> {
	try {
		const { mcpServerId, organizationId } = input;
		if (
			!mcpServerId ||
			input.isSystemProvided !== false ||
			!organizationId ||
			!Array.isArray(input.icons) ||
			input.icons.length === 0
		) {
			return "not-applicable";
		}

		const server = await findOwnedCustomMcpServer({
			id: mcpServerId,
			userId: input.user.id,
			organizationId,
		});
		if (!server) {
			return "not-owner";
		}
		if (
			!(await canUpdateOrganizationMcpServers(
				input.user.id,
				organizationId,
			))
		) {
			return "forbidden";
		}

		const next = decideServerIconWrite({
			storedIconUrl: server.iconUrl,
			serverUrl: server.defaultUrl ?? input.serverUrl,
			websiteUrl: input.websiteUrl,
			icons: input.icons,
		});
		if (!next) {
			return "unchanged";
		}

		const changed = await setOwnedCustomMcpServerIcon({
			id: server.id,
			userId: input.user.id,
			organizationId,
			expectedIconUrl: server.iconUrl,
			iconUrl: next,
		});
		if (!changed) {
			return "unchanged";
		}

		recordAuditFromRequest(
			{
				headers: input.headers,
				user: input.user,
				session: input.session,
			},
			{
				// The MCP taxonomy has no server action; a custom server is
				// managed with its configs, so this reuses the config update
				// action with an `mcp_server` resource.
				action: "mcp.config.updated",
				category: "mcp",
				organizationId,
				resource: {
					type: "mcp_server",
					id: server.id,
					name: server.name,
				},
				metadata: {
					change: "server_icon_updated",
					source: "server_info_icons",
					previous: server.iconUrl ? "set" : "empty",
					iconScheme: next.startsWith("data:") ? "data" : "https",
				},
			},
		);
		return "written";
	} catch (error) {
		if (process.env.NODE_ENV === "development") {
			console.warn("[MCP Test] Could not store the server's icon:", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return "failed";
	}
}
