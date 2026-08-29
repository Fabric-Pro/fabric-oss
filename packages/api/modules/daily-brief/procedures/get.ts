/**
 * Daily Brief — Get Procedure
 *
 * Returns the latest brief for (projectId, timeWindow), enriched with the
 * caller's per-user cursor so the UI can apply the "since my last review"
 * filter client-side. If the brief is GENERATING, also includes the Temporal
 * workflow progress via a WorkflowHandle.query() call.
 */
import { ORPCError } from "@orpc/server";
import {
	type DailyBriefContent,
	dailyBriefContentSchema,
	db,
	type TimeWindowKind,
	timeWindowKindSchema,
} from "@repo/database";
import {
	type DailyBriefProgress,
	getTemporalClient,
	isTemporalAvailable,
} from "@repo/temporal";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			timeWindow: timeWindowKindSchema.default("LAST_24H"),
		}),
	)
	.handler(async ({ input, context }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		const brief = await db.dailyBrief.findFirst({
			where: {
				projectId: input.projectId,
				timeWindowKind: input.timeWindow,
			},
			orderBy: { generatedAt: "desc" },
		});

		const cursor = await db.projectBriefCursor.findUnique({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			select: { lastReviewedAt: true },
		});

		let progress: DailyBriefProgress | null = null;
		if (brief?.status === "GENERATING" && brief.temporalWorkflowId) {
			const available = await isTemporalAvailable();
			if (available) {
				try {
					const client = await getTemporalClient();
					const handle = client.workflow.getHandle(
						brief.temporalWorkflowId,
					);
					progress =
						await handle.query<DailyBriefProgress>("briefProgress");
				} catch {
					progress = null;
				}
			}
		}

		let content: DailyBriefContent | null = null;
		if (brief?.content) {
			const parsed = dailyBriefContentSchema.safeParse(brief.content);
			content = parsed.success ? parsed.data : null;
		}

		return {
			brief: brief
				? {
						id: brief.id,
						status: brief.status as
							| "GENERATING"
							| "READY"
							| "EMPTY"
							| "FAILED",
						generatedAt: brief.generatedAt,
						timeWindowStart: brief.timeWindowStart,
						timeWindowEnd: brief.timeWindowEnd,
						timeWindowKind: brief.timeWindowKind as TimeWindowKind,
						errorMessage: brief.errorMessage,
						content,
						temporalWorkflowId: brief.temporalWorkflowId,
					}
				: null,
			cursor: cursor?.lastReviewedAt ?? null,
			progress,
		};
	});
