/**
 * Fabric MCP Gateway - Page tools
 *
 * What a page can do beyond reading Fabric: know who is viewing it, keep data,
 * ask the model, hold files, read the viewer's connected servers and carry
 * comments. A page's script calls these through the host page as whoever views
 * it, with its own id on `x-fabric-page-frame`; the Fabric Agent calls the same
 * tools with the open Workspace as the default page (`frameId`).
 *
 * Every tool is about one page, and every handler starts by opening it as the
 * caller: a person who cannot open the page can do nothing to it, and what a
 * person may do to a page they can open is decided in the handler (the owner's
 * own tools), never by the page. The definitions are Fabric's one list
 * (`@repo/temporal/fabric-page-tool-definitions`). This module holds the viewer
 * and the connected read; the store, files, comments and ask are in their own
 * modules beside it.
 */

import { canUpdateOrganizationFrames } from "@repo/database";
import {
	connectedDeclaration,
	FABRIC_PAGE_TOOL_DEFINITIONS,
} from "@repo/temporal/fabric-page-tool-definitions";
import { readConnectedTool } from "../connected-reads";
import { errorResult, jsonResult } from "../tool-results";
import { nonEmptyString, plainObjectOf } from "./frame-context";
import { PAGE_ASK_HANDLERS } from "./page-ask-tool";
import { PAGE_COMMENT_HANDLERS } from "./page-comment-tools";
import { PAGE_DATA_HANDLERS } from "./page-data-tools";
import { PAGE_FILE_HANDLERS } from "./page-file-tools";
import { handleGetReviewOptions } from "./page-review-options";
import {
	handleConfigureStoryReview,
	handleGetStoryReview,
	handleListStoryReviewRuns,
	handleRunStoryReview,
} from "./page-story-review";
import { noInput, pageTool, refuse } from "./page-store";
import {
	type PlatformToolHandler,
	type ToolFamily,
	toolFamily,
} from "./tool-family";

/** Up to two letters for an avatar, from the words of a name. */
function initialsOf(name: string): string {
	const letters = name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => word.charAt(0).toUpperCase())
		.join("");
	return letters || "?";
}

/**
 * Who is viewing the page, as far as the page may know: no email, no list of
 * organizations. The server stamps what viewers write with the same id and
 * name, so a page never has to trust names it is given.
 */
const handleGetPageViewer = pageTool(
	{ parse: noInput },
	async ({ page, session }) =>
		jsonResult({
			id: session.userId,
			name: session.userName,
			initials: initialsOf(session.userName),
			isOwner: page.isOwner,
			canEditPage:
				page.isOwner &&
				(await canUpdateOrganizationFrames(
					session.userId,
					page.organizationId,
				)),
		}),
);

/**
 * Runs a read the page declared on the viewer's own connected server. The page
 * is opened as the viewer and its stored declaration is checked again here, so
 * a caller that did not come through the host page is held to it too.
 */
const handleReadConnected = pageTool(
	{
		parse: (args) => {
			const provider = nonEmptyString(args.provider);
			const tool = nonEmptyString(args.tool);
			return provider && tool
				? {
						ok: true,
						value: {
							provider,
							tool,
							args: plainObjectOf(args.args),
						},
					}
				: refuse("tool", "`provider` and `tool` are required.");
		},
	},
	async ({ input, page, session }) => {
		const declaration = connectedDeclaration(input.provider, input.tool);
		if (!page.runtimeTools.includes(declaration)) {
			return errorResult(`This page does not declare ${declaration}.`, {
				reason: "tool_not_declared",
			});
		}
		return readConnectedTool({ ...input, session });
	},
);

/** The page tools, registered like every other family (see `./frame-tools`). */
export function createPageTools(): ToolFamily {
	return toolFamily(
		FABRIC_PAGE_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			["fabric_page_get_story_review", handleGetStoryReview],
			["fabric_page_configure_story_review", handleConfigureStoryReview],
			["fabric_page_run_story_review", handleRunStoryReview],
			["fabric_page_list_story_review_runs", handleListStoryReviewRuns],
			["fabric_page_get_review_options", handleGetReviewOptions],
			["fabric_get_page_viewer", handleGetPageViewer],
			["fabric_page_read_connected", handleReadConnected],
			...PAGE_DATA_HANDLERS,
			...PAGE_ASK_HANDLERS,
			...PAGE_FILE_HANDLERS,
			...PAGE_COMMENT_HANDLERS,
		]),
	);
}
