import { ORPCError } from "@orpc/server";
import {
	createCustomMcpServer,
	deleteCustomMcpServer,
	getOrganizationById,
	listCustomMcpServersForTenant,
	listMcpServersAccessibleToTenant,
	Prisma,
	updateCustomMcpServer,
} from "@repo/database";
import { z } from "zod";
import {
	getCachedSystemServers,
	setCachedSystemServers,
} from "../../../lib/mcp-registry-cache";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const transportEnum = z.enum(["SSE", "HTTP", "STDIO"]);
const authTypeEnum = z.enum(["NONE", "API_KEY", "OAUTH2"]);
const apiKeyMethodEnum = z.enum(["BEARER", "HEADER", "PLAIN"]);

export const registryProcedures = {
	list: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_READ))
		.route({
			method: "GET",
			path: "/mcp/registry",
			tags: ["MCP"],
			summary: "List MCP servers",
			description:
				"List system and custom MCP servers accessible to the tenant",
		})
		.input(
			z
				.object({
					organizationId: z.string().nullable().optional(),
					includeAll: z.boolean().optional(),
				})
				.optional(),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const organizationId = input?.organizationId;

			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					userId,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			if (!input?.includeAll) {
				// Check Redis cache for system servers (they only change on seed:mcp-registry)
				const cachedSystemServers =
					await getCachedSystemServers<
						Awaited<
							ReturnType<typeof listMcpServersAccessibleToTenant>
						>[number]
					>();

				if (cachedSystemServers) {
					// Cache hit — only query the user's small set of custom servers from DB
					const customServers = await listCustomMcpServersForTenant({
						userId,
						organizationId: organizationId ?? undefined,
					});
					return [...cachedSystemServers, ...customServers];
				}
			}

			// Cache miss or includeAll — fetch everything from DB
			const allServers = await listMcpServersAccessibleToTenant({
				userId,
				organizationId: organizationId ?? undefined,
				includeNonImplemented: input?.includeAll ?? false,
			});

			if (!input?.includeAll) {
				// Populate cache with just the system servers (fire-and-forget)
				const systemServers = allServers.filter(
					(s) => s.isSystemProvided,
				);
				setCachedSystemServers(systemServers).catch(() => {});
			}

			return allServers;
		}),

	create: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CREATE))
		.route({
			method: "POST",
			path: "/mcp/registry",
			tags: ["MCP"],
			summary: "Create a custom MCP server",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
				key: z.string().min(1),
				name: z.string().min(1),
				description: z.string().optional().nullable(),
				defaultUrl: z.string().url().optional().nullable(),
				docsUrl: z.string().url().optional().nullable(),
				transport: transportEnum,
				authMethods: z.array(authTypeEnum).min(1),
				apiKeyMethod: apiKeyMethodEnum.optional().nullable(), // Default API key method for this server
				oauthDiscoveryUrl: z.string().url().optional().nullable(),
				oauthAuthorizationEndpoint: z
					.string()
					.url()
					.optional()
					.nullable(),
				oauthTokenEndpoint: z.string().url().optional().nullable(),
				dcrRegistrationEndpoint: z.string().url().optional().nullable(),
				category: z.string().optional().nullable(),
				tags: z.array(z.string()).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { organizationId, ...data } = input;

			if (organizationId) {
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
			}

			// Per-user within context pattern: custom servers remain private to the user,
			// even inside an organization context.
			try {
				return await createCustomMcpServer({
					userId,
					organizationId: organizationId ?? undefined,
					createdById: userId,
					data,
				});
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002"
				) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"A custom MCP server with this key already exists for this scope. Try a different name.",
					});
				}
				throw error;
			}
		}),

	update: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_UPDATE))
		.route({
			method: "PATCH",
			path: "/mcp/registry/:id",
			tags: ["MCP"],
			summary: "Update a custom MCP server",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
				name: z.string().optional(),
				description: z.string().optional().nullable(),
				defaultUrl: z.string().url().optional().nullable(),
				docsUrl: z.string().url().optional().nullable(),
				transport: transportEnum.optional(),
				authMethods: z.array(authTypeEnum).optional(),
				apiKeyMethod: apiKeyMethodEnum.optional().nullable(), // Default API key method for this server
				oauthDiscoveryUrl: z.string().url().optional().nullable(),
				oauthAuthorizationEndpoint: z
					.string()
					.url()
					.optional()
					.nullable(),
				oauthTokenEndpoint: z.string().url().optional().nullable(),
				dcrRegistrationEndpoint: z.string().url().optional().nullable(),
				category: z.string().optional().nullable(),
				tags: z.array(z.string()).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { id, organizationId, ...data } = input;

			if (organizationId) {
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
			}

			return await updateCustomMcpServer({
				id,
				userId,
				organizationId: organizationId ?? undefined,
				data,
			});
		}),

	delete: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_DELETE))
		.route({
			method: "DELETE",
			path: "/mcp/registry/:id",
			tags: ["MCP"],
			summary: "Delete a custom MCP server",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ success: z.boolean() }))
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { id, organizationId } = input;

			if (organizationId) {
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
			}

			return await deleteCustomMcpServer({
				id,
				userId,
				organizationId: organizationId ?? undefined,
			});
		}),
};
