import {
	declarationOf,
	isPageScopedTool,
	NOT_FOR_PAGES,
} from "@repo/temporal/fabric-page-tool-definitions";
import {
	type ConfirmationPolicy,
	confirmationRequired,
} from "@repo/temporal/fabric-tool-definition";
import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";
import type {
	FrameRuntimeCallResult,
	FrameRuntimeRequest,
} from "./frame-embed-protocol";
import {
	askModeFor,
	type ConfirmEveryBecause,
	declaresStoreTools,
	type PageTaint,
	taintsPage,
} from "./page-approval-rules";
import { checkDownload, type PageDownload } from "./page-download";

/**
 * The host page's side of the page runtime: what happens to a request a
 * sandboxed page's script (`window.fabric`) makes. The page is code somebody
 * else may have written, running for the person looking at it, so every request
 * is a request to act as that person and is checked here, not trusted:
 *
 * - a tool is run only if the page declared it when it was saved, and never if
 *   it is one no page may call, whatever the stored page says;
 * - a page runs only for the organization the viewer is looking at, and every
 *   call is made for the page's own frame: the tools that work on a page's data
 *   get the page's own id whatever the page sent;
 * - a tool that only reads runs at once; any other asks the viewer, once per
 *   page version and tool (see `page-approval-rules` for the exceptions, among
 *   them the pages that have read outside their own store);
 * - calls are rate limited per page;
 * - the page can navigate only inside the app, and open Fabric Agent only with
 *   a draft the viewer still has to send;
 * - the page can offer the viewer a file of a few plain kinds, which they
 *   accept or not.
 *
 * Who the request came from (the right iframe, the right origin) is decided by
 * the caller before it gets here; this file knows nothing of windows.
 */

export const FRAME_RUNTIME_RATE_LIMIT = {
	maxCalls: 30,
	windowMs: 60_000,
} as const;

export const FRAME_RUNTIME_MAX_PROMPT_LENGTH = 4_000;

const FOREIGN_ORGANIZATION_ERROR =
	"This page does not belong to the organization you are viewing, so it may not call Fabric.";

const UNSAVED_PAGE_ERROR =
	"This page has not been saved in Fabric, so it may not call Fabric.";

interface ConfirmToolOptions {
	/** Ask on every call; a yes covers that call only. */
	every: boolean;
	because?: ConfirmEveryBecause;
}

const APP_PATH_PREFIX = "/app/";
const NAVIGATION_PROBE_ORIGIN = "https://app.invalid";

export interface FrameRuntimeToolInfo {
	readOnlyHint?: boolean;
	/** When the tool's own definition says to ask the person before a call. */
	confirm?: ConfirmationPolicy;
}

export interface FrameRuntimeHostOptions {
	/** The tools the page declared when it was saved. */
	runtimeTools: readonly string[];
	/**
	 * The page's own frame, which every call is made for. A page that is not
	 * saved has none, and may not call Fabric.
	 */
	frameId: string | null;
	/**
	 * Whether the page has read outside its own store, kept by whoever owns the
	 * page on screen, so a host made again for the same page does not forget it.
	 */
	taint: PageTaint;
	/** The organization the page belongs to; null when it is not known. */
	organizationId: string | null;
	/**
	 * The organization the viewer is looking at now: the one in the address of
	 * the page the shell is on. A call is made in that organization, so a page
	 * of another one is refused rather than run against it.
	 */
	viewingOrganizationId: () => string | null;
	/** What the tool list says about each tool, by name. */
	loadToolInfo: () => Promise<ReadonlyMap<string, FrameRuntimeToolInfo>>;
	/** Runs a tool as the viewer; rejects with the reason it failed. */
	callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
	/**
	 * Asks the viewer whether the page may run `toolName`, showing the call that
	 * prompted the question. Unless `every` is set it remembers a yes for the
	 * tool on this version of the page.
	 */
	confirmTool: (
		toolName: string,
		args: Record<string, unknown>,
		options: ConfirmToolOptions,
	) => Promise<boolean>;
	/** Asks the viewer whether to save a file a page offers. */
	confirmDownload: (download: PageDownload) => Promise<boolean>;
	/** Saves a file the viewer accepted. */
	saveDownload: (download: PageDownload) => void;
	openAgent: (prompt: string) => void;
	navigate: (path: string) => void;
	now?: () => number;
}

type CallRequest = Extract<FrameRuntimeRequest, { type: "fabric-frame:call" }>;
type DownloadRequest = Extract<
	FrameRuntimeRequest,
	{ type: "fabric-frame:download" }
>;

/** What came of a page's offer of a file. */
type DownloadOutcome = "saved" | "declined" | "refused";

