/**
 * List Azure DevOps Repositories (Grouped by ADO Project)
 *
 * PAT-based discovery. Unlike `github/list-repos.ts` and
 * `gitlab/list-projects.ts` (which read user-scoped OAuth tokens), this takes
 * the PAT + organization the user just entered in the wizard picker, validates
 * it, and lists the repos grouped by ADO project.
 *
 * SECURITY: the PAT is request-scoped — it is NEVER persisted by this procedure
 * and NEVER logged. Persistence happens only via `repositoryIntegrations.connect`.
 *
 * AUTHORIZATION: tenantProtectedProcedure + INTEGRATION_READ (matches
 * listGitHubReposProcedure and listGitLabProjectsProcedure).
 */

import { ORPCError } from "@orpc/client";
import {
	listAzureDevOpsProjectsAndRepos,
	validateAzureDevOpsPat,
} from "@repo/connectors";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listAzureDevOpsReposProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/projects/azure-devops/repos",
		tags: ["Projects", "Azure DevOps"],
		summary: "List Azure DevOps repositories, grouped by project",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			/** The PAT the user typed in the picker (request-scoped, never stored here). */
			pat: z.string().min(1),
			/** Org name parsed/confirmed from the URL or entered directly. */
			azureOrganization: z.string().min(1),
			/** Tenancy/telemetry scoping (parity with peers). */
			projectId: z.string().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// Validate the PAT first so auth failures map to a precise BAD_REQUEST
		// (the picker renders this inline + offers a retry). The connectors
		// helper centralizes the ADO REST call; this handler stays thin.
		const validation = await validateAzureDevOpsPat({
			organization: input.azureOrganization,
			pat: input.pat,
		});

		if (!validation.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					validation.status === 401 || validation.status === 403
						? "Invalid PAT or insufficient permissions"
						: `Azure DevOps returned status ${validation.status}`,
			});
		}

		// Happy path + "no repos found" (the latter returns
		// `{ configured: true, groups: [], error }` — never a throw).
		return await listAzureDevOpsProjectsAndRepos({
			organization: input.azureOrganization,
			pat: input.pat,
		});
	});
