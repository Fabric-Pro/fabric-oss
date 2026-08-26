/**
 * OpenAPI Service Management Procedures
 *
 * Handles onboarding, listing, updating, and deleting OpenAPI services.
 */

import { ORPCError } from "@orpc/server";
import {
	createOpenAPIService,
	deleteOpenAPIService,
	getOpenAPIServiceById,
	getOrganizationById,
	listOpenAPIServicesForTenant,
	Prisma,
	syncOpenAPIServiceTools,
	updateOpenAPIService,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// Input schemas
const authTypeEnum = z.enum(["NONE", "API_KEY", "BEARER", "BASIC", "OAUTH2"]);
const authLocationEnum = z.enum(["HEADER", "QUERY", "COOKIE"]);
const statusEnum = z.enum(["ACTIVE", "INACTIVE", "ERROR", "SYNCING"]);

const onboardServiceInput = z.object({
	organizationId: z.string().nullable().optional(),
	specUrl: z.string().url(),
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional().nullable(),
	baseUrl: z.string().url().optional().nullable(),
	authType: authTypeEnum.default("NONE"),
	authLocation: authLocationEnum.optional().nullable(),
	authKey: z.string().optional().nullable(),
	authValue: z.string().optional().nullable(), // Will be encrypted
	category: z.string().optional().nullable(),
	tags: z.array(z.string()).default([]),
});

export const servicesProcedures = {
	/**
	 * Onboard a new OpenAPI service
	 * Parses the spec URL and creates tools automatically
	 */
	onboard: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_MANAGE))
		.route({
			method: "POST",
			path: "/openapi/services",
			tags: ["OpenAPI"],
			summary: "Onboard an OpenAPI service",
			description:
				"Parse an OpenAPI spec URL and create tools automatically",
		})
		.input(onboardServiceInput)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { organizationId, authValue, ...data } = input;

			// Verify organization membership if scoped to org
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

				if (
					membership.role !== "admin" &&
					membership.role !== "owner"
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization admins can manage OpenAPI services",
					});
				}
			}

			// Parse the OpenAPI spec
			const { parseOpenAPISpec } = await import("@repo/openapi-tools");
			let parsedSpec:
				| Awaited<ReturnType<typeof parseOpenAPISpec>>
				| undefined;
			try {
				parsedSpec = await parseOpenAPISpec(data.specUrl);
			} catch (error) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Failed to parse OpenAPI spec: ${error instanceof Error ? error.message : "Unknown error"}`,
				});
			}

			// Encrypt auth value if provided
			const encryptedAuthValue = authValue
				? encryptApiKey(authValue)
				: null;

			// Create the service
			const tenantUserId = organizationId ? undefined : userId;
			try {
				const service = await createOpenAPIService({
					createdById: userId,
					userId: tenantUserId,
					organizationId,
					name: data.name,
					specUrl: data.specUrl,
					specHash: parsedSpec.specHash,
					baseUrl: data.baseUrl ?? parsedSpec.baseUrl ?? null,
					description:
						data.description ?? parsedSpec.description ?? null,
					authType: data.authType,
					authLocation: data.authLocation ?? null,
					authKey: data.authKey ?? null,
					encryptedAuthValue,
					category: data.category ?? null,
					tags: data.tags,
				});

				// Sync tools from parsed spec
				await syncOpenAPIServiceTools({
					serviceId: service.id,
					specHash: parsedSpec.specHash,
					tools: parsedSpec.tools,
				});

				// Refetch with tools
				return await getOpenAPIServiceById({
					id: service.id,
					userId: tenantUserId,
					organizationId: organizationId ?? undefined,
				});
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002"
				) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"An OpenAPI service with this spec URL already exists",
					});
				}
				throw error;
			}
		}),

	/**
	 * List OpenAPI services for the current tenant
	 */
	list: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_READ))
		.route({
			method: "GET",
			path: "/openapi/services",
			tags: ["OpenAPI"],
			summary: "List OpenAPI services",
		})
		.input(
			z
				.object({ organizationId: z.string().nullable().optional() })
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

			return await listOpenAPIServicesForTenant({
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
			});
		}),

	/**
	 * Get a single OpenAPI service by ID
	 */
	get: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_READ))
		.route({
			method: "GET",
			path: "/openapi/services/:id",
			tags: ["OpenAPI"],
			summary: "Get an OpenAPI service",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { id, organizationId } = input;

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

			const service = await getOpenAPIServiceById({
				id,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
			});

			if (!service) {
				throw new ORPCError("NOT_FOUND", {
					message: "OpenAPI service not found",
				});
			}

			return service;
		}),

	/**
	 * Update an OpenAPI service
	 */
	update: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_MANAGE))
		.route({
			method: "PATCH",
			path: "/openapi/services/:id",
			tags: ["OpenAPI"],
			summary: "Update an OpenAPI service",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
				name: z.string().min(1).max(100).optional(),
				description: z.string().max(500).optional().nullable(),
				baseUrl: z.string().url().optional().nullable(),
				authType: authTypeEnum.optional(),
				authLocation: authLocationEnum.optional().nullable(),
				authKey: z.string().optional().nullable(),
				authValue: z.string().optional().nullable(),
				category: z.string().optional().nullable(),
				tags: z.array(z.string()).optional(),
				status: statusEnum.optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { id, organizationId, authValue, ...data } = input;

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

				if (
					membership.role !== "admin" &&
					membership.role !== "owner"
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization admins can manage OpenAPI services",
					});
				}
			}

			// Encrypt auth value if provided
			const updateData: Record<string, unknown> = { ...data };
			if (authValue !== undefined) {
				updateData.encryptedAuthValue = authValue
					? encryptApiKey(authValue)
					: null;
			}

			return await updateOpenAPIService({
				id,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
				data: updateData as Parameters<
					typeof updateOpenAPIService
				>[0]["data"],
			});
		}),

	/**
	 * Delete an OpenAPI service
	 */
	delete: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_MANAGE))
		.route({
			method: "DELETE",
			path: "/openapi/services/:id",
			tags: ["OpenAPI"],
			summary: "Delete an OpenAPI service",
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
				const membership = await verifyOrganizationMembership(
					organizationId,
					userId,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}

				if (
					membership.role !== "admin" &&
					membership.role !== "owner"
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization admins can manage OpenAPI services",
					});
				}
			}

			return await deleteOpenAPIService({
				id,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
			});
		}),

	/**
	 * Sync/refresh tools from an OpenAPI service
	 */
	sync: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_MANAGE))
		.route({
			method: "POST",
			path: "/openapi/services/:id/sync",
			tags: ["OpenAPI"],
			summary: "Sync tools from OpenAPI spec",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { id, organizationId } = input;

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

			// Get existing service
			const service = await getOpenAPIServiceById({
				id,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
			});

			if (!service) {
				throw new ORPCError("NOT_FOUND", {
					message: "OpenAPI service not found",
				});
			}

			// Update status to syncing
			await updateOpenAPIService({
				id,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
				data: { status: "SYNCING" },
			});

			try {
				// Re-parse the spec
				const { parseOpenAPISpec } = await import(
					"@repo/openapi-tools"
				);
				const parsedSpec = await parseOpenAPISpec(service.specUrl);

				// Sync tools
				const tools = await syncOpenAPIServiceTools({
					serviceId: id,
					specHash: parsedSpec.specHash,
					tools: parsedSpec.tools,
				});

				// Update status back to active
				await updateOpenAPIService({
					id,
					userId: organizationId ? undefined : userId,
					organizationId: organizationId ?? undefined,
					data: { status: "ACTIVE", specHash: parsedSpec.specHash },
				});

				return { success: true, toolCount: tools.length };
			} catch (error) {
				// Update status to error
				await updateOpenAPIService({
					id,
					userId: organizationId ? undefined : userId,
					organizationId: organizationId ?? undefined,
					data: { status: "ERROR" },
				});

				throw new ORPCError("BAD_REQUEST", {
					message: `Failed to sync: ${error instanceof Error ? error.message : "Unknown error"}`,
				});
			}
		}),
};
