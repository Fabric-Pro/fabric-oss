/**
 * Get Instance Versions Procedure
 *
 * Returns all versions of an agent template instance, ordered by version descending.
 * Uses the stable sId to look up all versions across the history.
 *
 * AUTHORIZATION: Tenant-isolated — user must own the instance (XOR pattern)
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const VersionItemSchema = z.object({
	id: z.string(),
	sId: z.string(),
	version: z.number(),
	status: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	modelOverride: z.string().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

/**
 * AUTHORIZATION: Uses XOR tenant pattern — verifies userId + organizationId ownership
 */
export const getInstanceVersions = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/instances/versions",
		tags: ["Agent Instances"],
		summary: "Get instance version history",
		description:
			"Returns all versions of an agent template instance identified by its stable sId, ordered by version descending.",
	})
	.input(
		z.object({
			instanceSId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.array(VersionItemSchema))
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

		// Verify the user has access to at least one version with this sId
		const accessCheck = await db.agentTemplateInstance.findFirst({
			where: {
				sId: input.instanceSId,
				...tenantFilter,
			},
			select: { id: true },
		});

		if (!accessCheck) {
			throw new ORPCError("NOT_FOUND", {
				message: "Instance not found or access denied",
			});
		}

		// Fetch all versions with the same sId
		const versions = await db.agentTemplateInstance.findMany({
			where: {
				sId: input.instanceSId,
				...tenantFilter,
			},
			orderBy: { version: "desc" },
			select: {
				id: true,
				sId: true,
				version: true,
				status: true,
				name: true,
				description: true,
				modelOverride: true,
				createdAt: true,
				updatedAt: true,
			},
		});

		return versions;
	});
