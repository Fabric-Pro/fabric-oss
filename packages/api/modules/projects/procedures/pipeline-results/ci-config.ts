import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildCiConfigTemplate,
	CI_CONFIG_PROVIDERS,
} from "../../lib/ci-config-templates";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * Hand a team the CI configuration that makes its pipeline report back to
 * Fabric.
 *
 * Returns TEXT for a human to commit. Fabric deliberately does not write into a
 * customer's repository: that is their infrastructure, the change belongs in
 * their review process, and a tool that silently commits CI config is a tool
 * nobody can trust with a repo token.
 */
export const getCiConfigTemplateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa/ci-config",
		tags: ["Projects", "Test Cases"],
		summary:
			"Get CI configuration that reports test results back to Fabric",
	})
	.input(
		z.object({
			projectId: z.string(),
			provider: z.enum(CI_CONFIG_PROVIDERS),
			branch: z.string().max(255).nullable().optional(),
			testCommand: z.string().max(500).nullable().optional(),
			junitPath: z.string().max(500).nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		return buildCiConfigTemplate({
			provider: input.provider,
			branch: input.branch,
			testCommand: input.testCommand,
			junitPath: input.junitPath,
		});
	});
