import { ORPCError } from "@orpc/client";
import {
	effectiveApprovalMode,
	getApprovalPreference,
	getFeatureMaturationState,
	hasProjectAccess,
	type MaturationTab,
	type MaturationTenantFilter,
	setFeatureApprovalOverride,
	type UserApprovalPreferenceModes,
	upsertApprovalPreference,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import {
	type ApprovalModeMap,
	EffectiveApprovalModesSchema,
	MaturationApprovalModeSchema,
} from "./schemas";

/**
 * `maturation.setApprovalMode` (§12, §5.3/AC-5.4) — write the per-feature
 * override and/or the per-user default approval modes, and re-resolve the
 * effective modes for the response.
 *
 * - `featureOverride.*` is tri-state: omit = leave, `null` = clear the override
 *   (fall through to the per-user default), a mode = pin it on the UserStory.
 * - `userDefault.*` updates the per-user default for the current tenant.
 * - `autoAcceptAll: true` is the preset (AC-5.4): it flips all three per-user
 *   defaults to AUTO_ACCEPT and records the preset state.
 *
 * PM-SYNC ISOLATION (§7.7): approval-mode writes touch ONLY the maturation
 * override columns / the preference table — never `description`/
 * `acceptanceCriteria`. They MUST NOT trigger `enqueuePmSync`; this file does
 * not import it.
 */
export const setApprovalModeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/approval-mode",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Set per-feature / per-user approval modes",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			featureOverride: z
				.object({
					cleanSpec:
						MaturationApprovalModeSchema.nullable().optional(),
					decisionLog:
						MaturationApprovalModeSchema.nullable().optional(),
					summaryQuestions:
						MaturationApprovalModeSchema.nullable().optional(),
				})
				.optional(),
			userDefault: z
				.object({
					cleanSpec: MaturationApprovalModeSchema.optional(),
					decisionLog: MaturationApprovalModeSchema.optional(),
					summaryQuestions: MaturationApprovalModeSchema.optional(),
				})
				.optional(),
			autoAcceptAll: z.boolean().optional(),
		}),
	)
	.output(z.object({ effective: EffectiveApprovalModesSchema }))
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

		// Per-feature override (tri-state passthrough). Scoped update — a 0 count
		// means the feature does not exist under this project.
		if (input.featureOverride) {
			const affected = await setFeatureApprovalOverride({
				userStoryId: input.storyId,
				projectId: input.projectId,
				...(input.featureOverride.cleanSpec === undefined
					? {}
					: {
							cleanSpecApprovalMode:
								input.featureOverride.cleanSpec,
						}),
				...(input.featureOverride.decisionLog === undefined
					? {}
					: {
							decisionLogApprovalMode:
								input.featureOverride.decisionLog,
						}),
				...(input.featureOverride.summaryQuestions === undefined
					? {}
					: {
							summaryQuestionsApprovalMode:
								input.featureOverride.summaryQuestions,
						}),
			});
			if (affected === 0) {
				throw new ORPCError("NOT_FOUND", {
					message: "Feature not found",
				});
			}
		}

		// Per-user default + "Auto-accept all" preset. The preset wins: it flips
		// all three modes to AUTO_ACCEPT regardless of explicit per-tab values.
		const wantsUserWrite =
			input.userDefault !== undefined ||
			input.autoAcceptAll !== undefined;
		let preference: UserApprovalPreferenceModes | null = null;
		if (wantsUserWrite) {
			const presetFields = input.autoAcceptAll
				? {
						cleanSpecMode: "AUTO_ACCEPT" as const,
						decisionLogMode: "AUTO_ACCEPT" as const,
						summaryQuestionsMode: "AUTO_ACCEPT" as const,
					}
				: {
						...(input.userDefault?.cleanSpec === undefined
							? {}
							: { cleanSpecMode: input.userDefault.cleanSpec }),
						...(input.userDefault?.decisionLog === undefined
							? {}
							: {
									decisionLogMode:
										input.userDefault.decisionLog,
								}),
						...(input.userDefault?.summaryQuestions === undefined
							? {}
							: {
									summaryQuestionsMode:
										input.userDefault.summaryQuestions,
								}),
					};

			const updated = await upsertApprovalPreference({
				tenantFilter,
				...presetFields,
				...(input.autoAcceptAll === undefined
					? {}
					: { autoAcceptAll: input.autoAcceptAll }),
			});
			preference = {
				cleanSpecMode: updated.cleanSpecMode,
				decisionLogMode: updated.decisionLogMode,
				summaryQuestionsMode: updated.summaryQuestionsMode,
			};
		}

		// Re-resolve effective modes against the freshly written state. Read the
		// feature overrides back so a tri-state clear is reflected immediately.
		const feature = await getFeatureMaturationState({
			userStoryId: input.storyId,
			projectId: input.projectId,
		});
		if (!feature) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		// If the user write happened we have fresh defaults; otherwise fall back
		// to whatever is stored (resolver reads null as "no default set").
		let userPref = preference;
		if (!userPref) {
			const stored = await getApprovalPreference({ tenantFilter });
			userPref = stored
				? {
						cleanSpecMode: stored.cleanSpecMode,
						decisionLogMode: stored.decisionLogMode,
						summaryQuestionsMode: stored.summaryQuestionsMode,
					}
				: null;
		}

		const tabs: MaturationTab[] = [
			"cleanSpec",
			"decisionLog",
			"summaryQuestions",
		];
		const effective = tabs.reduce((acc, tab) => {
			acc[tab] = effectiveApprovalMode(feature, userPref, tab);
			return acc;
		}, {} as ApprovalModeMap);

		return { effective };
	});
