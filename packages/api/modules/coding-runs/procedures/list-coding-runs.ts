/**
 * List Coding Runs Procedure
 *
 * AUTHORIZATION: Tenant scope, project visibility, and private/team runtime projection
 */

import { listCodingRunsForStory, listCodingRunsForTask } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { publicCodingRuns } from "../lib/public-run";

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
			return publicCodingRuns(
				await listCodingRunsForTask(
					input.storyTaskId,
					user.id,
					organizationId,
				),
				user.id,
			);
		}

		if (input.storyId) {
			return publicCodingRuns(
				await listCodingRunsForStory(
					input.storyId,
					user.id,
					organizationId,
				),
				user.id,
			);
		}

		return [];
	});
