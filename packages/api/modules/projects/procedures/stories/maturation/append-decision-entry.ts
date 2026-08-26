import { ORPCError } from "@orpc/client";
import {
	createDecisionLogEntry,
	getFeatureMaturationState,
	hasProjectAccess,
	type MaturationTenantFilter,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { DecisionSourceSchema, DecisionStatusSchema } from "./schemas";

/**
 * `maturation.appendDecisionEntry` (§12, AC-3.4) — append a Decision Log entry
 * (a new thread root, or a reply when `parentId` is set). The Decision Log is
 * the append-only maturation changelog; callers never mutate prior rows.
 *
 * PM-SYNC ISOLATION (§7.7): writing a Decision Log row changes a NEW working
 * surface, not the dev-facing Clean Spec (`description`/`acceptanceCriteria`).
 * It MUST NOT trigger `enqueuePmSync`. This file deliberately does not import
 * `enqueuePmSync` at all so the isolation is structural, not a runtime branch.
 */
export const appendDecisionEntryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/decision-log",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Append a Decision Log entry",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			parentId: z.string().nullable().optional(),
			content: z.string().min(1).max(10_000),
			summary: z.string().max(2_000).nullable().optional(),
			impactedSection: z.string().max(500).nullable().optional(),
			questionId: z.string().max(500).nullable().optional(),
			status: DecisionStatusSchema.optional(),
			source: DecisionSourceSchema.optional(),
			sourceProvenance: z.string().max(255).nullable().optional(),
		}),
	)
	.output(
		z.object({
			entry: z.object({
				id: z.string(),
				parentId: z.string().nullable(),
				status: DecisionStatusSchema,
				summary: z.string().nullable(),
				content: z.string().nullable(),
				impactedSection: z.string().nullable(),
				questionId: z.string().nullable(),
				createdAt: z.date(),
				authorName: z.string().nullable().optional(),
				sourceProvenance: z.string().nullable().optional(),
			}),
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

		const entry = await createDecisionLogEntry({
			tenantFilter,
			userStoryId: input.storyId,
			authorType: "USER",
			authorUserId: context.user.id,
			parentId: input.parentId ?? null,
			content: input.content,
			summary: input.summary ?? null,
			impactedSection: input.impactedSection ?? null,
			questionId: input.questionId ?? null,
			authorName: context.user.name,
			sourceProvenance: input.sourceProvenance ?? null,
			...(input.status ? { status: input.status } : {}),
			...(input.source ? { source: input.source } : {}),
		});

		return {
			entry: {
				id: entry.id,
				parentId: entry.parentId,
				status: entry.status,
				summary: entry.summary,
				content: entry.content,
				impactedSection: entry.impactedSection,
				questionId: entry.questionId,
				createdAt: entry.createdAt,
				authorName: entry.authorName,
				sourceProvenance: entry.sourceProvenance,
			},
		};
	});
