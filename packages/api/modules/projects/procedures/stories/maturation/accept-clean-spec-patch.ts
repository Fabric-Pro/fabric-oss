import { ORPCError } from "@orpc/client";
import {
	getDecisionLogEntryById,
	getFeatureMaturationState,
	hasProjectAccess,
	type MaturationTenantFilter,
	recordAiOutcome,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { acceptPendingPatches } from "../../../lib/accept-pending-patches";

/**
 * `maturation.acceptCleanSpecPatch` (§7.5, TG6) — apply a MANUAL-mode decision's
 * PENDING Clean-Spec patches on the PO's explicit accept. Reuses the same
 * deterministic apply + versioned write + PM-sync gate as AUTO_ACCEPT; refuses
 * the whole set (no write) if a stashed patch no longer locates against the
 * current spec.
 */
export const acceptCleanSpecPatchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/accept-clean-spec-patch",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Apply a decision's pending Clean Spec patches",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			decisionId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			status: z.enum(["applied", "refused", "noop"]),
			appliedCount: z.number().int(),
			failedCount: z.number().int(),
			pmSyncEnqueued: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenantFilter: MaturationTenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		const [feature, decision] = await Promise.all([
			getFeatureMaturationState({
				userStoryId: input.storyId,
				projectId: input.projectId,
			}),
			getDecisionLogEntryById({
				tenantFilter,
				userStoryId: input.storyId,
				id: input.decisionId,
			}),
		]);
		if (!feature) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}
		if (!decision) {
			throw new ORPCError("NOT_FOUND", { message: "Decision not found" });
		}

		try {
			const outcome = await acceptPendingPatches({
				feature,
				decision,
				tenantFilter,
				projectId: input.projectId,
				lastEditedByName: context.user.name ?? null,
			});

			// Behavioural acceptance signal (Fizzy #2230). "refused" means the
			// stashed patch no longer located against the current spec — the AI
			// produced something that no longer applies — so it counts as a
			// rejection. "noop" had nothing to decide and is not recorded at
			// all, since a verdict nobody rendered would drag the rate down.
			if (outcome.status !== "noop") {
				// try/catch, not `.catch()`: a synchronous throw would escape a
				// promise handler and land in the outer catch below, turning a
				// SUCCESSFUL apply into a 500. Measurement must never break the
				// write it measures.
				try {
					await recordAiOutcome({
						featureKey: "maturation",
						outcome:
							outcome.status === "applied"
								? "ACCEPTED_AS_IS"
								: "REJECTED",
						subjectType: "spec-patch",
						subjectId: input.decisionId,
						userId: context.user.id,
						organizationId,
						projectId: input.projectId,
					});
				} catch (err) {
					logger.warn("[maturation] outcome capture failed", {
						decisionId: input.decisionId,
						err: err instanceof Error ? err.message : String(err),
					});
				}
			}

			return {
				status: outcome.status,
				appliedCount: outcome.applied.length,
				failedCount: outcome.failed.length,
				pmSyncEnqueued: outcome.pmSyncEnqueued,
			};
		} catch (err) {
			logger.error("[maturation] accept pending patches failed", {
				storyId: input.storyId,
				decisionId: input.decisionId,
				err: err instanceof Error ? err.message : String(err),
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Failed to apply the pending changes. Please try again.",
			});
		}
	});
