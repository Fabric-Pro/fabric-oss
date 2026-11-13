/**
 * The two external research tools, `web_search` and `read_url`. Both call
 * the web app's internal web-research endpoint with the run's AI token; the
 * endpoint verifies the token, applies the privacy filter and the URL
 * policy, and talks to the search and fetch providers.
 *
 * Each tool returns `[text, artifact]`. The text is what the model reads:
 * external text only inside an envelope it cannot close, and errors only as
 * short instructions on whether to try again. The artifact tells the tool
 * node how the call ended, so the run's research outcome is counted from
 * graph state rather than from anything kept here. Every return path must
 * return that tuple: with `content_and_artifact`, a bare string throws.
 *
 * The run's own limits are not checked here: the tool node decides which
 * calls run at all. The endpoint's cap per research grant arrives as an
 * answer like any other and is mapped here. Authorization is checked again,
 * so a call that reaches a tool some other way still cannot reach the
 * network.
 */

import { type ToolRuntime, tool } from "@langchain/core/tools";
import { errorLogFields } from "@repo/agent-core";
import { logger } from "@repo/logs";
import { z } from "zod";
import { normalizeResearchSourceUrl } from "../prompts/web-research-evidence";
import type { AgentState } from "../state";
import { getApiUrl, internalApiFailure } from "./internal-api";
import {
	type ExternalSearchResult,
	formatExternalSearchResults,
	formatExternalSource,
	isWebResearchAllowed,
	READ_URL_TOOL_NAME,
	urlForRead,
	WEB_RESEARCH_GRANT_LIMIT_TEXT,
	WEB_RESEARCH_LIMITS,
	WEB_SEARCH_TOOL_NAME,
	type WebResearchArtifact,
	type WebResearchCallStatus,
	type WebResearchSource,
	type WebResearchToolName,
} from "./web-research";

type ToolResult = [string, WebResearchArtifact];

const WEB_RESEARCH_ENDPOINT = "/api/internal/web-research-tools";

/** Longest piece of the endpoint's own error message passed on to the model. */
const MAX_SERVER_MESSAGE_CHARS = 300;

const NOT_AUTHORIZED_TEXT =
	"Web research is not authorized for this action. Do not call web_search or read_url in this run; continue with the context you already have.";

const SEARCH_LEADS_LINE =
	"Search results are leads, not evidence: cite only pages you have read with read_url, and read_url accepts only URLs from this run's search results.";

