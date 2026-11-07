import type { CodingRunActor } from "../lib/commands-access";
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

export const listCodingRunsInput = z.object({
	storyId: z.string().optional(),
	storyTaskId: z.string().optional(),
	organizationId: z.string().nullable().optional(),
});

export const listCodingRunsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/coding-runs",
		tags: ["CodingRuns"],
		summary: "List coding runs for a feature or task",
	})
	.input(listCodingRunsInput)
	.handler(async ({ input, context }) =>
		listCodingRunsCommand(
			{
				userId: context.user.id,
				organizationId: resolveOrganizationId(
					input.organizationId,
					context.session,
				),
			},
			input,
		),
	);

export async function listCodingRunsCommand(
	actor: CodingRunActor,
	input: z.infer<typeof listCodingRunsInput>,
) {
	const user = { id: actor.userId };
	const organizationId = actor.organizationId ?? undefined;

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
}
