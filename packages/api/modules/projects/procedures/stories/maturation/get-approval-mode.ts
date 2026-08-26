import { ORPCError } from "@orpc/client";
import {
	effectiveApprovalMode,
	getApprovalPreference,
	getFeatureMaturationState,
	hasProjectAccess,
	type MaturationTab,
	type MaturationTenantFilter,
	type UserApprovalPreferenceModes,
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
 * `maturation.getApprovalMode` (§12, §5.3) — resolve the effective approval mode
 * for each of the three tabs via the single-source-of-truth resolver
 * `feature.<tab>ApprovalMode ?? userPref.<tab>Mode ?? hardDefault(tab)` (the
 * `effectiveApprovalMode` helper from `@repo/database`, not reimplemented here).
 * Also surfaces the raw per-feature override and per-user default so the UI can
 * render which layer is driving each tab.
 */
export const getApprovalModeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/maturation/approval-mode",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Resolve effective approval modes per tab",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			effective: EffectiveApprovalModesSchema,
			featureOverride: z.object({
				cleanSpec: MaturationApprovalModeSchema.nullable(),
				decisionLog: MaturationApprovalModeSchema.nullable(),
				summaryQuestions: MaturationApprovalModeSchema.nullable(),
			}),
			userDefault: z
				.object({
					cleanSpec: MaturationApprovalModeSchema,
					decisionLog: MaturationApprovalModeSchema,
					summaryQuestions: MaturationApprovalModeSchema,
					autoAcceptAll: z.boolean(),
				})
				.nullable(),
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

		const feature = await getFeatureMaturationState({
			userStoryId: input.storyId,
			projectId: input.projectId,
		});
		if (!feature) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const tenantFilter: MaturationTenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		const preference = await getApprovalPreference({ tenantFilter });
		const userPref: UserApprovalPreferenceModes | null = preference
			? {
					cleanSpecMode: preference.cleanSpecMode,
					decisionLogMode: preference.decisionLogMode,
					summaryQuestionsMode: preference.summaryQuestionsMode,
				}
			: null;

		const tabs: MaturationTab[] = [
			"cleanSpec",
			"decisionLog",
			"summaryQuestions",
		];
		const effective = tabs.reduce((acc, tab) => {
			acc[tab] = effectiveApprovalMode(feature, userPref, tab);
			return acc;
		}, {} as ApprovalModeMap);

		return {
			effective,
			featureOverride: {
				cleanSpec: feature.cleanSpecApprovalMode,
				decisionLog: feature.decisionLogApprovalMode,
				summaryQuestions: feature.summaryQuestionsApprovalMode,
			},
			userDefault: preference
				? {
						cleanSpec: preference.cleanSpecMode,
						decisionLog: preference.decisionLogMode,
						summaryQuestions: preference.summaryQuestionsMode,
						autoAcceptAll: preference.autoAcceptAll,
					}
				: null,
		};
	});
