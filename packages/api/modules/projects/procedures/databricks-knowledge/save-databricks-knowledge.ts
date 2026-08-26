/**
 * Create or update the project's Databricks Vector Search knowledge binding
 * (read-only, one binding per project).
 *
 * The integration is validated inside the same transaction as the upsert —
 * it must exist in the PROJECT's tenant, be active, and be a
 * DATABRICKS_VECTOR_SEARCH row (see saveProjectDatabricksKnowledgeBinding).
 * RLS and the permission middleware validate the project, not the
 * integration, so this write-time check is what stops binding e.g. a
 * personal integration to an org project (a silent runtime no-op for every
 * org member).
 */

import { ORPCError } from "@orpc/client";
import {
	db,
	InvalidDatabricksKnowledgeIntegrationError,
	saveProjectDatabricksKnowledgeBinding,
} from "@repo/database";
import { MAX_QUERY_INDEXES } from "@repo/integrations/databricks-vector-search/constants";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const saveProjectDatabricksKnowledgeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/:projectId/databricks-knowledge",
		tags: ["Projects", "Knowledge"],
		summary: "Save Databricks knowledge binding",
		description:
			"Bind the project to a Databricks Vector Search integration and a set of its indexes (read-only)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			integrationId: z.string().min(1),
			schema: z.string().min(1),
			indexes: z
				.array(z.string().min(1))
				.min(1)
				.max(
					MAX_QUERY_INDEXES,
					`A maximum of ${MAX_QUERY_INDEXES} indexes can be selected`,
				),
		}),
	)
	.handler(async ({ input, context }) => {
		// Authorization is the requireProjectPermission middleware ALONE — it
		// resolves effective permissions including org admins/owners who have
		// no explicit ProjectMember row on this project. Do NOT re-check with
		// the legacy hasProjectAccess helper: it doesn't recognize the
		// org-role path and would deny exactly those admins. Tenant safety of
		// the write does not depend on caller input either — the save
		// transaction validates the integration against the PROJECT row's own
		// tenant.
		const user = context.user;

		let binding: Awaited<
			ReturnType<typeof saveProjectDatabricksKnowledgeBinding>
		>;
		try {
			binding = await saveProjectDatabricksKnowledgeBinding({
				projectId: input.projectId,
				integrationId: input.integrationId,
				schema: input.schema,
				indexNames: input.indexes,
				createdBy: user.id,
			});
		} catch (error) {
			if (error instanceof InvalidDatabricksKnowledgeIntegrationError) {
				throw new ORPCError("BAD_REQUEST", { message: error.message });
			}
			throw error;
		}

		// Record the OWNING organization (resolved from the project row, not
		// caller input) on the audit event — same convention as the QA audit
		// events (#2340). `recordAuditFromRequest` also captures IP,
		// user-agent, session, actor snapshot, timing and correlation id.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});

		recordAuditFromRequest(context, {
			action: "project.databricks_knowledge.connected",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			organizationId: project?.organizationId ?? null,
			resource: {
				type: "project_databricks_knowledge_binding",
				id: binding.id,
			},
			metadata: {
				integrationId: input.integrationId,
				schema: input.schema,
				indexCount: input.indexes.length,
			},
		});

		return { binding };
	});
