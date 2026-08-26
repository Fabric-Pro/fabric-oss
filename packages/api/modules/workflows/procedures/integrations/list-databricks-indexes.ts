/**
 * List Databricks Vector Search Indexes
 *
 * Lists available Databricks Vector Search indexes grouped by Unity Catalog
 * schema, for agent knowledge binding pickers in the agent-builder UI.
 *
 * Prerequisites:
 * - User must have connected Databricks Vector Search (DATABRICKS_VECTOR_SEARCH provider)
 */

import { ORPCError } from "@orpc/client";
import {
	db,
	fetchCredentialsByIdInTenant,
	getWorkflowIntegrationByIdInTenant,
} from "@repo/database";
import { listDatabricksVectorIndexes } from "@repo/integrations/databricks-vector-search";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

const SchemaGroupSchema = z.object({
	schema: z.string(),
	indexes: z.array(z.object({ name: z.string(), endpointName: z.string() })),
});

export const listDatabricksIndexesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/integrations/databricks/indexes",
		tags: ["Workflows", "Integrations", "Databricks"],
		summary: "List Databricks vector search indexes",
		description:
			"List vector search indexes grouped by Unity Catalog schema for agent knowledge binding",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			/**
			 * When provided, resolve discovery against this exact
			 * WorkflowIntegration row instead of the org-wide "first active
			 * Databricks connection" lookup. Used by the agent-builder edit
			 * and duplicate flows so re-running discovery can't silently
			 * rebind an agent to a different Databricks workspace when the
			 * tenant has more than one active connection.
			 */
			integrationId: z.string().optional(),
		}),
	)
	.output(
		z.object({
			isConnected: z.boolean(),
			schemas: z.array(SchemaGroupSchema),
			error: z.string().optional(),
			integrationId: z.string().optional(),
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

		let integration: { id: string } | null;
		if (input.integrationId) {
			// Pinned mode: resolve the exact row bound to the agent instead of
			// re-discovering "whichever active Databricks connection comes
			// first" — a tenant may have more than one.
			const pinned = await getWorkflowIntegrationByIdInTenant(
				input.integrationId,
				user.id,
				organizationId ?? undefined,
			);
			if (!pinned || !pinned.isActive) {
				return {
					isConnected: false,
					schemas: [],
					error: "The Databricks connection bound to this agent is no longer available. Reconnect it in Settings > Integrations.",
				};
			}
			integration = { id: pinned.id };
		} else {
			integration = await db.workflowIntegration.findFirst({
				where: {
					provider: "DATABRICKS_VECTOR_SEARCH",
					isActive: true,
					...(organizationId
						? { organizationId }
						: { userId: user.id, organizationId: null }),
				},
				select: { id: true },
			});
		}
		if (!integration) {
			return {
				isConnected: false,
				schemas: [],
				error: "Databricks Vector Search is not connected. Configure it in Settings > Integrations.",
			};
		}

		try {
			const credentials = await fetchCredentialsByIdInTenant(
				integration.id,
				user.id,
				organizationId ?? undefined,
			);
			const indexes = await listDatabricksVectorIndexes(
				credentials ?? {},
			);
			const bySchema = new Map<
				string,
				Array<{ name: string; endpointName: string }>
			>();
			for (const index of indexes) {
				const list = bySchema.get(index.schema) ?? [];
				list.push({
					name: index.name,
					endpointName: index.endpointName,
				});
				bySchema.set(index.schema, list);
			}
			return {
				isConnected: true,
				integrationId: integration.id,
				schemas: [...bySchema.entries()]
					.map(([schema, schemaIndexes]) => ({
						schema,
						indexes: schemaIndexes,
					}))
					.sort((a, b) => a.schema.localeCompare(b.schema)),
			};
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to list Databricks indexes: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			});
		}
	});
