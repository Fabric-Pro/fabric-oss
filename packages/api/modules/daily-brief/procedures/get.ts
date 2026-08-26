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
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
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
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorize via the project, not via the brief's own tenant columns
		// (those may drift if a project is ever transferred between user and org).
		const project = await db.project.findFirst({
			where: organizationId
				? { id: input.projectId, organizationId }
				: {
						id: input.projectId,
						organizationId: null,
						userId: context.user.id,
					},
			select: { id: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

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
