import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requestPublishingGeneration } from "../../lib/request-publishing-generation";

export const generatePublishingTopicsNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/generate",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate topic suggestions now",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPublishingSuiteFeatureEnabled();

		// Security ratchet (SOC 2 CC6.1/CC6.3 — see
		// __tests__/input-org-unverified-ratchet.test.ts): `requireProjectPermission`
		// above already proved `context` is authorized for THIS project
		// (object-level, resolved on (projectId, userId)) — but it never inspects
		// the org. Derive the tenant from the loaded Project row instead of
		// resolving the organization from caller input, exactly like
		// get-settings.ts / update-settings.ts do for the sibling procedures.
		//
		// `status: "ACTIVE", deletedAt: null` keeps this lookup in lockstep with
		// the eligibility filter `runPublishingSuggestionDispatch` re-applies
		// (find-eligible-projects.ts / dispatch-suggestion.ts F3) before it will
		// do anything. Without it, an archived or soft-deleted project resolves
		// here, the dispatch core silently no-ops on its own filter, and the
		// caller is told `{ status: "started" }` for a run that never happened.
		// `findFirst` (not `findUnique`) because the extra non-unique conjuncts
		// are filters, not identifiers.
		const project = await db.project.findFirst({
			where: { id: input.projectId, status: "ACTIVE", deletedAt: null },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// `input.organizationId` is a guard only, never a scoping key: reject only
		// a POSITIVELY-WRONG non-null client value. null/omitted always passes —
		// a guest on a personal-context page legitimately sends null even for an
		// org-owned project.
		if (
			input.organizationId != null &&
			input.organizationId !== (project.organizationId ?? null)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "organizationId does not match the project",
			});
		}

		return await requestPublishingGeneration({
			projectId: project.id,
			triggeredByUserId: context.user.id,
		});
	});
