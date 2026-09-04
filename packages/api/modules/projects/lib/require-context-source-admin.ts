import { ORPCError } from "@orpc/server";
import { isFeatureEnabled } from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";

/**
 * The escalated gate for destructive context-source actions — unlinking a
 * meeting, a Teams channel, a Teams chat or a Slack channel (Fizzy #2355).
 *
 * These procedures declare `PROJECT_UPDATE` on their middleware, which is
 * EDITOR and up. That is the floor this call raises to PROJECT_ADMIN, but only
 * while `MEETING_SYNC_CONTROLS` is on — the flag gates a capability REMOVAL, so
 * it has to be reversible without a redeploy, and a static middleware
 * permission could not give us that.
 *
 * Why the escalation belongs here rather than in the middleware: unlinking is
 * one rung MORE destructive than deleting a single context, which already
 * requires `CONTEXT_DELETE` (PROJECT_ADMIN+). Today an EDITOR who cannot delete
 * one context can unlink a meeting and take out dozens along with their
 * vectors. This closes that.
 *
 * Uses `resolveEffectiveProjectPermissions` — the same authoritative resolver
 * `requireProjectPermission` uses, where an active ProjectMember row overrides
 * the org role — so the answer here and the answer at the middleware cannot
 * disagree.
 */
export async function requireContextSourceAdmin(params: {
	projectId: string;
	userId: string;
}): Promise<void> {
	if (!(await isFeatureEnabled("MEETING_SYNC_CONTROLS"))) {
		return;
	}

	const effective = await resolveEffectiveProjectPermissions(
		params.projectId,
		params.userId,
	);

	if (
		!hasPermission(
			effective?.permissions ?? [],
			Permissions.PROJECT_SETTINGS_EDIT,
		)
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Only project admins and owners can unlink a meeting or channel, because it permanently deletes the context it captured.",
		});
	}
}
