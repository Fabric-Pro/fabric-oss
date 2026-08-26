import { getProjectRepositoryPipelineSyncHealth } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * Per-connected-repository pipeline sync health, keyed by
 * `ProjectRepositoryIntegration.id` — for the Settings ▸ Development page
 * (card #2383's follow-through).
 *
 * Distinct from `listPipelineSyncStatesProcedure` (`syncStates`): that one is
 * keyed by `(provider, pipelineKey)` for the QA tab's freshness banner, which
 * already speaks that language. This one is joined to the repository
 * integration ROW so a settings page that lists repositories, not sync
 * sources, can attach each repo's sync health directly — and so the
 * "Reconnect" link the QA-tab banner offers doesn't land on a page that still
 * renders the same repo as healthy (`SyncFailureBanner.tsx`'s module doc).
 *
 * Same permission as `syncStates` (`TEST_CASE_READ`): it is granted starting
 * at the SAME role tier as `PROJECT_SETTINGS_READ` (viewer, both org- and
 * project-level — see `packages/permissions/lib/roles.ts`), so reusing it
 * here gates no more and no less than the settings page itself already does.
 */
export const getProjectRepositoryPipelineSyncHealthProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.TEST_CASE_READ))
		.route({
			method: "GET",
			path: "/projects/{projectId}/pipeline-results/sync-health",
			tags: ["Projects", "Test Cases"],
			summary: "Get per-repository pipeline sync health for a project",
		})
		.input(
			z.object({
				projectId: z.string(),
			}),
		)
		.handler(async ({ input }) => {
			assertPipelineResultsEnabled();
			return getProjectRepositoryPipelineSyncHealth({
				projectId: input.projectId,
			});
		});
