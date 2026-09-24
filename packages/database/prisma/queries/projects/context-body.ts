import { sliceUnicodeCharacters } from "../../../src/project-context-presentation";
import { getCrawledUrlSourceMarkdownPage } from "./contexts";
import { getCapturedConversationMarkdown } from "./conversation-bundles";

interface ContextBodyRow {
	id: string;
	type: string;
	urlScope: string | null;
	content: string | null;
}

interface ContextBodyPage {
	/** This page of the body. */
	content: string;
	/** The whole body's length, in Unicode characters. */
	contentLength: number;
	offset: number;
	returnedLength: number;
	truncated: boolean;
	/** Where the next page starts; set only when `truncated`. */
	nextOffset?: number;
	/** False for an empty or whitespace-only body. */
	hasReadableText: boolean;
}

/**
 * Read one page of a project context's body, wherever that body lives.
 *
 * Two kinds of row keep their text somewhere other than `content`. A
 * PATH_PREFIX URL source scatters its markdown across child page rows, read
 * with a SQL-side slice so an offset read does not transfer every child body.
 * A monitored Teams or Slack channel is a pointer whose captured conversation
 * lives in `ProjectContextConversationBundle` (Fizzy #2228); with nothing
 * captured it falls back to the row's own (usually empty) `content`.
 *
 * The bundle text arrives already neutralized against prompt injection: the
 * capture path applies the guard before the row write so every derived copy
 * inherits it. Nothing is re-applied here.
 *
 * Blank is not the same as non-empty: a scanned PDF extracts to whitespace
 * and is reported as having no readable text.
 *
 * `tenant` must carry the project's HOSTING organization, not the caller's —
 * an invited guest works from their own organization while every child row
 * of the project carries the host's. Authorization is the caller's job.
 */
export async function readProjectContextBodyPage(
	ctx: ContextBodyRow,
	tenant: { userId: string; organizationId?: string | null },
	page: { offset: number; maxLength: number },
): Promise<ContextBodyPage> {
	let body = "";
	let crawled:
		| { content: string; contentLength: number; hasReadableText: boolean }
		| undefined;
	if (ctx.type === "LINK" && ctx.urlScope === "PATH_PREFIX") {
		crawled = await getCrawledUrlSourceMarkdownPage(ctx.id, tenant, page);
	} else if (ctx.type === "INTEGRATION") {
		const captured = await getCapturedConversationMarkdown(ctx.id, tenant);
		body = captured.length > 0 ? captured : (ctx.content ?? "");
	} else {
		body = ctx.content ?? "";
	}

	const local = crawled
		? undefined
		: sliceUnicodeCharacters(body, page.offset, page.maxLength);
	const content = crawled?.content ?? local?.content ?? "";
	const contentLength = crawled?.contentLength ?? local?.contentLength ?? 0;
	const returnedLength = Array.from(content).length;
	const truncated = page.offset + returnedLength < contentLength;
	return {
		content,
		contentLength,
		offset: page.offset,
		returnedLength,
		truncated,
		...(truncated ? { nextOffset: page.offset + returnedLength } : {}),
		hasReadableText: crawled
			? crawled.hasReadableText
			: body.trim().length > 0,
	};
}
