import { ORPCError } from "@orpc/client";
import {
	listProjectQaPipelineSources,
	setProjectRepoQaBranch,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";
import {
	describeMissingResultSource,
	resolveProjectPmToolLabel,
} from "../../lib/qa-result-source";

/**
 * The connected repos QA can pull CI results from, each with the branch it
 * watches. Read-gated by TEST_CASE_READ; `requireProjectPermission` is the
 * tenant boundary and the query re-scopes by projectId. Returns no credentials —
 * this list is rendered in the browser.
 */
export const listQaPipelineSourcesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/sources",
		tags: ["Projects", "Test Cases"],
		summary: "List connected repos QA pulls CI results from",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const [sources, pmToolLabel] = await Promise.all([
			listProjectQaPipelineSources({ projectId: input.projectId }),
			// Only ever used to explain an EMPTY list, but resolved
			// unconditionally: branching the query on the list's length would
			// make the response shape depend on data, which every caller then
			// has to reason about.
			resolveProjectPmToolLabel(input.projectId),
		]);
		return {
			sources,
			/**
			 * What to say when `sources` is empty. A project whose
			 * PM tool cannot return test runs must be TOLD so rather than shown
			 * an empty list it cannot interpret.
			 *
			 * The sentence is composed here rather than in the component for the
			 * same reason the CI-trigger refusals are returned as data: the
			 * distinction it draws depends on server-side configuration, and a
			 * second copy in the browser is a second thing to keep true.
			 */
			noSourcesReason: describeMissingResultSource(pmToolLabel),
		};
	});

/**
 * Point QA at a branch for one connected repo, or clear it (empty string) to
 * follow the repo default again. Write-gated by TEST_CASE_UPDATE. The projectId
 * is carried into the WHERE, so an integration id belonging to another project
 * matches nothing and 404s rather than being retargeted.
 */
export const setQaPipelineBranchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pipeline-results/sources/{integrationId}/branch",
		tags: ["Projects", "Test Cases"],
		summary: "Set the branch QA watches for a connected repo",
	})
	.input(
		z.object({
			projectId: z.string(),
			integrationId: z.string(),
			// "" clears the override; a ref can't contain whitespace or "..".
			qaBranch: z
				.string()
				.max(255)
				.refine((v) => v === "" || !/\s|\.\./.test(v), {
					message: "Not a valid branch name",
				}),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		const user = context.user;
		// Read the prior value so the audit row records what actually changed —
		// "set to develop" is far less useful during an investigation than
		// "main -> develop", and the row is immutable once written.
		const before = (
			await listProjectQaPipelineSources({ projectId: input.projectId })
		).find((s) => s.integrationId === input.integrationId);

		const result = await setProjectRepoQaBranch({
			projectId: input.projectId,
			integrationId: input.integrationId,
			qaBranch: input.qaBranch,
		});
		if (!result.updated) {
			// Either the repo isn't connected here, or it belongs to another
			// project — the query scopes by projectId, so both land here. Logged
			// as a warning because a repeated miss is worth noticing.
			logger.warn("qa.pipeline.branch.update_missed", {
				projectId: input.projectId,
				integrationId: input.integrationId,
				userId: user.id,
			});
			throw new ORPCError("NOT_FOUND", {
				message: "Repository is not connected to this project",
			});
		}

		const nextBranch = input.qaBranch.trim() || null;
		logger.info("qa.pipeline.branch.updated", {
			projectId: input.projectId,
			integrationId: input.integrationId,
			from: before?.qaBranch ?? null,
			to: nextBranch,
			// What the sync will actually watch now — the override, else default.
			effectiveBranch: nextBranch ?? before?.defaultBranch ?? null,
			userId: user.id,
		});

		// SOC 2 CC6/CC7: changing which branch QA ingests results from changes
		// what evidence the project reports, so it is a config change that must
		// leave an immutable trail with the actor and the before/after.
		// Through `recordAuditFromRequest`, not `recordAudit`: its
		// `resolveActor` fills the actor's email and name from the request, and
		// without them a config change is attributed to `system` rather than to
		// the person who made it — which defeats the point of auditing it. It
		// also carries ip / user agent / request id / session id. The owning
		// organization is derived from `projectId` in the write path.
		recordAuditFromRequest(context, {
			action: "org.integration.config_updated",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: input.integrationId,
			},
			metadata: {
				setting: "qaBranch",
				from: before?.qaBranch ?? null,
				to: nextBranch,
				repositoryDefaultBranch: before?.defaultBranch ?? null,
			},
		});

		return result;
	});
