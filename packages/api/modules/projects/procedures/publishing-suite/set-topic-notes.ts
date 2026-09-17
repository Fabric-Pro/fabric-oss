import { ORPCError } from "@orpc/client";
import { setPublishingTopicNotes } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * Save a topic's PRIVATE NOTEBOOK (`notes`) — the person's own working text
 * about a topic, and the one field on the model the AI never touches.
 *
 * The same notebook model as `stories.maturation.setWorkingNotes`, and like it
 * this is the ONLY writer. The difference is the reach of the promise: there
 * the AI reads the notes and merely never writes them, here it does neither.
 * The UI says so in as many words, which makes it a contract rather than a
 * current fact — `notes` must stay out of every prompt variable builder, every
 * planning/draft context, and every AI-facing select.
 *
 * No companion read procedure: `getTopic` returns the query layer's topic
 * straight through, and the page already calls it on load.
 */
export const setPublishingTopicNotesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/notes",
		tags: ["Projects", "Publishing Suite"],
		summary: "Save a publishing topic's private notes",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Empty string clears the notes; the cap matches a generous
			// notebook, the same one `setWorkingNotes` allows.
			notes: z.string().max(50_000),
		}),
	)
	.output(z.object({ saved: z.boolean() }))
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		// AUTHORIZATION: as `update-topic-summary.ts` — the DB helper re-scopes
		// the write to { id: topicId, projectId }, no tenant column is written,
		// and `input.organizationId` is an F2 client-org shape guard that is
		// never read. A cross-project id matches nothing and returns the same
		// NOT_FOUND a missing topic does.
		//
		// Trimmed to TEST emptiness, stored UNTRIMMED. A notebook whose trailing
		// blank line disappears on every save is one that fights the person
		// typing in it, and only whitespace-all-the-way-down means "cleared".
		// Mirrors `setWorkingNotes` exactly.
		const trimmed = input.notes.trim();
		const count = await setPublishingTopicNotes({
			id: input.topicId,
			projectId: input.projectId,
			notes: trimmed.length > 0 ? input.notes : null,
		});
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		return { saved: true };
	});
