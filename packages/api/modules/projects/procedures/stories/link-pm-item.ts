import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { linkPmItem } from "../../lib/link-pm-item";

/**
 * Link to existing item for a story: link an unlinked story to a PM item
 * that already exists (the one a create Fabric could not confirm made), and
 * clear the story's create claim. Nothing is created or pushed. Backs the
 * failure panel's "Link to existing item" action; see `linkPmItem`.
 */
export const linkStoryPmItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/link-pm-item",
		tags: ["Projects", "Stories"],
		summary: "Link a story to an existing PM item",
		description:
			"Links an unlinked story to a PM item that already exists, after reading the item through the project's PM connection, and clears the story's pending create. Nothing is created or pushed. Refused when the story is already linked, a sync of it is in progress, the item is not found or cannot be read, the item is in another Azure DevOps project, or the item is already linked to another story.",
	})
	.input(
		z.object({
			projectId: z.string().cuid(),
			storyId: z.string().cuid(),
			externalId: z
				.string()
				.trim()
				.min(1, "Enter the PM item's ID")
				.max(200),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			linked: z.literal(true),
			externalId: z.string(),
			externalUrl: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) =>
		linkPmItem({
			row: { storyId: input.storyId },
			projectId: input.projectId,
			externalId: input.externalId,
			userId: context.user.id,
		}),
	);
