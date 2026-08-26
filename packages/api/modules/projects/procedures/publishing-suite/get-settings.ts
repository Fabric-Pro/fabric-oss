import { ORPCError } from "@orpc/client";
import { db, getPublishingSuiteSettings } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

export const getPublishingSuiteSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-settings",
		tags: ["Projects", "Publishing Suite"],
		summary: "Read the project's Publishing Suite configuration",
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
		// the org. The helper that used to scope this read returns the caller's
		// org string verbatim, with no membership lookup, so trusting it here
		// would let a caller pair a project they legitimately reach with an
		// organization id they made up, since neither this middleware nor
		// `hasProjectAccess` checks it. Do NOT bring that helper back — derive the
		// tenant from the loaded Project row instead, exactly like
		// update-settings.ts / upsertPublishingSuiteSettings do for the write.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// `input.organizationId` is a guard only, never a scoping key: reject only
		// a POSITIVELY-WRONG non-null client value. null/omitted always passes —
		// a guest on a personal-context page legitimately sends null even for an
		// org-owned project.
		//
		// BAD_REQUEST rather than NOT_FOUND: `requireProjectPermission` has
		// already authorized this caller for this exact project, so this response
		// discloses nothing they don't already know (the project exists and they
		// can read it) — and BAD_REQUEST matches the mapping
		// upsertPublishingSuiteSettings's PublishingSettingsTenantMismatchError
		// gets on the write side, for the identical guard.
		if (
			input.organizationId != null &&
			input.organizationId !== (project.organizationId ?? null)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "organizationId does not match the project",
			});
		}

		return {
			settings: await getPublishingSuiteSettings(input.projectId),
		};
	});
