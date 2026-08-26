import { ORPCError } from "@orpc/client";
import {
	getTestCase,
	getTestCaseScriptRevision,
	listTestCaseAgentRunSources,
	listTestCaseScriptRevisions,
	updateTestCase,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

async function requireTestCase(projectId: string, testCaseId: string) {
	const testCase = await getTestCase({ id: testCaseId, projectId });
	if (!testCase) {
		throw new ORPCError("NOT_FOUND", { message: "Test case not found" });
	}
	return testCase;
}

const scopedCaseInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	testCaseId: z.string(),
});

export const listPlaywrightScriptSourcesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/{testCaseId}/playwright-script/sources",
		tags: ["Projects", "Test Cases"],
		summary: "List historical agent runs usable for script generation",
	})
	.input(
		scopedCaseInput.extend({
			limit: z.number().int().min(1).max(100).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		await requireTestCase(input.projectId, input.testCaseId);
		return listTestCaseAgentRunSources({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			limit: input.limit,
			offset: input.offset,
		});
	});

export const listPlaywrightScriptRevisionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/{testCaseId}/playwright-script/revisions",
		tags: ["Projects", "Test Cases"],
		summary: "List Playwright script revision history",
	})
	.input(
		scopedCaseInput.extend({
			limit: z.number().int().min(1).max(100).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		await requireTestCase(input.projectId, input.testCaseId);
		return listTestCaseScriptRevisions({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			limit: input.limit,
			offset: input.offset,
		});
	});

export const getPlaywrightScriptRevisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/{testCaseId}/playwright-script/revisions/{revisionId}",
		tags: ["Projects", "Test Cases"],
		summary: "Get one Playwright script revision",
	})
	.input(scopedCaseInput.extend({ revisionId: z.string() }))
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		const revision = await getTestCaseScriptRevision({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			revisionId: input.revisionId,
		});
		if (!revision) {
			throw new ORPCError("NOT_FOUND", {
				message: "Script revision not found",
			});
		}
		return { revision };
	});

export const restorePlaywrightScriptRevisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/playwright-script/revisions/{revisionId}/restore",
		tags: ["Projects", "Test Cases"],
		summary: "Restore a prior Playwright script revision",
	})
	.input(scopedCaseInput.extend({ revisionId: z.string() }))
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		const revision = await getTestCaseScriptRevision({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			revisionId: input.revisionId,
		});
		if (!revision) {
			throw new ORPCError("NOT_FOUND", {
				message: "Script revision not found",
			});
		}
		const testCase = await updateTestCase({
			id: input.testCaseId,
			projectId: input.projectId,
			actorUserId: context.user.id,
			data: {
				playwrightScript: revision.script,
				automationStatus: "AUTOMATED",
			},
			scriptRevision: {
				origin: "REVERT",
				restoredFromRevisionId: revision.id,
			},
		});
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}
		return { script: testCase.playwrightScript ?? "" };
	});
