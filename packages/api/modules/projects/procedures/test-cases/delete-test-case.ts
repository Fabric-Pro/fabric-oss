import { ORPCError } from "@orpc/client";
import { softDeleteTestCase } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { removeTestCaseContext } from "../../lib/test-case-context";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const deleteTestCaseProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/test-cases/{testCaseId}",
		tags: ["Projects", "Test Cases"],
		summary: "Delete a test case",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_DELETE) gates project
		// access.
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const removed = await softDeleteTestCase({
			id: input.testCaseId,
			projectId: input.projectId,
		});
		if (!removed) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		// Tear down the mirrored RAG context so a deleted case stops surfacing to
		// the AI (AC7). Best-effort — never blocks the delete.
		if (removed.contextId) {
			await removeTestCaseContext({
				contextId: removed.contextId,
				projectId: input.projectId,
				userId: user.id,
				organizationId,
			});
		}

		return { success: true };
	});
