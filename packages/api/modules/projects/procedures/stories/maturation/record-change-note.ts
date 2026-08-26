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

/**
 * Sentinel `impactedSection` that buckets AI-update notes into their own
 * collapsible "AI Updates" group in the Decision Log (kept in sync with the same
 * literal in the web `DecisionLogPanel`). Not a real spec section.
 */
export const AI_UPDATES_SECTION = "AI Updates";

/**
 * `maturation.recordChangeNote` — persist an accepted maturation run's change
 * summary as one collapsed, AGENT-authored "AI update" note in the Decision
 * Log. Called by the client right after the PO
 * accepts the AI's changes, so the run history lives alongside the decisions
 * instead of being discarded with the ephemeral confirm-time summary.
 *
 * PM-SYNC ISOLATION (§7.7): writes a Decision Log row only — never the dev-facing
 * Clean Spec — so it does not trigger PM sync. Best-effort by the caller: a
 * failed note must not undo the accept.
 */
export const recordChangeNoteProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/change-note",
		tags: ["Projects", "Features", "Maturation"],
		summary:
			"Record an accepted run's change summary as a Decision Log note",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			bullets: z.array(z.string().min(1).max(2_000)).min(1).max(50),
		}),
	)
	.output(z.object({ id: z.string() }))
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

		// One bullet per line; the panel splits on newlines to render the list.
		const content = input.bullets.map((b) => b.trim()).join("\n");

		const entry = await createDecisionLogEntry({
			tenantFilter,
			userStoryId: input.storyId,
			authorType: "AGENT",
			authorName: context.user.name,
			sourceProvenance: "AI Feature Assistant",
			status: "RESOLVED",
			source: "AI_CONFIRMED",
			content,
			summary: null,
			impactedSection: AI_UPDATES_SECTION,
		});

		return { id: entry.id };
	});
