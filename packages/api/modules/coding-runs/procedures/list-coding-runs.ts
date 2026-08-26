/**
 * List Coding Runs Procedure
 *
 * AUTHORIZATION: Tenant-isolated via XOR pattern
 */

import { listCodingRunsForStory, listCodingRunsForTask } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listCodingRunsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/coding-runs",
		tags: ["CodingRuns"],
		summary: "List coding runs for a feature or task",
	})
	.input(
		z.object({
			storyId: z.string().optional(),
			storyTaskId: z.string().optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (input.storyTaskId) {
			return listCodingRunsForTask(
				input.storyTaskId,
				user.id,
				organizationId,
			);
		}

		if (input.storyId) {
			return listCodingRunsForStory(
				input.storyId,
				user.id,
				organizationId,
			);
		}

		return [];
	});
