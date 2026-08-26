import { ORPCError } from "@orpc/server";
import {
	getMcpConfigByIdInternal,
	getOrganizationById,
	updateMcpConfigAfterDcr,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

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

			const server = cfg.mcpServer as any;
			const registrationEndpoint =
				cfg.dcrRegistrationEndpoint ||
				server.dcrRegistrationEndpoint ||
				null;

			if (!registrationEndpoint) {
				return {
					success: false,
					message:
						"Dynamic client registration is not supported for this MCP server",
				};
			}

			const metadata: Record<string, any> = {
				client_name: server.name ?? "Fabric MCP Client",
				redirect_uris: [input.redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "client_secret_basic",
			};

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

			const res = await fetch(registrationEndpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(metadata),
			});

			const json = (await res.json().catch(() => null as any)) as any;

			if (!res.ok || !json) {
				const message =
					(json && (json.error_description as string | undefined)) ||
					(json && (json.error as string | undefined)) ||
					`Dynamic client registration failed (${res.status})`;
				return { success: false, message };
			}

			const clientId = (json.client_id as string | undefined) ?? null;
			const clientSecret =
				(json.client_secret as string | undefined) ?? null;

			if (!clientId) {
				return {
					success: false,
					message: "Dynamic registration response missing client_id",
				};
			}

			const sanitizedMetadata: Record<string, any> = { ...json };
			delete sanitizedMetadata.client_secret;

			const now = new Date();

			await updateMcpConfigAfterDcr({
				configId: cfg.id,
				oauthClientId: clientId,
				encryptedOauthClientSecret: clientSecret
					? encryptApiKey(clientSecret)
					: null,
				dcrRegistrationEndpoint: registrationEndpoint,
				dcrClientMetadata: sanitizedMetadata,
				dcrRegisteredAt: now,
			});

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

			await updateMcpConfigAfterDcr({
				configId: cfg.id,
				oauthClientId: null,
				encryptedOauthClientSecret: null,
				dcrRegistrationEndpoint: null,
				dcrClientMetadata: null,
				dcrRegisteredAt: null,
			});

			return { success: true };
		}),
};
