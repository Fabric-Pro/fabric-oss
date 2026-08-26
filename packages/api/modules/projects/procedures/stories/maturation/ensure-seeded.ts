import { ORPCError } from "@orpc/client";
import {
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
import { seedMaturationSurfaces } from "../../../lib/seed-maturation-surfaces";

/**
 * `maturation.ensureSeeded` — populate the maturation surfaces on editor open so
 * the PO never lands on an empty Summary digest or an empty question list when a
 * feature has a Clean Spec but has never been seeded. Generates the digest if
 * missing and runs a first-time question scan if the feature has never been
 * scanned. Idempotent and cheap when nothing is needed (a count + null check, no
 * model call). Client-triggered once on mount.
 *
 * PM-sync isolation (§7.7): writes only `summaryDigest` and maturation surfaces,
 * never the Clean Spec, so it does not trigger PM sync.
 */
export const ensureSeededProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/ensure-seeded",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Auto-generate the Summary digest and first-time questions",
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
			summaryGenerated: z.boolean(),
			questionsScanned: z.boolean(),
			minted: z.number().int(),
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

		return seedMaturationSurfaces({ feature, tenantFilter });
	});
