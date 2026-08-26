/**
 * Sync Data Connection Procedures
 *
 * Start, stop, and get status of sync jobs.
 */

import { ORPCError } from "@orpc/client";
import {
	createSyncJob,
	db,
	getDataConnectionById,
	getSyncJobById,
	getSyncJobs,
	SyncJobTypeSchema,
	updateDataConnection,
	updateSyncJob,
} from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Start a sync job for a connection.
 */
const startSyncProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/sync",
		tags: ["DataConnections"],
		summary: "Start sync job",
		description: "Start a new sync job for a data connection",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			type: SyncJobTypeSchema.default("INCREMENTAL"),
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

		// Allow retries from ERROR and EXPIRED. Only block statuses that are not usable.
		if (
			connection.status !== "CONNECTED" &&
			connection.status !== "ERROR" &&
			connection.status !== "EXPIRED"
		) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: `Cannot sync - connection is ${connection.status}`,
			});
		}

		// Check if there's already a running sync
		const runningJobs = await getSyncJobs({
			connectionId: connection.id,
			status: "RUNNING",
			limit: 1,
		});

		if (runningJobs.length > 0) {
			throw new ORPCError("CONFLICT", {
				message: "A sync job is already running",
			});
		}

		// Create the sync job
		const workflowId = `data-sync-${connection.id}-${Date.now()}`;
		const syncJob = await createSyncJob({
			connectionId: connection.id,
			type: input.type as any,
			workflowId,
		});

		// Update connection status to SYNCING
		await updateDataConnection({
			id: connection.id,
			userId: user.id,
			organizationId,
			data: { status: "SYNCING" },
		});

		if (!(await isTemporalAvailable())) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Temporal is not available to run sync jobs",
			});
		}

		const connectionConfig =
			connection.config && typeof connection.config === "object"
				? (connection.config as Record<string, unknown>)
				: {};
		const workspaceIds = Array.isArray(connectionConfig.workspaceIds)
			? connectionConfig.workspaceIds.filter(
					(value): value is string => typeof value === "string",
				)
			: undefined;

		const client = await getTemporalClient();
		await client.workflow.start(
			"connectorSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId,
				args: [
					{
						syncJobId: syncJob.id,
						connectorId: connection.id,
						provider: connection.provider,
						syncType:
							input.type === "FULL"
								? "full"
								: input.type === "INCREMENTAL"
									? "incremental"
									: "gc",
						userId: user.id,
						organizationId: organizationId ?? undefined,
						workspaceIds,
					},
				],
			}),
		);

		return { syncJob, workflowId };
	});

/**
 * Get sync job status.
 */
const getSyncStatusProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
	.route({
		method: "GET",
		path: "/data-connections/:id/sync/status",
		tags: ["DataConnections"],
		summary: "Get sync status",
		description: "Get the status of sync jobs for a connection",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(50).default(10),
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

		const syncJobs = await getSyncJobs({
			connectionId: connection.id,
			limit: input.limit,
		});

		return { syncJobs };
	});

/**
 * Cancel a running sync job.
 */
const cancelSyncProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/sync/cancel",
		tags: ["DataConnections"],
		summary: "Cancel sync job",
		description: "Cancel a running sync job",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			jobId: z.string().optional(), // If not provided, cancel the latest running job
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

		// Find the job to cancel
		// biome-ignore lint/suspicious/noImplicitAnyLet: assigned from two different query functions with incompatible include shapes
		let jobToCancel;
		if (input.jobId) {
			jobToCancel = await getSyncJobById(input.jobId);
			if (jobToCancel && jobToCancel.connectionId !== connection.id) {
				throw new ORPCError("NOT_FOUND", {
					message: "Sync job not found",
				});
			}
		} else {
			const runningJobs = await getSyncJobs({
				connectionId: connection.id,
				status: "RUNNING",
				limit: 1,
			});
			jobToCancel = runningJobs[0];
		}

		if (!jobToCancel) {
			throw new ORPCError("NOT_FOUND", {
				message: "No running sync job found",
			});
		}

		if (
			jobToCancel.status !== "RUNNING" &&
			jobToCancel.status !== "PENDING"
		) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: `Cannot cancel - job is ${jobToCancel.status}`,
			});
		}

		// Update job status
		await updateSyncJob({
			id: jobToCancel.id,
			data: {
				status: "CANCELLED",
				completedAt: new Date(),
			},
		});

		// Update connection status back to CONNECTED
		await updateDataConnection({
			id: connection.id,
			userId: user.id,
			organizationId,
			data: { status: "CONNECTED" },
		});

		// TODO: Send cancel signal to Temporal workflow
		// const client = await getTemporalClient();
		// const handle = client.workflow.getHandle(jobToCancel.workflowId);
		// await handle.signal(cancelSyncSignal);

		return { success: true };
	});

