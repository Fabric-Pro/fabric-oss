import { ORPCError } from "@orpc/server";
import { db, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { gatherReadinessEvidence } from "../../lib/readiness/evidence";

/**
 * Record that this person has now looked at the checklist (Fizzy #2165).
 *
 * Called when the panel is EXPANDED, never on page load. Opening a project with
 * the panel collapsed must not clear markers nobody saw — an unread badge that
 * clears itself without being read is worse than no badge, because it teaches
 * the reader to distrust the next one.
 *
 * Personal, like snooze and for the same reason: "have I seen this" is a fact
 * about one person. The verdict rows it is compared against stay project-wide,
 * and that pairing is what makes the comparison correct while several teammates
 * open the same panel — `changedAt` is when a verdict flipped, not when anyone
 * last recomputed it.
 *
 * `autoExpanded` is passed by the caller rather than inferred here: only the
 * client knows whether the panel opened itself or the person opened it, and the
 * once-a-day cap is about the former.
 */
export const markReadinessSeenProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/readiness/seen",
		tags: ["Projects", "Readiness"],
		summary: "Record that the caller has seen the readiness checklist",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** The level they saw, so a later drop is detectable. */
			level: z.enum(["NOT_READY", "PARTIALLY_READY", "READY"]),
			/** True when the panel opened itself rather than being opened. */
			autoExpanded: z.boolean().default(false),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ ok: z.literal(true) }))
	.handler(async ({ input, context }) => {
		if (!(await isFeatureEnabled("PROJECT_READINESS"))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project readiness is not enabled.",
			});
		}

		const gathered = await gatherReadinessEvidence(input.projectId);
		if (!gathered) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found." });
		}

		const now = new Date();
		const seen = {
			readinessSeenAt: now,
			readinessSeenLevel: input.level,
			...(input.autoExpanded ? { readinessAutoExpandedAt: now } : {}),
		};

		await db.projectUserPreference.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				// Mirrors the parent project's tenancy, as every other row on
				// this table does.
				organizationId: gathered.tenant.organizationId,
				...seen,
			},
			update: seen,
		});

		return { ok: true as const };
	});