function result(
	kind: WebResearchToolName,
	status: WebResearchCallStatus,
	text: string,
): ToolResult {
	return [text, { kind, status }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** The host of a URL for a log line; never its path or query. */
function urlHost(url: string): string | undefined {
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}

/** The endpoint's own error message, on one line and capped. */
function serverMessage(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const line = value.replace(/\s+/g, " ").trim();
	return line ? line.slice(0, MAX_SERVER_MESSAGE_CHARS) : undefined;
}

/** How a call to the endpoint ended, before it is put into words. */
type EndpointResponse =
	| { type: "ok"; body: Record<string, unknown> }
	| {
			type: "error";
			status: number;
			code: string | undefined;
			message: string | undefined;
	  }
	| { type: "unreachable"; timedOut: boolean; error: unknown };

/**
 * Posts one research call. Every way it can go wrong, a body that is not JSON
 * included, comes back as a value, never as a throw, so the model never sees
 * a raw exception message.
 */
async function callWebResearchEndpoint(
	toolName: WebResearchToolName,
	projectId: string,
	aiToken: string,
	args: Record<string, unknown>,
): Promise<EndpointResponse> {
	try {
		const response = await fetch(`${getApiUrl()}${WEB_RESEARCH_ENDPOINT}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AI-Token": aiToken,
			},
			body: JSON.stringify({ toolName, projectId, args }),
			signal: AbortSignal.timeout(WEB_RESEARCH_LIMITS.fetchTimeoutMs),
		});
		if (response.status === 401) {
			return {
				type: "error",
				status: 401,
				code: undefined,
				message: undefined,
			};
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = undefined;
		}
		if (response.ok && isRecord(body) && body.ok === true) {
			return { type: "ok", body };
		}
		const record = isRecord(body) ? body : {};
		return {
			type: "error",
			status: response.status,
			code:
				typeof record.code === "string"
					? record.code.slice(0, 64)
					: undefined,
			message: serverMessage(record.message),
		};
	} catch (error) {
		const name = isRecord(error) ? error.name : undefined;
		return {
			type: "unreachable",
			timedOut: name === "TimeoutError" || name === "AbortError",
			error,
		};
	}
}

/**
 * What the model is told when the endpoint did not return a result, and
 * whether the call counts as a failure (`failed`: availability) or as a
 * refusal it can act on (`rejected`: policy).
 *
 * Availability failures: no answer, a 401, a 403, any 409 (research is
 * switched off, or the organization's provider key cannot be used), a
 * missing endpoint, a 5xx. Policy rejections: a 400, a 422, and a 429, the
 * endpoint's cap for this research grant; the 429's artifact also carries
 * `limitReached`, so the run's outcome reports the limit as reached.
 */
function endpointFailure(
	toolName: WebResearchToolName,
	response: Exclude<EndpointResponse, { type: "ok" }>,
): ToolResult {
	if (response.type === "unreachable") {
		logger.warn(`[ToolNode] ${toolName} request failed`, {
			...errorLogFields(response.error),
			timedOut: response.timedOut,
		});
		const what = response.timedOut
			? "did not respond in time"
			: "could not be reached";
		return result(
			toolName,
			"failed",
			`${toolName} failed: the research service ${what}. You may try once more while the research limit allows; otherwise continue without it.`,
		);
	}

	const { status, code, message } = response;
	logger.warn(`[ToolNode] ${toolName} returned an error`, { status, code });

	if (status === 401 || code === "INVALID_TOKEN") {
		return result(toolName, "failed", internalApiFailure(toolName, 401));
	}
	// 404, 405 and 501 mean the endpoint itself is missing on this
	// deployment; every further call would fail the same way.
	if (
		status === 403 ||
		status === 404 ||
		status === 405 ||
		status === 409 ||
		status === 501 ||
		code === "RESEARCH_NOT_AUTHORIZED" ||
		code === "PROJECT_ACCESS_DENIED" ||
		code === "RESEARCH_UNAVAILABLE"
	) {
		return result(
			toolName,
			"failed",
			"Web research is not available for this run. Do not call web_search or read_url again in this run; continue with the context you already have.",
		);
	}
	// Checked before the codes below so a 429 without a JSON body still
	// reads as the cap and not as a failure worth retrying.
	if (status === 429 || code === "RESEARCH_LIMIT_REACHED") {
		return [
			WEB_RESEARCH_GRANT_LIMIT_TEXT,
			{ kind: toolName, status: "rejected", limitReached: true },
		];
	}
	const reason = message ? ` (${message})` : "";
	if (code === "QUERY_REJECTED_CONFIDENTIAL") {
		return result(
			toolName,
			"rejected",
			`The search query was refused because it looked like it contained confidential information${reason}. Search again naming only the public topic: no organization, project, client, person or internal figures.`,
		);
	}
	if (code === "URL_NOT_ALLOWED") {
		return result(
			toolName,
			"rejected",
			`This URL may not be read${reason}. Do not try this URL again; read another result or continue without it.`,
		);
	}
	if (status === 400 || code === "INVALID_REQUEST") {
		return result(
			toolName,
			"rejected",
			`The ${toolName} arguments were invalid${reason}. Fix or shorten them before calling ${toolName} again.`,
		);
	}
	if (status === 422) {
		return result(
			toolName,
			"rejected",
			`The research service refused this call${reason}. Do not repeat the same call.`,
		);
	}
	return result(
		toolName,
		"failed",
		`${toolName} failed${status >= 400 ? ` (HTTP ${status})` : ""}. You may try once more while the research limit allows; otherwise continue without it.`,
	);
}

/**
 * The endpoint call shared by both tools: the authorization recheck, the
 * run's project and token, the request, and the mapping of any failure.
 * `onOk` turns a successful response body into the tool's result.
 */
async function runWebResearchCall(
	toolName: WebResearchToolName,
	args: Record<string, unknown>,
	runtime: ToolRuntime<AgentState>,
	onOk: (body: Record<string, unknown>) => ToolResult,
): Promise<ToolResult> {
	const configurable = runtime.configurable as
		| Record<string, unknown>
		| undefined;
	if (!isWebResearchAllowed(runtime.state, configurable)) {
		logger.warn(`[ToolNode] ${toolName} refused: research not authorized`);
		return result(toolName, "rejected", NOT_AUTHORIZED_TEXT);
	}
	const projectId = runtime.state.projectId;
	const aiToken = configurable?.ai_token;
	if (!projectId || typeof aiToken !== "string") {
		logger.warn(
			`[ToolNode] ${toolName} skipped: missing project or token`,
			{
				hasProjectId: !!projectId,
			},
		);
		return result(
			toolName,
			"failed",
			`${toolName} skipped: missing project context. Continue without web research.`,
		);
	}
	const response = await callWebResearchEndpoint(
		toolName,
		projectId,
		aiToken,
		args,
	);
	return response.type === "ok"
		? onOk(response.body)
		: endpointFailure(toolName, response);
}

/**
 * Runs a tool body so that nothing it does can throw past it: a throw would
 * reach the model as a raw exception message and leave the call without an
 * artifact.
 */
async function guarded(
	toolName: WebResearchToolName,
	run: () => Promise<ToolResult>,
): Promise<ToolResult> {
	try {
		return await run();
	} catch (error) {
		logger.warn(`[ToolNode] ${toolName} failed`, errorLogFields(error));
		return result(
			toolName,
			"failed",
			`${toolName} failed. You may try once more while the research limit allows; otherwise continue without it.`,
		);
	}
}

function clampMaxResults(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return WEB_RESEARCH_LIMITS.defaultResultsPerSearch;
	}
	return Math.min(
		WEB_RESEARCH_LIMITS.maxResultsPerSearch,
		Math.max(1, Math.trunc(value)),
	);
}

function searchResults(body: Record<string, unknown>): ExternalSearchResult[] {
	const raw = Array.isArray(body.results) ? body.results : [];
	return raw
		.filter(
			(entry): entry is Record<string, unknown> =>
				isRecord(entry) && typeof entry.url === "string" && !!entry.url,
		)
		.slice(0, WEB_RESEARCH_LIMITS.maxResultsPerSearch)
		.map((entry) => ({
			url: entry.url as string,
			title: optionalString(entry.title),
			snippet: optionalString(entry.snippet),
			publishedDate: optionalString(entry.publishedDate),
		}));
}

export const webSearchTool = tool(
	async (
		{ query, maxResults },
		runtime: ToolRuntime<AgentState>,
	): Promise<ToolResult> =>
		guarded(WEB_SEARCH_TOOL_NAME, async () => {
			const limit = clampMaxResults(maxResults);
			logger.info(`[ToolNode] Executing ${WEB_SEARCH_TOOL_NAME}`, {
				queryLength: query.length,
				maxResults: limit,
			});
			// Checked here rather than in the schema, so a bad argument is a
			// refusal the model can act on, like the endpoint's own 400, and
			// not a failure of the research service.
			if (
				!query.trim() ||
				query.length > WEB_RESEARCH_LIMITS.maxQueryChars
			) {
				return result(
					WEB_SEARCH_TOOL_NAME,
					"rejected",
					`The search query must be 1 to ${WEB_RESEARCH_LIMITS.maxQueryChars} characters naming only the public topic. Shorten it before searching again.`,
				);
			}
			return runWebResearchCall(
				WEB_SEARCH_TOOL_NAME,
				{ query, maxResults: limit },
				runtime,
				(body): ToolResult => {
					const results = searchResults(body);
					logger.info(
						`[ToolNode] ${WEB_SEARCH_TOOL_NAME} returned results`,
						{
							resultCount: results.length,
						},
					);
					return [
						`${SEARCH_LEADS_LINE}\n${formatExternalSearchResults(results)}`,
						{
							kind: WEB_SEARCH_TOOL_NAME,
							status: "ok",
							urls: results.map((entry) => entry.url),
						},
					];
				},
			);
		}),
	{
		name: WEB_SEARCH_TOOL_NAME,
		responseFormat: "content_and_artifact",
		description: `Search the public web for evidence relevant to this document. Name only the public topic in the query, never the organization, project, client or internal figures. Results are leads, not evidence: read a result with read_url before citing it. At most ${WEB_RESEARCH_LIMITS.maxSearches} searches per run.`,
		schema: z.object({
			query: z
				.string()
				.describe(
					`Public-topic search query, at most ${WEB_RESEARCH_LIMITS.maxQueryChars} characters`,
				),
			maxResults: z
				.number()
				.optional()
				.describe(
					`Number of results (default ${WEB_RESEARCH_LIMITS.defaultResultsPerSearch}, max ${WEB_RESEARCH_LIMITS.maxResultsPerSearch})`,
				),
		}),
	},
);

export const readUrlTool = tool(
	async ({ url }, runtime: ToolRuntime<AgentState>): Promise<ToolResult> =>
		guarded(READ_URL_TOOL_NAME, async () => {
			logger.info(`[ToolNode] Executing ${READ_URL_TOOL_NAME}`, {
				host: urlHost(url),
			});
			if (url.length > WEB_RESEARCH_LIMITS.maxUrlChars) {
				return result(
					READ_URL_TOOL_NAME,
					"rejected",
					"This URL is too long to read. Read another result from this run's searches.",
				);
			}
			const requestedUrl = urlForRead(url);
			return runWebResearchCall(
				READ_URL_TOOL_NAME,
				{ url: requestedUrl },
				runtime,
				(body): ToolResult => {
					const pageUrl =
						optionalString(body.finalUrl) ?? requestedUrl;
					const content =
						typeof body.content === "string" ? body.content : "";
					// A page without text supports nothing, so it is no source.
					if (!content.trim()) {
						logger.warn(
							`[ToolNode] ${READ_URL_TOOL_NAME} returned no page text`,
							{ host: urlHost(pageUrl) },
						);
						return result(
							READ_URL_TOOL_NAME,
							"failed",
							"read_url returned no readable text for this page. Read another result or continue without it.",
						);
					}
					const publisher = optionalString(body.publisher);
					const publishedDate = optionalString(body.publishedDate);
					const truncated =
						body.truncated === true ||
						content.length > WEB_RESEARCH_LIMITS.maxContentChars;
					logger.info(
						`[ToolNode] ${READ_URL_TOOL_NAME} returned a page`,
						{
							host: urlHost(pageUrl),
							contentLength: content.length,
							truncated,
						},
					);
					// The page is cited by this URL, in the same form the research
					// facts list it: Markdown-safe, without credentials or a
					// fragment. A final URL whose query carries a token or a
					// signature has none, so the page is read but never cited.
					const citableUrl = normalizeResearchSourceUrl(pageUrl);
					const envelope = formatExternalSource({
						url: citableUrl ?? "",
						title: optionalString(body.title),
						publisher,
						author: optionalString(body.author),
						publishedDate,
						content,
					});
					const notes = [
						...(truncated
							? [
									"Only the beginning of this page was read; it was longer than the read limit.",
								]
							: []),
						...(citableUrl
							? []
							: [
									"This page's address carries a credential or signed token, or is not a web address, so do not cite or link it.",
								]),
					];
					const text = [envelope, ...notes].join("\n");
					if (!citableUrl) {
						return [
							text,
							{
								kind: READ_URL_TOOL_NAME,
								status: "ok",
								withheld: true,
							},
						];
					}
					const source: WebResearchSource = {
						url: citableUrl,
						...(publisher
							? {
									publisher: publisher.slice(
										0,
										WEB_RESEARCH_LIMITS.maxAttributeChars,
									),
								}
							: {}),
						...(publishedDate
							? {
									publishedDate: publishedDate.slice(
										0,
										WEB_RESEARCH_LIMITS.maxAttributeChars,
									),
								}
							: {}),
					};
					return [
						text,
						{ kind: READ_URL_TOOL_NAME, status: "ok", source },
					];
				},
			);
		}),
	{
		name: READ_URL_TOOL_NAME,
		responseFormat: "content_and_artifact",
		description: `Read a page that web_search returned in this run, to use it as evidence. Only URLs from this run's search results can be read. At most ${WEB_RESEARCH_LIMITS.maxReads} reads per run.`,
		schema: z.object({
			url: z
				.string()
				.describe("A URL from this run's web_search results"),
		}),
	},
);
