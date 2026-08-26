/**
 * The coverage index behind the richer traceability matrix.
 *
 * Reading is one procedure; setting a case's pyramid level is the other. The
 * level is the only part of the index a person supplies — everything else is
 * derived from rows that already exist.
 */

import { ORPCError } from "@orpc/client";
import { getCoverageIndexForStory } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

const COVERAGE_TYPES = ["UNIT", "INTEGRATION", "E2E", "MANUAL"] as const;

export const getCoverageIndexProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/features/{storyId}/coverage-index",
		tags: ["Projects", "Test Cases"],
		summary: "Per-case coverage detail for a feature's traceability matrix",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates the project.
		// The feature read is scoped by projectId, so an id from another project
		// resolves to NOT_FOUND rather than leaking across the boundary.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: {
				title: true,
				description: true,
				acceptanceCriteria: true,
			},
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}
		return getCoverageIndexForStory({
			projectId: input.projectId,
			storyId: input.storyId,
			story,
		});
	});

export const setTestCaseCoverageTypeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/coverage-type",
		tags: ["Projects", "Test Cases"],
		summary: "Set which level of the test pyramid a case sits at",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			// Nullable: clearing it back to "nobody has said" must stay possible.
			// Forcing a choice would push people to pick one at random, which is
			// how a coverage report fills up with confidently wrong values.
			coverageType: z.enum(COVERAGE_TYPES).nullable(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: TEST_CASE_UPDATE. projectId in the WHERE is the tenant
		// guard — an id from another project matches nothing rather than being
		// written across the boundary.
		const { count } = await db.testCase.updateMany({
			where: {
				id: input.testCaseId,
				projectId: input.projectId,
				deletedAt: null,
			},
			data: { coverageType: input.coverageType },
		});
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}
		return { coverageType: input.coverageType };
	});
