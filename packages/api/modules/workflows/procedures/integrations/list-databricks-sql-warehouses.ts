import { ORPCError } from "@orpc/server";
import {
	fetchCredentialsByIdAndProviderInTenant,
	listWorkflowIntegrationsInTenant,
} from "@repo/database";
import { listDatabricksSqlWarehouses } from "@repo/integrations";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listDatabricksSqlWarehousesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/workflows/integrations/databricks-sql/warehouses",
		tags: ["Workflows", "Integrations"],
		summary: "List existing Databricks SQL warehouses",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			integrationId: z.string().min(1).max(128),
		}),
	)
	.output(
		z.object({
			warehouses: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					state: z.string(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const credentials = await fetchCredentialsByIdAndProviderInTenant(
			input.integrationId,
			"DATABRICKS_SQL",
			context.user.id,
			organizationId,
		);
		if (!credentials)
			throw new ORPCError("NOT_FOUND", {
				message: "Databricks SQL connection not found or access denied",
			});
		try {
			return {
				warehouses: await listDatabricksSqlWarehouses(credentials),
			};
		} catch {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Could not load warehouses. Check this connection's Databricks permissions.",
			});
		}
	});

export const listDatabricksSqlConnectionsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/workflows/integrations/databricks-sql/connections",
		tags: ["Workflows", "Integrations"],
		summary: "List authorized Databricks SQL connections",
	})
	.input(z.object({ organizationId: z.string().nullable().optional() }))
	.output(
		z.object({
			connections: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					shared: z.boolean(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId)
			throw new ORPCError("FORBIDDEN", {
				message: "An organization is required",
			});
		const rows = await listWorkflowIntegrationsInTenant({
			userId: context.user.id,
			organizationId,
			provider: "DATABRICKS_SQL",
		});
		return {
			connections: rows.map((row) => ({
				id: row.id,
				name: row.name,
				shared: row.userId !== context.user.id,
			})),
		};
	});
