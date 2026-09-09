/**
 * Read the working draft a refinement run revises (Fizzy #1851, slice A7).
 *
 * ## Why the server reads it
 *
 * The client knows the draft body — it is rendering it in an editor — and
 * sending it up would save a query. It is not sent. A generation prompt is the
 * one place in this feature where arbitrary caller text becomes the model's
 * instruction set, and an endpoint that accepted a body would let any project
 * member put text of their choosing into a run attributed to the organization's
 * key and quota, with the stored draft recording it as a refinement of the
 * saved work. So the server reads the saved body from its own store, scoped by
 * `{ topicId, projectId }` exactly as the page's own read is, and the client
 * only says WHICH content type and WHETHER this is a refinement.
 *
 * This is the same rule `adoptBlogPostDraft` follows for the same reason: the
 * client names a candidate, the server reads the text.
 *
 * NOTE on scoping: `listTopicDrafts` filters on both ids but does NOT take the
 * Project row lock the writers take. That is correct here — a refinement writes
 * nothing to the working draft, so there is no lost update to prevent, and the
 * worst a concurrent edit can do is make this run revise the text as it stood a
 * moment earlier. The result lands as a NEW candidate the reader compares
 * against what is saved, which is where that difference becomes visible.
 */

import { ORPCError } from "@orpc/client";
import { type DraftPostType, listTopicDrafts } from "@repo/database";
import { clampCurrentDraft } from "@repo/utils/publishing-refinement";

export interface RefinementSourceInput {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	/**
	 * How to name the missing draft in the error, in the wording the rest of the
	 * family uses ("blog post", "case study"). The panel only offers the action
	 * when a draft exists, so reaching the error means a stale tab.
	 */
	label: string;
}

/**
 * The saved body for one content type, clamped for the prompt, or a NOT_FOUND.
 *
 * Clamped HERE and again in `buildRefinementSection`. The two bounds protect
 * different things: this one keeps a long body out of the workflow's arguments
 * and so out of Temporal's history, the other protects the prompt from a value
 * that reaches it by some other route.
 */
export async function readRefinementSource(
	input: RefinementSourceInput,
): Promise<string> {
	const { workingDrafts } = await listTopicDrafts({
		topicId: input.topicId,
		projectId: input.projectId,
	});
	const working = workingDrafts.find((w) => w.postType === input.postType);
	const body = clampCurrentDraft(working?.hasBody ? working.body : null);
	if (body === null) {
		throw new ORPCError("NOT_FOUND", {
			message: `No saved ${input.label} to refine.`,
		});
	}
	return body;
}
