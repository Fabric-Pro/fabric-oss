/**
 * Synced Resources Procedures
 *
 * List and manage synced resources from external connections.
 */

import { ORPCError } from "@orpc/client";
import {
	db,
	getDataConnectionById,
	getSyncedResources,
	ResourceSyncStatusSchema,
	upsertSyncedResource,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * List synced resources for a connection.
 */
const listResourcesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
	.route({
		method: "GET",
		path: "/data-connections/:id/resources",
		tags: ["DataConnections"],
		summary: "List synced resources",
		description: "List synced resources for a data connection",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			syncStatus: ResourceSyncStatusSchema.optional(),
			limit: z.number().min(1).max(100).default(50),
			offset: z.number().min(0).default(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify connection exists and belongs to tenant
		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		const resources = await getSyncedResources({
			connectionId: connection.id,
			syncStatus: input.syncStatus as any,
			limit: input.limit,
			offset: input.offset,
		});

		return { resources };
	});

/**
 * Exclude a resource from syncing.
 */
const excludeResourceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/resources/:externalId/exclude",
		tags: ["DataConnections"],
		summary: "Exclude resource from sync",
		description: "Mark a resource as excluded from future syncs",
	})
	.input(
		z.object({
			id: z.string(),
			externalId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify connection exists and belongs to tenant
		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		// Update only syncStatus — preserve existing title/resourceType if record exists
		const resource = await upsertSyncedResource({
			connectionId: connection.id,
			externalId: input.externalId,
			data: {
				syncStatus: "EXCLUDED",
			},
		});

		return { resource };
	});

/**
 * Re-include a previously excluded resource.
 */
const includeResourceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/resources/:externalId/include",
		tags: ["DataConnections"],
		summary: "Re-include resource in sync",
		description: "Mark a previously excluded resource to be synced again",
	})
	.input(
		z.object({
			id: z.string(),
			externalId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify connection exists and belongs to tenant
		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		// Update only syncStatus — preserve existing title/resourceType if record exists
		const resource = await upsertSyncedResource({
			connectionId: connection.id,
			externalId: input.externalId,
			data: {
				syncStatus: "PENDING",
			},
		});

		return { resource };
	});

/**
 * Get the extracted text content of a synced resource.
 */
const getResourceContentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
	.route({
		method: "GET",
		path: "/data-connections/:id/resources/:resourceId/content",
		tags: ["DataConnections"],
		summary: "Get resource content",
		description: "Get the extracted text content of a synced resource",
	})
	.input(
		z.object({
			id: z.string(),
			resourceId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		const resource = await db.syncedResource.findFirst({
			where: { id: input.resourceId, connectionId: connection.id },
			include: {
				document: {
					select: {
						id: true,
						filename: true,
						extractedText: true,
						wordCount: true,
						pageCount: true,
					},
				},
			},
		});

		if (!resource) {
			throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
		}

		const meta = resource.metadata as Record<string, unknown> | null;

		return {
			id: resource.id,
			title: resource.title,
			externalId: resource.externalId,
			resourceType: resource.resourceType,
			extractedText: resource.document?.extractedText ?? null,
			wordCount: resource.document?.wordCount ?? null,
			pageCount: resource.document?.pageCount ?? null,
			// Metadata for when no document is linked
			url: typeof meta?.url === "string" ? meta.url : null,
			repository:
				typeof meta?.repository === "string" ? meta.repository : null,
			author: typeof meta?.author === "string" ? meta.author : null,
			labels: Array.isArray(meta?.labels)
				? (meta.labels as string[])
				: [],
			contentPreview:
				typeof meta?.contentPreview === "string"
					? meta.contentPreview
					: null,
		};
	});

export const resourcesProcedures = {
	list: listResourcesProcedure,
	exclude: excludeResourceProcedure,
	include: includeResourceProcedure,
	getContent: getResourceContentProcedure,
};
