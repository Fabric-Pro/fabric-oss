import { ORPCError } from "@orpc/client";
import { NOTION_EMPTY_CONTENT } from "@repo/utils/notion-error-reasons";

export const NOTION_ADD_FALLBACK_MESSAGE =
	"Fabric could not add this Notion page. Try again.";

/** Select client-written copy using the structured refusal reason. */
export function notionAddErrorMessage(err: unknown): string {
	if (
		err instanceof ORPCError &&
		err.code === "BAD_REQUEST" &&
		err.data?.reason === NOTION_EMPTY_CONTENT
	) {
		return "Fabric could not read any content from this Notion page.";
	}
	return NOTION_ADD_FALLBACK_MESSAGE;
}
