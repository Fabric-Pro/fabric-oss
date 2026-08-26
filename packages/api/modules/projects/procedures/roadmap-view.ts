import { ORPCError } from "@orpc/client";
import { db, getProjectAccessById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// The persisted per-user roadmap view (layout, grouping, sort, card fields +
// order). Kept permissive/optional on purpose — the web client owns the
// canonical shape and sanitizes the value on read, so adding new view options
// later never needs an API or database migration.
const roadmapViewSchema = z
	.object({
		mode: z.enum(["table", "board", "plain", "priority"]).optional(),
		groupBy: z.enum(["priority", "stage"]).optional(),
		columns: z
			.object({
				stage: z.boolean(),
				sync: z.boolean(),
				size: z.boolean(),
				source: z.boolean(),
				flags: z.boolean(),
			})
			.partial()
			.optional(),
		columnOrder: z.array(z.string()).optional(),
		sort: z
			.object({
				key: z.string(),
				direction: z.enum(["asc", "desc"]),
			})
			.optional(),
	})
	.passthrough();

type RoadmapViewValue = z.infer<typeof roadmapViewSchema>;

// Per-user manual roadmap ordering: a { storyId: order } map. The web client
// merges a reordered bucket into this map so each user's drag sequence is
// personal; the shared story.roadmapOrder remains the default/fallback for any
// story the user hasn't personally placed.
const roadmapStoryOrderSchema = z.record(z.string(), z.number());
type RoadmapStoryOrderValue = z.infer<typeof roadmapStoryOrderSchema>;

// The `roadmapView` / `roadmapStoryOrder` JSON columns are added by migration
// 20260612000000_add_roadmap_view_preference. The cast keeps the stored shapes
// ours (vs. Prisma's broad JsonValue) and degrades gracefully if a deploy runs
// before the Prisma client is regenerated. Writing one field omits the other,
// so saving the view never clobbers the order and vice-versa.
function getRoadmapViewDelegate() {
	return (
		db as typeof db & {
			projectUserPreference?: {
				findUnique: (args: {
					where: {
						projectId_userId: { projectId: string; userId: string };
					};
					select: { roadmapView: true; roadmapStoryOrder: true };
				}) => Promise<{
					roadmapView: unknown;
					roadmapStoryOrder: unknown;
				} | null>;
				upsert: (args: {
					where: {
						projectId_userId: { projectId: string; userId: string };
					};
					create: {
						projectId: string;
						userId: string;
						organizationId: string | null;
						roadmapView?: RoadmapViewValue;
						roadmapStoryOrder?: RoadmapStoryOrderValue;
					};
					update: {
						organizationId: string | null;
						roadmapView?: RoadmapViewValue;
						roadmapStoryOrder?: RoadmapStoryOrderValue;
					};
					select: { roadmapView: true; roadmapStoryOrder: true };
				}) => Promise<{
					roadmapView: unknown;
					roadmapStoryOrder: unknown;
				}>;
			};
		}
	).projectUserPreference;
}

const roadmapViewInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getRoadmapViewProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/roadmap-view",
		tags: ["Projects"],
		summary: "Get per-user roadmap view preferences + manual order",
	})
	.input(roadmapViewInput)
	.output(
		z.object({
			roadmapView: roadmapViewSchema.nullable(),
			roadmapStoryOrder: roadmapStoryOrderSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await getProjectAccessById(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const delegate = getRoadmapViewDelegate();
		const preference = delegate
			? await delegate.findUnique({
					where: {
						projectId_userId: {
							projectId: input.projectId,
							userId: context.user.id,
						},
					},
					select: { roadmapView: true, roadmapStoryOrder: true },
				})
			: null;
		// Tolerate legacy/partial stored values — a parse failure just means
		// "nothing saved", so the client falls back to its localStorage cache /
		// the shared default order.
		const parsedView = roadmapViewSchema.safeParse(preference?.roadmapView);
		const parsedOrder = roadmapStoryOrderSchema.safeParse(
			preference?.roadmapStoryOrder,
		);
		return {
			roadmapView: parsedView.success ? parsedView.data : null,
			roadmapStoryOrder: parsedOrder.success ? parsedOrder.data : null,
		};
	});

export const updateRoadmapViewProcedure = tenantProtectedProcedure
	// PROJECT_READ (not UPDATE): the row written is the caller's OWN per-user view
	// for a project they can already see — so any member who can read the roadmap
	// can persist their personal layout, including read-only teammates.
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/roadmap-view",
		tags: ["Projects"],
		summary: "Update per-user roadmap view preferences for a project",
	})
	.input(roadmapViewInput.extend({ roadmapView: roadmapViewSchema }))
	.output(z.object({ roadmapView: roadmapViewSchema }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await getProjectAccessById(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const delegate = getRoadmapViewDelegate();
		if (!delegate) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Roadmap view preferences are unavailable until the Prisma client is regenerated.",
			});
		}
		const value = roadmapViewSchema.parse(input.roadmapView);
		// Omits roadmapStoryOrder → the per-user manual order is left untouched.
		const preference = await delegate.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				organizationId: project.organizationId,
				roadmapView: value,
			},
			update: {
				organizationId: project.organizationId,
				roadmapView: value,
			},
			select: { roadmapView: true, roadmapStoryOrder: true },
		});
		return { roadmapView: roadmapViewSchema.parse(preference.roadmapView) };
	});

export const reorderRoadmapStoryOrderProcedure = tenantProtectedProcedure
	// PROJECT_READ: a personal reorder of the caller's OWN view of a project they
	// can already see — it never mutates shared story data (priority/order).
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/roadmap-story-order",
		tags: ["Projects"],
		summary: "Persist the caller's personal roadmap story order (merge)",
	})
	.input(
		roadmapViewInput.extend({
			// The reordered bucket's full new sequence ({ storyId, order } 1..N),
			// merged over any previously-saved personal order.
			orders: z.array(
				z.object({ storyId: z.string(), order: z.number().int() }),
			),
		}),
	)
	.output(z.object({ roadmapStoryOrder: roadmapStoryOrderSchema }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await getProjectAccessById(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const delegate = getRoadmapViewDelegate();
		if (!delegate) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Roadmap ordering is unavailable until the Prisma client is regenerated.",
			});
		}
		const existing = await delegate.findUnique({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			select: { roadmapView: true, roadmapStoryOrder: true },
		});
		const current = roadmapStoryOrderSchema.safeParse(
			existing?.roadmapStoryOrder,
		);
		const merged: RoadmapStoryOrderValue = {
			...(current.success ? current.data : {}),
		};
		for (const entry of input.orders) {
			merged[entry.storyId] = entry.order;
		}
		// Omits roadmapView → the saved view preferences are left untouched.
		const preference = await delegate.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				organizationId: project.organizationId,
				roadmapStoryOrder: merged,
			},
			update: {
				organizationId: project.organizationId,
				roadmapStoryOrder: merged,
			},
			select: { roadmapView: true, roadmapStoryOrder: true },
		});
		return {
			roadmapStoryOrder:
				roadmapStoryOrderSchema.safeParse(preference.roadmapStoryOrder)
					.data ?? merged,
		};
	});
