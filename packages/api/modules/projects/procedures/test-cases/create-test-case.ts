import { ORPCError } from "@orpc/client";
import { createTestCase, db, TEST_CASE_STATES } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";
import { automationInputFields } from "./automation-input";
import { mirrorTestCaseToContext } from "./sync-context";

const stepInputSchema = z.object({
	action: z.string(),
	expected: z.string(),
});

const workItemLinkInputSchema = z.object({
	userStoryId: z.string(),
	acceptanceCriterionRefs: z.array(z.string()).optional(),
});

export const createTestCaseProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases",
		tags: ["Projects", "Test Cases"],
		summary: "Create a test case",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(500),
			description: z.string().nullable().optional(),
			state: z.enum(TEST_CASE_STATES).optional(),
			priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
			ownerId: z.string().nullable().optional(),
			tags: z.array(z.string()).max(50).optional(),
			automationStatus: z
				.enum(["NOT_AUTOMATED", "PLANNED", "AUTOMATED"])
				.optional(),
			...automationInputFields,
			steps: z.array(stepInputSchema).max(200).optional(),
			workItemLinks: z.array(workItemLinkInputSchema).max(100).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_CREATE) gates project
		// access — only callers with create rights on this project reach here.
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Any work items linked at creation must belong to this project — a
		// cross-project story id would otherwise tie a case to a foreign tenant.
		if (input.workItemLinks && input.workItemLinks.length > 0) {
			await assertStoriesInProject(
				input.projectId,
				input.workItemLinks.map((l) => l.userStoryId),
			);
		}

		const testCase = await createTestCase({
			projectId: input.projectId,
			createdById: user.id,
			title: input.title,
			description: input.description ?? null,
			state: input.state,
			priority: input.priority,
			ownerId: input.ownerId ?? null,
			tags: input.tags,
			// The query layer owns the automation-link rules (blank→null, and a
			// non-empty ref implying AUTOMATED) so they hold for every caller.
			automationStatus: input.automationStatus,
			automationRef: input.automationRef,
			automationFilePath: input.automationFilePath,
			automationExternalUrl: input.automationExternalUrl,
			steps: input.steps,
			workItemLinks: input.workItemLinks?.map((l) => ({
				userStoryId: l.userStoryId,
				acceptanceCriterionRefs: l.acceptanceCriterionRefs ?? [],
			})),
			userId: user.id,
			organizationId,
		});

		// RAG mirror (AC7) — best-effort, never blocks the create.
		await mirrorTestCaseToContext(testCase, {
			userId: user.id,
			organizationId,
		});

		return { testCase };
	});

/**
 * Throw NOT_FOUND if any of `storyIds` is not a live story in `projectId`.
 * Distinct ids only; a missing id (wrong project, deleted, or fabricated) fails
 * the whole request rather than silently linking a foreign work item.
 */
async function assertStoriesInProject(
	projectId: string,
	storyIds: string[],
): Promise<void> {
	const distinct = [...new Set(storyIds)];
	const found = await db.userStory.findMany({
		where: { id: { in: distinct }, projectId },
		select: { id: true },
	});
	if (found.length !== distinct.length) {
		throw new ORPCError("NOT_FOUND", {
			message:
				"One or more linked work items were not found in this project",
		});
	}
}
