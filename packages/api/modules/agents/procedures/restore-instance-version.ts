/**
 * Restore Instance Version Procedure
 *
 * Restores an archived version of an agent template instance by creating a new
 * version that is a copy of the archived one. The archived version remains in
 * history; a new ACTIVE version is created.
 *
 * AUTHORIZATION: Tenant-isolated — user must own the instance (XOR pattern)
 */

import { ORPCError } from "@orpc/server";
import { db, restoreInstanceVersion } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses XOR tenant pattern — verifies userId + organizationId ownership
 */
export const restoreInstanceVersionProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_EXECUTE))
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
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// XOR PATTERN: Strict tenant isolation
		const tenantFilter = organizationId
			? { organizationId }
			: { userId: user.id, organizationId: null };

		// Verify the user has access to this specific instance version
		const instance = await db.agentTemplateInstance.findFirst({
			where: {
				id: input.instanceId,
				...tenantFilter,
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
