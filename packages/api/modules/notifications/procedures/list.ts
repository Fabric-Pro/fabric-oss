import { db, NotificationCategory, NotificationType } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { filterByCurrentAccess } from "../lib/access-filter";
import {
	INCIDENT_NOTIFICATION_TYPES,
	WEEKLY_DIGEST_DEDUPE_PREFIX,
} from "../lib/incident-notification-types";

const listInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	cursor: z.string().optional(),
	limit: z.number().min(1).max(50).default(20),
	status: z.enum(["all", "unread", "archived"]).default("all"),
	category: z.nativeEnum(NotificationCategory).optional(),
	// Optional precise type filter used by the inbound/conflict tabs (AC-10),
	// which need to discriminate within a category (e.g. only PM_SYNC_CONFLICT
	// out of the broader PROJECT category). Additive: `category` still works.
	types: z.array(z.nativeEnum(NotificationType)).optional(),
});

export const listNotificationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.NOTIFICATIONS_READ))
	.route({
		method: "GET",
		path: "/notifications",
		tags: ["Notifications"],
		summary: "List the caller's notifications",
	})
	.input(listInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;

		// `archived` tab shows only archived rows; every other tab hides them.
		const archivedFilter =
			input.status === "archived"
				? { archivedAt: { not: null } }
				: { archivedAt: null };
		const unreadFilter = input.status === "unread" ? { readAt: null } : {};

		// Over-fetch a bit to allow access-filter rejections without a second
		// page request when the user just lost access to a project.
		const fetchLimit = input.limit * 2 + 1;
		const rows = await db.notification.findMany({
			where: {
				userId: context.user.id,
				organizationId,
				// Per-incident alert notifications live on the monitoring page
				// now — hide them from the bell — but KEEP the low-noise weekly
				// incident digest (same SYSTEM_INCIDENT type, told apart by its
				// dedupe-key prefix).
				OR: [
					{ type: { notIn: INCIDENT_NOTIFICATION_TYPES } },
					{ dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX } },
				],
				...archivedFilter,
				...unreadFilter,
				...(input.category ? { category: input.category } : {}),
				...(input.types?.length ? { type: { in: input.types } } : {}),
			},
			orderBy: { createdAt: "desc" },
			take: fetchLimit,
			...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
		});

		const visible = await filterByCurrentAccess(rows, context.user.id);
		const items = visible.slice(0, input.limit);
		const hasMore = visible.length > input.limit;

		// Hydrate the human actor (if any) so the UI can render the actor's
		// avatar with the category icon as a small badge overlay. Rows with
		// no actorUserId (system / agent-originated) fall back to the muted
		// category-icon bubble client-side.
		const actorIds = Array.from(
			new Set(
				items
					.map((n) => n.actorUserId)
					.filter((id): id is string => Boolean(id)),
			),
		);
		const actors = actorIds.length
			? await db.user.findMany({
					where: { id: { in: actorIds } },
					select: { id: true, name: true, image: true },
				})
			: [];
		const actorById = new Map(actors.map((u) => [u.id, u]));

		// Resolve each notification's owning-org slug so the client can build the
		// click target from the notification's OWN org, not whichever workspace
		// the user is currently in (the #1528 wrong-workspace bug). The list is
		// org-scoped, so this is effectively a single lookup, but the batch form
		// stays correct if that ever changes. The slug only forms the URL base —
		// the destination route enforces its own access.
		const orgIds = Array.from(
			new Set(
				items
					.map((n) => n.organizationId)
					.filter((id): id is string => Boolean(id)),
			),
		);
		const orgs = orgIds.length
			? await db.organization.findMany({
					where: { id: { in: orgIds } },
					// `name` is for the stacked-card chip (#2117); `slug` builds
					// the click target. Same batched lookup, no extra query.
					select: { id: true, slug: true, name: true },
				})
			: [];
		const orgById = new Map(orgs.map((o) => [o.id, o]));

		// Project names for the stacked-card chip (#2117). Keyed off `items` —
		// which is post-access-filter AND post-slice — never off `rows`.
		// `filterByCurrentAccess` has already dropped every notification whose
		// project the caller can no longer see, so every id reaching here is
		// access-checked by construction and no name can leak.
		const projectIds = Array.from(
			new Set(
				items
					.map((n) => n.projectId)
					.filter((id): id is string => Boolean(id)),
			),
		);
		const projects = projectIds.length
			? await db.project.findMany({
					where: { id: { in: projectIds } },
					select: { id: true, name: true },
				})
			: [];
		const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

		const enriched = items.map((n) => ({
			...n,
			actor: n.actorUserId
				? (actorById.get(n.actorUserId) ?? null)
				: null,
			organizationSlug: n.organizationId
				? (orgById.get(n.organizationId)?.slug ?? null)
				: null,
			organizationName: n.organizationId
				? (orgById.get(n.organizationId)?.name ?? null)
				: null,
			projectName: n.projectId
				? (projectNameById.get(n.projectId) ?? null)
				: null,
		}));

		return {
			items: enriched,
			nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
		};
	});
