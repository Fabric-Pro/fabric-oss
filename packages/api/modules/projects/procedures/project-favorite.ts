/**
 * AUTHORIZATION
 *
 * `requireProjectPermission(PROJECT_READ)` — object-level, resolved against the
 * specific project id in the input, plus a reachability re-check in the handler.
 *
 * Two deliberate choices behind that:
 *
 * - **Read level, not update.** Favoriting changes a per-user preference, not
 *   the project, so a viewer must be able to do it. The roadmap-view and
 *   decisions-view preferences write under read permission for the same reason.
 *   Take only the LEVEL from those siblings — they use the org-role decorator
 *   plus a hand-rolled re-check, which is the shape this replaces.
 *
 * - **The re-check is not redundant.** The object-level decorator falls back to
 *   the caller's organization role, and every role down to viewer carries
 *   PROJECT_READ — so any org member passes for any project in that org. The
 *   shortcut read admits only owners and accepted project members. Without the
 *   re-check an org member could star a project they will never see in their
 *   sub-nav, get an optimistic filled star, and watch it silently vanish.
 *
 * Every denial is collapsed to one shape by `normalizeProjectDenial` so the pair
 * cannot be used to probe which project ids exist.
 */
import { ORPCError } from "@orpc/client";
import { hasProjectAccess, setProjectFavorite } from "@repo/database";
import { z } from "zod";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "../../../lib/rate-limit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	normalizeProjectDenial,
	PROJECT_DENIAL_MESSAGE,
} from "./lib/normalize-project-denial";

export const setProjectFavoriteProcedure = tenantProtectedProcedure
	.use(normalizeProjectDenial)
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/favorite",
		tags: ["Projects"],
		summary: "Mark or unmark a project as the caller's favorite",
	})
	.input(
		z.object({
			projectId: z.string(),
			favorited: z.boolean(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ favorited: z.boolean() }))
	.handler(async ({ input, context }) => {
		const userId = context.user.id;

		const rl = await checkRateLimit(
			`project-favorite:user:${userId}`,
			RATE_LIMIT_PRESETS.standard.limit,
			RATE_LIMIT_PRESETS.standard.windowMs,
		);
		if (!rl.allowed) {
			// A Redis outage fails closed here, and "wait N seconds" would be a
			// lie about why. Mirrors the two existing rate-limit call sites.
			if (rl.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Please wait ${rl.resetInSeconds} seconds before trying again.`,
			});
		}

		// Reachability re-check — see the AUTHORIZATION note. Resolved against the
		// project's own organization, so a project-scoped guest passes.
		if (!(await hasProjectAccess(input.projectId, userId))) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_DENIAL_MESSAGE,
			});
		}

		await setProjectFavorite({
			projectId: input.projectId,
			userId,
			favorited: input.favorited,
		});

		return { favorited: input.favorited };
	});
