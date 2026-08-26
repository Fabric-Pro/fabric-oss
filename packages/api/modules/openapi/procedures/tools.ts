/**
 * OpenAPI Tool Management Procedures
 *
 * Handles listing, enabling/disabling, and testing individual tools.
 */

import { ORPCError } from "@orpc/server";
import {
	getActiveOpenAPIServicesWithTools,
	getOpenAPIServiceById,
	getOpenAPIToolById,
	recordToolUsage,
	setOpenAPIToolEnabled,
} from "@repo/database";
import { createOpenAPIAgentTool, toLangChainTool } from "@repo/openapi-tools";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const toolsProcedures = {
	/**
	 * List tools for a service
	 */
	listForService: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_READ))
		.route({
			method: "GET",
			path: "/openapi/services/:serviceId/tools",
			tags: ["OpenAPI"],
			summary: "List tools for a service",
		})
		.input(
			z.object({
				serviceId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { serviceId, organizationId } = input;

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

			// Verify access to the service
			const service = await getOpenAPIServiceById({
				id: serviceId,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
			});

			if (!service) {
				throw new ORPCError("NOT_FOUND", {
					message: "OpenAPI service not found",
				});
			}

			return service.tools;
		}),

	/**
	 * Toggle tool enabled status
	 */
	setEnabled: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_MANAGE))
		.route({
			method: "PATCH",
			path: "/openapi/tools/:id/enabled",
			tags: ["OpenAPI"],
			summary: "Enable or disable a tool",
		})
		.input(
			z.object({
				id: z.string(),
				enabled: z.boolean(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { id, enabled, organizationId } = input;

			// Get tool to verify ownership
			const tool = await getOpenAPIToolById(id);
			if (!tool) {
				throw new ORPCError("NOT_FOUND", { message: "Tool not found" });
			}

			// Verify access to the service
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

			// TENANT ISOLATION (SOC 2 CC6.1/CC6.3): the tool is loaded by id
			// alone; bind it to a service the caller can actually reach. The
			// service lookup is tenant-scoped, so a null result means the tool
			// belongs to another tenant — the previous code discarded this
			// result and toggled the tool regardless (cross-tenant write).
			const service = await getOpenAPIServiceById({
				id: tool.serviceId,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
			});
			if (!service) {
				throw new ORPCError("NOT_FOUND", { message: "Tool not found" });
			}

			return await setOpenAPIToolEnabled({ id, enabled });
		}),

	/**
	 * Test a tool execution
	 */
	test: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_READ))
		.route({
			method: "POST",
			path: "/openapi/tools/:id/test",
			tags: ["OpenAPI"],
			summary: "Test a tool execution",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
				arguments: z.record(z.string(), z.unknown()).default({}),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { id, organizationId, arguments: args } = input;

			// Get tool
			const tool = await getOpenAPIToolById(id);
			if (!tool) {
				throw new ORPCError("NOT_FOUND", { message: "Tool not found" });
			}

			// Verify access
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
				id: tool.serviceId,
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
			});

			if (!service) {
				throw new ORPCError("NOT_FOUND", {
					message: "Service not found",
				});
			}

			// Build execution config
			const { executeOpenAPITool } = await import("@repo/openapi-tools");
			const config = {
				baseUrl: service.baseUrl || "",
				authType: service.authType,
				authLocation: service.authLocation,
				authKey: service.authKey,
				authValue: service.encryptedAuthValue
					? decryptApiKey(service.encryptedAuthValue)
					: null,
			};

			if (!config.baseUrl) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Service has no base URL configured",
				});
			}

			// Execute the tool
			const result = await executeOpenAPITool({
				tool: {
					operationId: tool.operationId,
					name: tool.name,
					description: tool.description,
					method: tool.method,
					path: tool.path,
					parametersSchema: tool.parametersSchema as Record<
						string,
						unknown
					> | null,
					requestBodySchema: tool.requestBodySchema as Record<
						string,
						unknown
					> | null,
					responseSchema: tool.responseSchema as Record<
						string,
						unknown
					> | null,
					pathParams: [],
					queryParams: [],
					headerParams: [],
					deprecated: tool.deprecated,
					tags: tool.tags,
				},
				config,
				arguments: args,
			});

			// Record usage statistics
			await recordToolUsage({
				id,
				responseTime: result.responseTime,
				success: result.success,
			});

			return result;
		}),

	/**
	 * Load OpenAPI tools for agent runtime
	 * Returns tools in LangChain-compatible format
	 */
	loadForAgent: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_OPENAPI_READ))
		.route({
			method: "POST",
			path: "/openapi/tools/load",
			tags: ["OpenAPI"],
			summary: "Load OpenAPI tools for agent runtime",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
				serviceIds: z.array(z.string()).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { organizationId, serviceIds } = input;

			// Verify organization membership if specified
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

			// Get active services with enabled tools
			const services = await getActiveOpenAPIServicesWithTools({
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? undefined,
				serviceIds,
			});

			const tools: Array<{
				type: "function";
				function: {
					name: string;
					description: string;
					parameters: Record<string, unknown>;
				};
				serviceId: string;
				serviceName: string;
				toolId: string;
			}> = [];

			const errors: Array<{
				serviceId: string;
				serviceName: string;
				error: string;
			}> = [];

			for (const service of services) {
				try {
					// Decrypt auth value if present
					const authValue = service.encryptedAuthValue
						? decryptApiKey(service.encryptedAuthValue)
						: null;

					for (const tool of service.tools) {
						const agentTool = createOpenAPIAgentTool(
							{
								id: tool.id,
								name: tool.name,
								description: tool.description,
								method: tool.method,
								path: tool.path,
								operationId: tool.operationId,
								parametersSchema: tool.parametersSchema,
								requestBodySchema: tool.requestBodySchema,
								responseSchema: tool.responseSchema,
								tags: tool.tags,
							},
							{
								baseUrl: service.baseUrl || "",
								authType: service.authType,
								authKey: service.authKey,
								authValue,
								authLocation: service.authLocation,
							},
						);

						tools.push({
							...toLangChainTool(agentTool),
							serviceId: service.id,
							serviceName: service.name,
							toolId: tool.id,
						});
					}
				} catch (error) {
					errors.push({
						serviceId: service.id,
						serviceName: service.name,
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
					});
				}
			}

			return { tools, errors };
		}),
};
