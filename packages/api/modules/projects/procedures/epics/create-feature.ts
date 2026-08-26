import { logger } from "@repo/logs";
import { createStoryFromProposal } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";

/**
 * Creates a "feature" as a ROADMAP WORK ITEM (`user_story`, kind=FEATURE).
 *
 * The Epic/Feature container tables were removed — `user_story` is the only
 * work-item table — so this endpoint now produces exactly what the manual
 * "Add feature" button produces. The route and the `{ feature }` response key
 * are preserved for existing API/SDK/CLI callers; `epicId` is accepted but
 * ignored (containers no longer exist).
 */
export const createFeatureProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/features",
		tags: ["Projects", "Features"],
		summary: "Create feature",
		description:
			"Create a feature as a roadmap work item (user story with kind=FEATURE).",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** DEPRECATED — Epic containers were removed; accepted and ignored. */
			epicId: z.string().optional(),
			title: z.string().min(1).max(500),
			description: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (input.epicId) {
			logger.warn(
				"[createFeature] epicId ignored — Epic containers were removed",
				{ projectId: input.projectId, epicId: input.epicId },
			);
		}

		// Same path as the manual "Add feature" button. The caller explicitly
		// asked for a feature, so the classifier is skipped; drafting is
		// skipped so the provided description is persisted verbatim.
		const { story } = await createStoryFromProposal({
			projectId: input.projectId,
			organizationId,
			createdById: user.id,
			title: input.title,
			description: input.description,
			kind: "FEATURE",
			skipClassifier: true,
			skipDrafting: true,
			source: "MANUAL",
			reporterName: user.name ?? null,
			reporterSource: "MANUAL",
			reporterSourceUrl: null,
		});

		return { feature: stripInternalStoryFields(story) };
	});
