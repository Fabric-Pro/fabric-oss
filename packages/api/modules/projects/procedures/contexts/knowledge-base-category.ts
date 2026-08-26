/**
 * Knowledge Base Source Category — the server half (Fizzy #2165).
 *
 * Two procedures create link context sources — `contexts.create` for
 * metadata-only rows and `contexts.processLink` for the scrape-and-index path
 * the Add Context dialog actually uses — and both validate through here so a
 * second copy of the rules cannot drift from the first.
 *
 * The values themselves live in `knowledge-base-category.types.ts`, which has no
 * imports: this file pulls in `@orpc/server` and so must not be reachable from a
 * client component.
 *
 * Optional at the API level on purpose: link sources created before this
 * classification existed have none, there is no backfill, and guessing a
 * category would report readiness the project has not earned. The requirement to
 * pick one is enforced in the UI, where the person adding the source is present
 * to answer.
 */

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { KNOWLEDGE_BASE_SOURCE_CATEGORIES } from "./knowledge-base-category.types";

/** The zod fields to spread into a link-creating procedure's input object. */
export const knowledgeBaseCategoryInputFields = {
	knowledgeBaseSourceCategory: z
		.enum(KNOWLEDGE_BASE_SOURCE_CATEGORIES)
		.optional(),
	knowledgeBaseSourceCategoryOther: z.string().max(200).optional(),
};

/**
 * "Other" without a description is not a classification, it is a shrug — and any
 * rule keyed off the category would then be reading a value that says nothing.
 * Reject it rather than store it.
 */
export function assertKnowledgeBaseCategoryIsDescribed(input: {
	knowledgeBaseSourceCategory?: string;
	knowledgeBaseSourceCategoryOther?: string;
}): void {
	if (
		input.knowledgeBaseSourceCategory === "OTHER" &&
		!input.knowledgeBaseSourceCategoryOther?.trim()
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "A description is required when the category is Other.",
		});
	}
}
