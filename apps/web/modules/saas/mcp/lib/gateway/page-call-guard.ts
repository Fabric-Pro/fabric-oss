/**
 * Holding a call a page makes to the rules of the page, on the server.
 *
 * A page's script has no network: it reaches Fabric only through the host page,
 * which calls the gateway as the viewer and adds the page's id on
 * `x-fabric-page-frame`. The host also refuses what a page may not do, but a
 * rule enforced only where the page runs is a rule the next bug in the host
 * removes, so the gateway repeats it. On that header a call is refused when:
 *
 *   - the tool is one a page may never call (`NOT_FOR_PAGES`);
 *   - the tool is not a Fabric platform tool: the discovery meta-tools, which
 *     run any tool by name, and a connected server's own tools are never a
 *     page's to call, whatever its stored `runtimeTools` say;
 *   - the page does not declare the tool in its stored `runtimeTools`;
 *   - a tool of the page's own store, viewer, files or comments names another
 *     page. Those tools are about one page, so the page's id is the `frameId`
 *     whatever the call said, and a page cannot reach another page's data;
 *   - the viewer cannot open the page, or it has no runtime (not on a surface).
 *
 * The header only ever narrows a call. Any other caller can send it too, and
 * all it gets is the same limits.
 */

import {
	declarationOf,
	isPageScopedTool,
	NOT_FOR_PAGES,
} from "@repo/temporal/fabric-page-tool-definitions";
import { errorResult } from "./tool-results";
import { accessibleFrame } from "./tools/frame-context";
import type { GatewaySession, ToolCallResult } from "./types";

const PAGE_FRAME_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type PageCallCheck =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; result: ToolCallResult };

/**
 * Checks one call that arrived with a page's id, and answers with the
 * arguments to run it with (the page's own id filled in for a page-scoped
 * tool) or the refusal to return, which carries a `reason` to branch on.
 */
export async function checkPageCall(
	pageFrameId: string,
	toolName: string,
	args: Record<string, unknown>,
	session: Pick<GatewaySession, "userId" | "email" | "organizationId">,
	isPlatformTool: (name: string) => boolean,
): Promise<PageCallCheck> {
	if (!PAGE_FRAME_ID_PATTERN.test(pageFrameId)) {
		return {
			ok: false,
			result: errorResult("The page this call is for is not valid.", {
				reason: "invalid_page_frame",
			}),
		};
	}
	if (NOT_FOR_PAGES.has(toolName)) {
		return {
			ok: false,
			result: errorResult(`${toolName} cannot be called from a page.`, {
				reason: "tool_not_for_pages",
			}),
		};
	}
	if (!isPlatformTool(toolName)) {
		return {
			ok: false,
			result: errorResult(
				`${toolName} is not a Fabric tool a page can call.`,
				{
					reason: "not_a_platform_tool",
				},
			),
		};
	}
	if (
		isPageScopedTool(toolName) &&
		args.frameId !== undefined &&
		args.frameId !== null &&
		args.frameId !== pageFrameId
	) {
		return {
			ok: false,
			result: errorResult("A page can only reach its own data.", {
				reason: "other_page",
			}),
		};
	}

	const frame = await accessibleFrame(pageFrameId, session);
	if (!frame) {
		return {
			ok: false,
			result: errorResult("Page not found.", {
				reason: "page_not_found",
			}),
		};
	}
	if (!frame.surface) {
		return {
			ok: false,
			result: errorResult(
				"This page is not on a surface, so it has no runtime.",
				{ reason: "page_has_no_runtime" },
			),
		};
	}
	const declaration = declarationOf(toolName, args);
	if (
		declaration === undefined ||
		!frame.runtimeTools.includes(declaration)
	) {
		return {
			ok: false,
			result: errorResult(
				`This page does not declare ${declaration ?? toolName}.`,
				{ reason: "tool_not_declared" },
			),
		};
	}
	return {
		ok: true,
		args: isPageScopedTool(toolName)
			? { ...args, frameId: frame.id }
			: args,
	};
}