/**
 * Clear all indexed/embedded content for a connection without deleting the connection itself.
 */
const clearIndexedDataProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/sync/clear",
		tags: ["DataConnections"],
		summary: "Clear indexed data",
		description:
			"Delete all synced resources and their embedded documents for a connection, keeping the connection itself",
	})
	.input(
		z.object({
			id: z.string(),
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

		// Get all synced resources with their document IDs
		const resources = await db.syncedResource.findMany({
			where: { connectionId: connection.id },
			select: { id: true, documentId: true },
		});

		const linkedDocumentIds = resources
			.map((r) => r.documentId)
			.filter((id): id is string => Boolean(id));

		// Also find orphaned documents at the connector's canonical s3Path prefix
		// (created by previous buggy syncs where documentId was never written back)
		const orphanedDocs = await db.workspaceDocument.findMany({
			where: {
				s3Bucket: "external-sync",
				s3Path: { startsWith: `data-connections/${connection.id}/` },
				...(linkedDocumentIds.length > 0
					? { id: { notIn: linkedDocumentIds } }
					: {}),
			},
			select: { id: true },
		});
		const orphanedDocumentIds = orphanedDocs.map((d) => d.id);

		const allDocumentIds = [...linkedDocumentIds, ...orphanedDocumentIds];

		// Delete chunks then documents (cascades Qdrant cleanup)
		if (allDocumentIds.length > 0) {
			await db.workspaceDocumentChunk.deleteMany({
				where: { documentId: { in: allDocumentIds } },
			});
			await db.workspaceDocument.deleteMany({
				where: { id: { in: allDocumentIds } },
			});
		}

		// Delete all synced resources for this connection
		await db.syncedResource.deleteMany({
			where: { connectionId: connection.id },
		});

		return {
			cleared: resources.length,
			documentsDeleted: linkedDocumentIds.length,
			orphansDeleted: orphanedDocumentIds.length,
		};
	});

/**
 * Delete orphaned WorkspaceDocuments for a connection — documents created by
 * previous syncs that were never linked back to a SyncedResource (due to the
 * now-fixed upsertSyncedResource bug where documentId was not saved on update).
 * Safe to run at any time; does not touch linked documents or SyncedResource rows.
 */
const purgeOrphanDocumentsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/sync/purge-orphans",
		tags: ["DataConnections"],
		summary: "Purge orphaned documents",
		description:
			"Delete WorkspaceDocuments created by previous syncs that are no longer linked to any SyncedResource",
	})
	.input(
		z.object({
			id: z.string(),
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

		// Get documentIds that ARE properly linked
		const linked = await db.syncedResource.findMany({
			where: { connectionId: connection.id, documentId: { not: null } },
			select: { documentId: true },
		});
		const linkedIds = linked
			.map((r) => r.documentId)
			.filter((id): id is string => Boolean(id));

		// Find connector-created documents at this connection's s3Path prefix
		// that are NOT referenced by any SyncedResource
		const orphans = await db.workspaceDocument.findMany({
			where: {
				s3Bucket: "external-sync",
				s3Path: { startsWith: `data-connections/${connection.id}/` },
				...(linkedIds.length > 0 ? { id: { notIn: linkedIds } } : {}),
			},
			select: { id: true },
		});

		if (orphans.length === 0) {
			return { deleted: 0 };
		}

		const orphanIds = orphans.map((d) => d.id);

		await db.workspaceDocumentChunk.deleteMany({
			where: { documentId: { in: orphanIds } },
		});
		await db.workspaceDocument.deleteMany({
			where: { id: { in: orphanIds } },
		});

		return { deleted: orphanIds.length };
	});

export const syncProcedures = {
	start: startSyncProcedure,
	status: getSyncStatusProcedure,
	cancel: cancelSyncProcedure,
	clearIndexedData: clearIndexedDataProcedure,
	purgeOrphans: purgeOrphanDocumentsProcedure,
};
