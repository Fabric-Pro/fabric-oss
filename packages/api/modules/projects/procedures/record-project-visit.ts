/**
 * AUTHORIZATION
 *
 * `requireProjectPermission(PROJECT_READ)` — object-level, resolved against the
 * specific project id — plus a reachability re-check in the handler, exactly as
 * the favorite toggle does and for the same reason: the decorator falls back to
 * the caller's organization role, which admits any org member to any project in
 * that org, while the shortcut read admits only owners and accepted project
 * members. The re-check is what makes "a project the caller cannot read never
 * produces a visit" true rather than aspirational.
 *
 * Denials collapse to one shape via `normalizeProjectDenial`. The endpoint is
 * client-driven, unbounded and its failures are swallowed on the client by
 * design, so it also carries a per-user rate limit — abuse would otherwise leave
 * no trace in the interface at all.
 *
 * Deliberately its own procedure rather than a hook on the single-project read:
 * that read is called by the project creation wizard's readiness polling and by
 * several settings panels, so piggybacking would record creating a project and
 * editing its settings as visits.
 *
 * NOT a passive poll. It fires on a user opening a project, so it belongs in the
 * last-seen middleware's activity signal rather than in PASSIVE_POLL_PATHS.
 */
import { ORPCError } from "@orpc/client";
import { hasProjectAccess, recordProjectVisit } from "@repo/database";
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

export const recordProjectVisitProcedure = tenantProtectedProcedure
	.use(normalizeProjectDenial)
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/visit",
		tags: ["Projects"],
		summary: "Record that the caller opened this project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ recorded: z.boolean() }))
	.handler(async ({ input, context }) => {
		const userId = context.user.id;

		const rl = await checkRateLimit(
			`project-visit:user:${userId}`,
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

		if (!(await hasProjectAccess(input.projectId, userId))) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_DENIAL_MESSAGE,
			});
		}

		await recordProjectVisit({ projectId: input.projectId, userId });

		return { recorded: true };
	});
