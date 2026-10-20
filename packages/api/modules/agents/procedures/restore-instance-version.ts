/**
 * Restore Instance Version Procedure
 *
 * Restores an archived version of an agent template instance by creating a new
 * version that is a copy of the archived one. The archived version remains in
 * history; a new ACTIVE version is created.
 *
 * AUTHORIZATION: requires an organization; any member whose role there holds
 * AGENT_TEMPLATE_MANAGE can restore an instance of that organization.
 */

import { ORPCError } from "@orpc/server";
import { db, restoreInstanceVersion } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolvedOrganizationId } from "./conversations/resolved-organization";

/**
 * AUTHORIZATION: Refuses a request that resolves no organization and checks
 * membership and AGENT_TEMPLATE_MANAGE there before the tenant-scoped instance lookup.
 */
export const restoreInstanceVersionProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_TEMPLATE_MANAGE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/agents/instances/restore",
		tags: ["Agent Instances"],
		summary: "Restore an archived instance version",
		description:
			"Creates a new active version of an agent instance as a copy of the specified archived version.",
	})
	.input(
		z.object({
			instanceId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			id: z.string(),
			sId: z.string(),
			version: z.number(),
			status: z.string(),
			name: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolvedOrganizationId(input, context.session);

		// Verify the instance belongs to the authorized organization
		const instance = await db.agentTemplateInstance.findFirst({
			where: {
				id: input.instanceId,
				organizationId,
			},
			select: { id: true, status: true, sId: true },
		});

		if (!instance) {
			throw new ORPCError("NOT_FOUND", {
				message: "Instance not found or access denied",
			});
		}

		if (instance.status !== "ARCHIVED") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only archived versions can be restored",
			});
		}

		try {
			const restored = await restoreInstanceVersion(input.instanceId);
			return {
				id: restored.id,
				sId: restored.sId,
				version: restored.version,
				status: restored.status,
				name: restored.name,
			};
		} catch (_error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to restore instance version",
			});
		}
	});