function failure(
	requestId: string,
	error: string,
	details: { reason?: string; retryable?: boolean } = {},
): FrameRuntimeCallResult {
	return {
		type: "fabric-frame:call-result",
		requestId,
		ok: false,
		error,
		...details,
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "The tool call failed.";
}

/** The reason a tool gave for refusing, and whether to try again, when it gave them. */
function detailsOf(error: unknown): { reason?: string; retryable?: boolean } {
	if (!(error instanceof FabricToolError)) {
		return {};
	}
	return {
		...(error.reason === undefined ? {} : { reason: error.reason }),
		...(error.retryable === undefined
			? {}
			: { retryable: error.retryable }),
	};
}

/**
 * A path inside the app, normalised, or null. Anything that could leave it is
 * refused after resolving: another origin, `//host`, a scheme, a backslash, or
 * `..` segments that climb out of `/app/`.
 */
export function resolveAppPath(path: string): string | null {
	if (!path.startsWith(APP_PATH_PREFIX) || path.includes("\\")) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(path, NAVIGATION_PROBE_ORIGIN);
	} catch {
		return null;
	}
	if (
		url.origin !== NAVIGATION_PROBE_ORIGIN ||
		!url.pathname.startsWith(APP_PATH_PREFIX)
	) {
		return null;
	}
	return `${url.pathname}${url.search}${url.hash}`;
}

export function createFrameRuntimeHost(options: FrameRuntimeHostOptions) {
	const now = options.now ?? Date.now;
	const declared = new Set(options.runtimeTools);
	const keepsData = declaresStoreTools(declared);
	const { taint } = options;
	let callTimes: number[] = [];

	const withinRateLimit = () => {
		const at = now();
		callTimes = callTimes.filter(
			(time) => at - time < FRAME_RUNTIME_RATE_LIMIT.windowMs,
		);
		if (callTimes.length >= FRAME_RUNTIME_RATE_LIMIT.maxCalls) {
			return false;
		}
		callTimes.push(at);
		return true;
	};

	return {
		async handleCall(
			request: CallRequest,
		): Promise<FrameRuntimeCallResult> {
			const { requestId, name } = request;
			if (!withinRateLimit()) {
				return failure(
					requestId,
					`This page is calling Fabric too often; at most ${FRAME_RUNTIME_RATE_LIMIT.maxCalls} calls a minute.`,
				);
			}
			if (NOT_FOR_PAGES.has(name)) {
				return failure(
					requestId,
					`${name} is not available to pages, so this page may not call it.`,
				);
			}
			const declaration = declarationOf(name, request.args);
			if (declaration === undefined || !declared.has(declaration)) {
				return failure(
					requestId,
					`This page did not declare ${declaration ?? name}, so it may not call it.`,
				);
			}
			const viewing = options.viewingOrganizationId();
			if (viewing === null || viewing !== options.organizationId) {
				return failure(requestId, FOREIGN_ORGANIZATION_ERROR);
			}
			if (!options.frameId) {
				return failure(requestId, UNSAVED_PAGE_ERROR);
			}
			// The page's own id, whatever the page sent: its data, files and
			// comments are the only ones it can reach.
			const args = isPageScopedTool(name)
				? { ...request.args, frameId: options.frameId }
				: request.args;
			try {
				const toolInfo = (await options.loadToolInfo()).get(name);
				const readOnly = toolInfo?.readOnlyHint === true;
				const { mode, because } = askModeFor({
					name,
					args: request.args,
					readOnly,
					tainted: taint.isTainted(),
					declaresStoreTools: keepsData,
					confirmEveryCall: confirmationRequired(
						toolInfo?.confirm,
						request.args,
					),
				});
				if (
					mode !== "never" &&
					!(await options.confirmTool(name, request.args, {
						every: mode === "every",
						because,
					}))
				) {
					return failure(
						requestId,
						`The viewer did not allow ${name}.`,
					);
				}
				const result = await options.callTool(name, args);
				if (taintsPage(name, readOnly)) {
					taint.mark();
				}
				return {
					type: "fabric-frame:call-result",
					requestId,
					ok: true,
					result,
				};
			} catch (error) {
				return failure(requestId, messageOf(error), detailsOf(error));
			}
		},

		handleOpenAgent(prompt: string): void {
			const trimmed = prompt.trim();
			if (trimmed) {
				options.openAgent(
					trimmed.slice(0, FRAME_RUNTIME_MAX_PROMPT_LENGTH),
				);
			}
		},

		handleNavigate(path: string): void {
			const resolved = resolveAppPath(path);
			if (resolved) {
				options.navigate(resolved);
			}
		},

		/**
		 * A page offers the viewer a file. It is checked (name, kind, size), the
		 * viewer is asked, and only a yes saves it. The page is not told which.
		 */
		async handleDownload(
			request: DownloadRequest,
		): Promise<DownloadOutcome> {
			const viewing = options.viewingOrganizationId();
			if (
				!withinRateLimit() ||
				viewing === null ||
				viewing !== options.organizationId
			) {
				return "refused";
			}
			const checked = checkDownload(request);
			if (!checked.ok) {
				return "refused";
			}
			if (!(await options.confirmDownload(checked.download))) {
				return "declined";
			}
			options.saveDownload(checked.download);
			return "saved";
		},
	};
}
