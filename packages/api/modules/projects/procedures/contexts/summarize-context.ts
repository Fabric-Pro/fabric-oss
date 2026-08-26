import { ORPCError } from "@orpc/client";
import {
	getInProgressContextSummary,
	hasProjectAccess,
	type SourceSelection,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertContextSummarizationEnabled,
	isCodeRepoSummarySourceEnabled,
} from "../../lib/context-summarization-feature";

/**
 * Manually kick off context summarization for a project. Admin-only
 * (`PROJECT_SETTINGS_EDIT`) — editors/viewers are rejected. Dispatches the
 * async Temporal workflow (deterministic per-project workflow id, so a run
 * already in flight is not duplicated) and returns immediately; the Context tab
 * polls `summaryStatus`. Flag-gated: behaves as if absent when the feature is
 * off.
 */
export const summarizeContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/summarize",
		tags: ["Projects", "Contexts"],
		summary: "Summarize context",
		description:
			"Start async compression of the project's accumulated context into a structured summary.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Which sources to consider. Omitted = all (default). At least one must
			// be enabled; the code-repo source is only honored when its flag is on.
			sources: z
				.object({
					context: z.boolean(),
					decisions: z.boolean(),
					roadmap: z.boolean(),
					codeRepo: z.boolean(),
				})
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertContextSummarizationEnabled();
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Resolve the effective source selection. Default is all-on (with code-repo
		// following its flag). A provided selection is flag-gated (code-repo forced
		// off when its feature is off) and must leave at least one source enabled.
		const codeRepoEnabled = isCodeRepoSummarySourceEnabled();
		const sources: SourceSelection = {
			context: input.sources?.context ?? true,
			decisions: input.sources?.decisions ?? true,
			roadmap: input.sources?.roadmap ?? true,
			codeRepo: (input.sources?.codeRepo ?? true) && codeRepoEnabled,
		};
		if (
			!sources.context &&
			!sources.decisions &&
			!sources.roadmap &&
			!sources.codeRepo
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Select at least one source to summarize.",
			});
		}

		// Friendly early-out if a run is already active (the dispatcher also
		// dedupes at the Temporal level via the deterministic workflow id).
		const inProgress = await getInProgressContextSummary({
			projectId: input.projectId,
			userId: user.id,
			organizationId,
		});
		if (inProgress) {
			return {
				started: false,
				status: inProgress.status,
				workflowId: `context-summarization-${input.projectId}`,
			};
		}

		// Summary tenancy mirrors the project's XOR (org → organizationId set,
		// userId null; personal → the owner's userId, organizationId null).
		// Lazy-import so this procedure doesn't pull the Temporal client into the
		// bundle unless invoked.
		const { startContextSummarizationWorkflow } = await import(
			"@repo/temporal"
		);
		const { workflowId, started } = await startContextSummarizationWorkflow(
			{
				projectId: input.projectId,
				userId: organizationId ? null : user.id,
				organizationId: organizationId ?? null,
				trigger: "MANUAL",
				triggeredByUserId: user.id,
				sources,
			},
		);

		return { started, status: "PENDING" as const, workflowId };
	});
