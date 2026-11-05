import { z } from "zod";

/**
 * What `fabric_page_comment_list` returns for a page, as the comments panel
 * reads it: oldest first, one page at a time, the next page the newer comments.
 * The tool is the one source of truth; the schema is what the client checks
 * every answer against before the panel draws it. A comment is what a person
 * wrote, shown as text and never as markup.
 */

const PageCommentSchema = z.object({
	id: z.string(),
	text: z.string(),
	at: z.string(),
	author: z.object({ id: z.string(), name: z.string() }),
});

export const PageCommentListSchema = z.object({
	comments: z.array(PageCommentSchema),
	nextCursor: z.string().nullish(),
});

export const pageCommentsKey = (
	organizationId: string | null,
	frameId: string,
) =>
	[
		"fabric-tool",
		organizationId,
		"fabric_page_comment_list",
		{ frameId },
		"pages",
	] as const;
