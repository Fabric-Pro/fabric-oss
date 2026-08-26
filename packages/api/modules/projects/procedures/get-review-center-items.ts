import { ORPCError } from "@orpc/client";
import { getReviewCenterItems, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Review Center — bounded (~50), grouped actionable list.
 *
 * Grouped in fixed order Conflicts → Failures → Pull-drift. Built by a LIVE
 * query against existing per-item fields (`lastPmSyncStatus`,
 * `PendingPmStateChange.status`) — it reads NEITHER `PmSyncLog` rows nor any
 * backfilled history (D1, spec §9.5). Reads are unaudited (D-Q11). All DB
 * access is delegated to `@repo/database` (`getReviewCenterItems`).
 *
 * Gated on `STORY_UPDATE` (OWNER / PROJECT_ADMIN / EDITOR — spec §11.1).
 */
const ReviewCenterItemSchema = z.object({
	id: z.string(),
	type: z.enum(["conflict", "failure", "pull-drift"]),
	entityType: z.enum(["EPIC", "FEATURE", "STORY"]),
	entityId: z.string(),
	identifier: z.string(),
	title: z.string(),
	pmTool: z.string().nullable(),
	// Entity's stored PM-tool card URL so the FE can render a "View in {tool}"
	// external link. Null when the entity is unlinked / the link was cleared.
	externalUrl: z.string().nullable(),
	summary: z.string(),
	// Fabric-side description for conflict rows — lets the Resolve dialog render
	// the diff without a second round-trip. Empty string when the entity has no
	// description.
	fabricDescription: z.string(),
	// Fabric-side last-updated timestamp (ISO 8601) so the Resolve dialog can
	// render "Updated {when}" on the Fabric column. Null when unavailable.
	fabricUpdatedAt: z.string().nullable(),
	// Fabric-side last-editor display name + edit provenance (UserStory only).
	// Null for system/AI edits (author), pre-feature rows, and Epic/Feature.
	// Enum declared inline to mirror the Prisma `LastEditSource` members.
	fabricAuthor: z.string().nullable(),
	fabricSource: z
		.enum([
			"MANUAL",
			"AI_BACKLOG_UPDATE",
			"AI_MATURATION",
			"CONFLICT_RESOLUTION",
			"PM_PULL",
		])
		.nullable(),
	// Pull-drift discriminator (`PendingPmStateChange.proposedAction`). Lets the
	// FE tell a CONTENT_DRIFT pull-drift row (Resolve dialog) apart from
	// HIDE/UNHIDE/FLAG_MISSING rows (Accept / Reject). Null on conflict/failure.
	proposedAction: z
		.enum(["HIDE", "UNHIDE", "FLAG_MISSING", "CONTENT_DRIFT"])
		.nullable(),
	// PM work-item type derived from `UserStory.kind` (`BUG → "bug"`, else
	// "story"). Threaded into `retryPmSync` so a BUG retries as the correct PM
	// work-item type instead of defaulting to "story" and re-failing.
	itemType: z.enum(["story", "bug"]),
});

export const getReviewCenterItemsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/review-center/items",
		tags: ["Projects", "PM Sync"],
		summary: "Get Review Center actionable items",
		description:
			"Bounded (~50), grouped (Conflicts → Failures → Pull-drift) actionable inbox. Live query against per-item fields; does not read the PM sync log.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			conflicts: z.array(ReviewCenterItemSchema),
			failures: z.array(ReviewCenterItemSchema),
			pullDrift: z.array(ReviewCenterItemSchema),
			total: z.number().int(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenant = organizationId
			? { organizationId }
			: { userId: user.id };

		return getReviewCenterItems({
			...tenant,
			projectId: input.projectId,
		});
	});
