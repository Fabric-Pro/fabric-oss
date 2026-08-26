import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { retryPmSyncItem } from "../../lib/retry-pm-sync-item";

const ItemTypeSchema = z.enum(["epic", "feature", "story", "bug"]);

const InputItemSchema = z.object({
	id: z.string().cuid(),
	itemType: ItemTypeSchema,
});

export const retryPmSyncBatchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/retry-pm-sync-batch",
		tags: ["Projects", "Stories"],
		summary: "Retry PM sync for a batch of hierarchy items",
		description:
			"Backs the 'Retry all' action on the outage rollup. Validates per-item tenant ownership and fans out fire-and-forget enqueue calls.",
	})
	.input(
		z.object({
			projectId: z.string().cuid(),
			items: z.array(InputItemSchema).max(200),
			/**
			 * "Unlink & re-create" applied uniformly across the batch:
			 * each FLAG_MISSING item severs its dead PM link, dismisses the pending
			 * FLAG_MISSING row, and forces an initial push (bulk Re-push). Defaults
			 * to false (plain bulk retry). FLAG_MISSING-only is enforced by the FE,
			 * which never sends a non-FLAG_MISSING row to a Re-push batch.
			 */
			unlinkFirst: z.boolean().default(false),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			enqueuedCount: z.number(),
			results: z.array(
				z.object({
					id: z.string(),
					itemType: ItemTypeSchema,
					enqueued: z.boolean(),
					workflowId: z.string().optional(),
					reason: z.string().optional(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		if (input.items.length === 0) {
			return { enqueuedCount: 0, results: [] };
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Stories are the only work-item rows — legacy `epic`/`feature` item
		// types can't resolve a row (the folder tables were dropped), so they
		// are filtered out here.
		const storyIds = input.items
			.filter((i) => i.itemType === "story" || i.itemType === "bug")
			.map((i) => i.id);

		// Widen the ownership pre-filter to carry each owned story's current PM
		// link so the `unlinkFirst` path can sever it with the row's stored
		// provenance (the same atomic predicate the single-item path uses).
		// Cross-tenant / missing items are dropped from `filtered` (never
		// reported), matching the existing behavior.
		const ownedStories =
			storyIds.length > 0
				? await db.userStory.findMany({
						where: {
							id: { in: storyIds },
							projectId: input.projectId,
						},
						select: {
							id: true,
							externalId: true,
							externalMcpServerId: true,
						},
					})
				: ([] as Array<{
						id: string;
						externalId: string | null;
						externalMcpServerId: string | null;
					}>);
		const ownedStoryById = new Map(ownedStories.map((s) => [s.id, s]));

		const filtered = input.items.filter(
			(item) =>
				(item.itemType === "story" || item.itemType === "bug") &&
				ownedStoryById.has(item.id),
		);

		const settled = await Promise.allSettled(
			filtered.map((item) => {
				const owned = ownedStoryById.get(item.id);
				return retryPmSyncItem({
					itemId: item.id,
					itemType: item.itemType,
					projectId: input.projectId,
					userId: user.id,
					unlinkFirst: input.unlinkFirst,
					externalId: owned?.externalId ?? null,
					externalMcpServerId: owned?.externalMcpServerId ?? null,
				});
			}),
		);

		const results = filtered.map((item, idx) => {
			const entry = settled[idx];
			if (entry?.status === "fulfilled") {
				return {
					id: item.id,
					itemType: item.itemType,
					enqueued: entry.value.enqueued,
					workflowId: entry.value.workflowId,
					reason: entry.value.reason,
				};
			}
			return {
				id: item.id,
				itemType: item.itemType,
				enqueued: false,
				reason: "temporal-error",
			};
		});

		const enqueuedCount = results.filter((r) => r.enqueued).length;
		return { enqueuedCount, results };
	});
