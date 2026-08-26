import { ORPCError } from "@orpc/client";
import {
	getStoryByIdWithSourceMeeting,
	hasProjectAccess,
} from "@repo/database";
import { hasPermission, Permissions as ProjectPerms } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import { userHasProjectPermission } from "../../../../lib/project-permissions";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveStoryMediaUrlsInContent } from "../../lib/resolve-story-media-urls-in-content";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";

export const getStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}",
		tags: ["Projects", "Stories"],
		summary: "Get user story",
		description: "Get a single user story by ID with tasks",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
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

		const story = await getStoryByIdWithSourceMeeting(
			input.storyId,
			input.projectId,
		);

		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Story not found",
			});
		}

		// Resolve any `story-media/...` references in the body to fresh signed
		// `<img>` URLs so images embedded by the proposal / AI flow (stored as
		// bare relative keys) render in Fabric — the same way the PM push
		// pipeline resolves them for external tools. Best-effort: returns the
		// original text on any failure (see resolve-story-media-urls-in-content).
		const [resolvedDescription, resolvedAcceptanceCriteria] =
			await Promise.all([
				resolveStoryMediaUrlsInContent(
					story.description,
					input.projectId,
					input.storyId,
				),
				resolveStoryMediaUrlsInContent(
					story.acceptanceCriteria,
					input.projectId,
					input.storyId,
				),
			]);
		// Map the raw sourceMeetingTranscript relation onto the flat `sourceMeeting`
		// shape the ProvenanceSection component consumes, preferring the linked
		// meeting series' subject over the transcript's own snapshot subject.
		// Drop the raw relation from the response so we don't leak the transcript
		// row (summary, extracted decisions, etc.) to the client.
		const { sourceMeetingTranscript, ...storyWithoutTranscript } = story;
		const resolvedStory = {
			...stripInternalStoryFields(storyWithoutTranscript),
			description: resolvedDescription ?? story.description,
			acceptanceCriteria:
				resolvedAcceptanceCriteria ?? story.acceptanceCriteria,
			sourceMeeting: sourceMeetingTranscript
				? {
						subject:
							sourceMeetingTranscript.linkedMeeting?.subject ??
							sourceMeetingTranscript.meetingSubject,
						meetingDate: sourceMeetingTranscript.meetingDate,
					}
				: null,
		};

		const canEdit = await userHasProjectPermission(
			input.projectId,
			user.id,
			ProjectPerms.STORY_UPDATE,
		);

		// Tag controls: project-authoritative (ProjectMember role overrides org
		// role), matching the tags.add/remove gates so the UI never shows a
		// control the server would reject.
		const effective = await resolveEffectiveProjectPermissions(
			input.projectId,
			user.id,
		);
		const effectivePerms = effective?.permissions ?? [];
		const canAddTags = hasPermission(
			effectivePerms,
			ProjectPerms.STORY_UPDATE,
		);
		const canManageAllTags = hasPermission(
			effectivePerms,
			ProjectPerms.STORY_DELETE,
		);

		return { story: resolvedStory, canEdit, canAddTags, canManageAllTags };
	});
