import { ORPCError } from "@orpc/server";
import {
	allowlistDcrClientMetadata,
	getMcpConfigByIdInternal,
	getMcpServerForTenant,
	getOrganizationById,
	replaceMcpOAuthRegistration,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import {
	registerOAuthClient,
	resolveAuthorizationServer,
} from "../lib/oauth-authorization-server";

async function ensureConfigAdminAccess(cfg: any, userId: string) {
	if (cfg.userId) {
		if (cfg.userId !== userId) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this MCP config",
			});
		}
		return;
	}

	if (cfg.organizationId) {
		const organizationId = cfg.organizationId as string;
		const organization = await getOrganizationById(organizationId);

		if (!organization) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization not found",
			});
		}

		const membership = await verifyOrganizationMembership(
			organizationId,
			userId,
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		if (membership.role !== "admin" && membership.role !== "owner") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization admins can manage OAuth for this MCP config",
			});
		}
		return;
	}

	throw new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "MCP config must belong to a user or an organization",
	});
}

export const dcrProcedures = {
	register: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CREATE))
		.route({
			method: "POST",
			path: "/mcp/dcr/register",
			tags: ["MCP"],
			summary: "Register OAuth client via Dynamic Client Registration",
		})
		.input(
			z.object({
				configId: z.string(),
				redirectUri: z.string().url(),
				scopes: z.array(z.string()).optional(),
				metadata: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				message: z.string().optional(),
				oauthClientId: z.string().optional(),
				registeredAt: z.date().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use internal version - authorization is done below via ensureConfigAdminAccess
			const cfg = await getMcpConfigByIdInternal(input.configId);

			if (!cfg) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP config not found",
				});
			}

			await ensureConfigAdminAccess(cfg, userId);

			// Register only for a server the config's tenant may use: never
			// one another person or organization controls.
			const accessibleServer = await getMcpServerForTenant(
				cfg.mcpServerId,
				{
					userId: cfg.userId,
					organizationId: cfg.organizationId,
				},
			);
			if (!accessibleServer) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"This MCP config refers to a server you cannot use.",
				});
			}

			const server = cfg.mcpServer as any;
			// Register at the authorization server the connect flow would use
			// (the catalog's, else the discovered one), and bind the new client
			// to it. A stored registration endpoint from an earlier flow is not
			// reused: which AS it belongs to is not recorded.
			const snapshot = await resolveAuthorizationServer({
				server,
				baseUrl: cfg.baseUrl || server?.defaultUrl || null,
			});
			const registrationEndpoint = snapshot?.registrationEndpoint ?? null;

			if (!snapshot || !registrationEndpoint) {
				return {
					success: false,
					message:
						"Dynamic client registration is not supported for this MCP server",
				};
			}

			const metadata: Record<string, unknown> = {
				client_name: server.name ?? "Fabric MCP Client",
				redirect_uris: [input.redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "client_secret_basic",
			};
			// `input.metadata` may override it; what was requested is what the
			// AS registers when its response does not say otherwise.

			const scopes =
				(input.scopes && input.scopes.length > 0
					? input.scopes
					: cfg.scopes && cfg.scopes.length > 0
						? cfg.scopes
						: undefined) ?? undefined;

			if (scopes && scopes.length > 0) {
				metadata.scope = scopes.join(" ");
			}

			if (input.metadata) {
				for (const [key, value] of Object.entries(input.metadata)) {
					if (key === "client_id" || key === "client_secret") {
						continue;
					}
					metadata[key] = value;
				}
			}

			const requestedAuthMethod =
				metadata.token_endpoint_auth_method === "client_secret_post" ||
				metadata.token_endpoint_auth_method === "none"
					? metadata.token_endpoint_auth_method
					: "client_secret_basic";
			const registered = await registerOAuthClient({
				registrationEndpoint,
				metadata,
			});
			if (!registered.ok) {
				return { success: false, message: registered.message };
			}

			const now = new Date();

			// A new client replaces the registration: its binding is the AS it
			// was registered at, and the old client's tokens are cleared.
			const written = await replaceMcpOAuthRegistration({
				configId: cfg.id,
				// Derived from the read above: refused if the config's
				// credentials changed since (a newer grant or registration).
				expectedGeneration: cfg.oauthGrantGeneration,
				client: {
					oauthClientId: registered.clientId,
					encryptedOauthClientSecret: registered.clientSecret
						? encryptApiKey(registered.clientSecret)
						: null,
					dcrClientMetadata: allowlistDcrClientMetadata(
						registered.response,
						snapshot.binding.authorizationServerUrl,
						requestedAuthMethod,
					),
					dcrRegistrationEndpoint: registrationEndpoint,
					dcrRegisteredAt: now,
				},
				binding: snapshot.binding,
			});
			if (!written.written) {
				throw new ORPCError("CONFLICT", {
					message:
						"This MCP connection changed during registration. Please try again.",
				});
			}

			const clientId = registered.clientId;
			return {
				success: true,
				message: "Dynamic client registration completed",
				oauthClientId: clientId,
				registeredAt: now,
			};
		}),

	unregister: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_UPDATE))
		.route({
			method: "POST",
			path: "/mcp/dcr/unregister",
			tags: ["MCP"],
			summary: "Clear Dynamic Client Registration for MCP config",
		})
		.input(z.object({ configId: z.string() }))
		.output(z.object({ success: z.boolean() }))
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use internal version - authorization is done below via ensureConfigAdminAccess
			const cfg = await getMcpConfigByIdInternal(input.configId);

			if (!cfg) {
				return { success: true };
			}

			await ensureConfigAdminAccess(cfg, userId);

			// Removing the client removes what its grant belongs to: tokens and
			// binding go with it, and the generation moves so nothing in flight
			// writes them back.
			const removed = await replaceMcpOAuthRegistration({
				configId: cfg.id,
				expectedGeneration: cfg.oauthGrantGeneration,
				client: null,
				binding: null,
			});
			if (!removed.written) {
				throw new ORPCError("CONFLICT", {
					message:
						"This MCP connection changed meanwhile. Reload and try again.",
				});
			}

			return { success: true };
		}),
};
