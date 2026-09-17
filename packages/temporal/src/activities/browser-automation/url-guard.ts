/**
 * Outbound guard for browser automation.
 *
 * `navigateToUrl`, the login step of `authenticate` and the workflow
 * `browser-navigate` step all drive a real Chromium to a URL the caller
 * supplied, then hand back the page title, extracted content and
 * screenshots. That is SSRF with a rendering engine attached: an ordinary
 * member aims it at cloud metadata or an internal dashboard and reads the
 * result off the page.
 *
 * A browser resolves names and opens connections on its own, so a check that
 * merely resolves the hostname first proves nothing about where Chromium
 * will connect: a name can answer a public address to the check and a
 * private one to the browser. The guard therefore never lets Chromium open
 * a connection to a host the operator has not declared:
 *
 * 1. `assertBrowserNavigationAllowed` runs before every `goto` so an obvious
 *    internal destination is refused with a reason instead of an error page.
 * 2. `installOutboundRequestGuard` routes every HTTP(S) request the context
 *    makes — the navigation itself, redirects, subresources, fetches from
 *    page script — through `safeFetchOutboundPinned` in this process, which
 *    resolves the name, refuses any private answer, and connects to the
 *    validated address it resolved. The response is handed back to Chromium
 *    (`route.fulfill`); a refusal aborts the request. A redirect is never
 *    fulfilled as a 3xx: Chromium follows a fulfilled redirect with its own
 *    network stack, without sending the next hop back through the route, so
 *    that would let any public page redirect the browser straight to an
 *    internal address. A navigation redirect to an http(s) URL is answered
 *    with a page that refreshes to the target, so Chromium's next
 *    navigation is a new request the route judges; the chain of such
 *    refreshes in one frame is counted and capped, and a 307/308 that would
 *    have to replay a non-GET body is refused rather than downgraded. A
 *    subresource redirect is followed here only within the request's own
 *    origin, under one deadline for the whole chain, each hop judged the
 *    same way; a redirect to another origin is refused, because the relay
 *    fulfills the response as if it came from the origin Chromium asked,
 *    and a cross-origin body would escape CORS, opaque-response and
 *    resource-taint checks. The relay never writes to the context's
 *    cookie store: every hop's `Set-Cookie` is handed to Chromium on the
 *    fulfilled response (see `redirect-chain-cookies.ts`). WebSockets cannot be relayed this way and
 *    are closed unless their host is declared; service workers, whose
 *    traffic Playwright routes do not intercept, are blocked by the context
 *    option set in `session-manager`. Because the guard fulfills relayed
 *    requests itself, no earlier route handler sees them: the session's
 *    resource-type blocking (`blockResources`) is therefore applied here,
 *    before the relay, rather than left to the older handler it would
 *    otherwise bypass.
 *
 * The block is unconditional and the exception is explicit, declared by
 * whoever runs the deployment rather than by whoever is making the request:
 *
 *   BROWSER_AUTOMATION_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal
 *
 * A declared host is the one case where Chromium connects on its own
 * (`route.fallback`), including for WebSockets. In production an unset
 * variable means no exceptions. Outside production it falls back to
 * loopback, so a developer can drive the browser at their own dev server
 * unconfigured while link-local and LAN addresses stay refused.
 */

import {
	createOutboundHostAllowlist,
	PINNED_FETCH_ANY_CONTENT_TYPE,
	type PinnedFetchOptions,
	safeFetchOutboundPinned,
} from "@repo/utils/url-security";
import type { BrowserContext } from "playwright";
import {
	fulfillableSetCookies,
	withHopDefaultPath,
} from "./redirect-chain-cookies";

export const BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV =
	"BROWSER_AUTOMATION_ALLOWED_HOSTS";

/** Largest response body relayed to the browser (a page, script or image). */
export const BROWSER_PINNED_FETCH_MAX_BYTES = 32 * 1024 * 1024;
/** Per-request deadline for a relayed response. */
export const BROWSER_PINNED_FETCH_TIMEOUT_MS = 30_000;
/**
 * Redirects followed in one chain: a subresource's redirects inside the
 * relay, or the refresh navigations one frame is sent through. Chromium's
 * own limit.
 */
export const BROWSER_RELAY_MAX_REDIRECTS = 20;
/** How long a frame's pending refresh continues a navigation chain. */
export const BROWSER_NAVIGATION_CHAIN_TTL_MS = 30_000;

const browserAutomationAllowlist = createOutboundHostAllowlist({
	envVar: BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV,
});

/**
 * Why this URL must not be navigated to, or `null`. Hostname check only.
 */
export function getBrowserNavigationBlockReason(
	urlString: string,
): string | null {
	return browserAutomationAllowlist.getUnsafeReason(urlString);
}

/**
 * Throw unless the browser may be pointed at this URL. Resolves the
 * hostname; refuses any DNS answer containing a private address. A
 * pre-flight courtesy so the caller gets a reason rather than an aborted
 * navigation — the request itself is still judged by the route guard.
 */
export async function assertBrowserNavigationAllowed(
	urlString: string,
): Promise<void> {
	await browserAutomationAllowlist.assertResolved(urlString);
}

/**
 * What to do with a request the browser is about to make.
 *
 * - `abort`: the destination is refused by hostname (literal private
 *   address, loopback, `.local`, a non-network scheme on a declared host).
 * - `direct`: Chromium may connect itself — the host is one the operator
 *   declared, or the URL has no network destination (`data:`, `blob:`,
 *   `about:`; Playwright does not route those anyway).
 * - `pinned`: an ordinary public host. The request is made from this
 *   process on a validated address and the response relayed; the browser
 *   never connects.
 *
 * `ws:`/`wss:` are judged like `http:`/`https:` so a WebSocket to a private
 * address is refused by the same rule.
 */
export type BrowserRequestDecision =
	| { action: "abort"; reason: string }
	| { action: "direct" }
	| { action: "pinned" };

const WEBSOCKET_TO_HTTP: Record<string, string> = {
	"ws:": "http:",
	"wss:": "https:",
};

export function decideBrowserRequest(
	urlString: string,
): BrowserRequestDecision {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		return { action: "abort", reason: "Invalid URL format" };
	}
	const httpProtocol = WEBSOCKET_TO_HTTP[url.protocol];
	if (httpProtocol) {
		url.protocol = httpProtocol;
	} else if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { action: "direct" };
	}
	const judged = url.toString();

	const reason = browserAutomationAllowlist.getUnsafeReason(judged);
	if (reason) {
		return { action: "abort", reason };
	}
	if (browserAutomationAllowlist.isAllowedHost(judged)) {
		return { action: "direct" };
	}
	return { action: "pinned" };
}

/**
 * The fetch used to relay a `pinned` request: `safeFetchOutboundPinned`
 * with browser-shaped limits — any media type, a body cap sized for pages
 * and assets, and redirects returned to the browser rather than followed.
 * The `lookup`/`dispatcher` test hooks are passed through so tests can pin
 * without a network.
 */
export type PinnedBrowserFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

export function createBrowserPinnedFetch(
	hooks: Pick<PinnedFetchOptions, "lookup" | "dispatcher"> = {},
): PinnedBrowserFetch {
	return (url, init) =>
		safeFetchOutboundPinned(url, init, {
			...hooks,
			maxBytes: BROWSER_PINNED_FETCH_MAX_BYTES,
			timeoutMs: BROWSER_PINNED_FETCH_TIMEOUT_MS,
			allowedContentTypes: [PINNED_FETCH_ANY_CONTENT_TYPE],
			followRedirects: false,
		});
}

const defaultBrowserPinnedFetch = createBrowserPinnedFetch();

/**
 * Request headers that describe the browser's own connection rather than
 * the request, and would be wrong or forbidden on the relayed one. The
 * relay negotiates its own encoding and decompresses, so the browser's
 * `accept-encoding` must not be forwarded.
 */
const REQUEST_HEADERS_NOT_RELAYED = new Set([
	"accept-encoding",
	"connection",
	"content-length",
	"expect",
	"host",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"transfer-encoding",
	"upgrade",
]);

/**
 * Response headers that described the relay's connection, not the body the
 * browser receives: the body is already decoded and its length is set by
 * `route.fulfill`.
 */
const RESPONSE_HEADERS_NOT_RELAYED = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"keep-alive",
	"transfer-encoding",
]);

/**
 * The slice of a Playwright `Route` the guard touches. Structural so unit
 * tests can hand in a plain object; a real `Route` satisfies it.
 */
type GuardableRequest = {
	url(): string;
	method(): string;
	resourceType(): string;
	isNavigationRequest(): boolean;
	/** The frame the request belongs to; Playwright throws for worker requests. */
	frame(): object;
	allHeaders(): Promise<Record<string, string>>;
	postDataBuffer(): Buffer | null;
};

/**
 * Per-context guard settings.
 *
 * `blockResourceTypes`: Playwright resource types (`image`, `stylesheet`,
 * `font`, `media`, ...) the session asked not to load. The guard aborts
 * them before deciding on a destination, so a blocked type is never relayed
 * or connected to, on declared and undeclared hosts alike.
 */
export interface OutboundRequestGuardOptions {
	blockResourceTypes?: readonly string[];
}

type GuardableRoute = {
	request(): GuardableRequest;
	abort(errorCode?: string): Promise<void>;
	fallback(): Promise<void>;
	fulfill(response: {
		status?: number;
		headers?: Record<string, string>;
		body?: string | Buffer;
	}): Promise<void>;
};

async function toRelayedRequestInit(
	request: GuardableRequest,
): Promise<RequestInit> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(await request.allHeaders())) {
		if (!REQUEST_HEADERS_NOT_RELAYED.has(name.toLowerCase())) {
			headers[name] = value;
		}
	}
	const method = request.method();
	const posted =
		method === "GET" || method === "HEAD" ? null : request.postDataBuffer();
	// A fresh Uint8Array over its own ArrayBuffer: what `fetch` accepts as a
	// body, without aliasing Playwright's buffer.
	const body = posted ? new Uint8Array(posted) : undefined;
	return { method, headers, body };
}

/**
 * A URL safe to log: origin and path only. Query strings and fragments can
 * carry tokens (signed URLs, OAuth codes), and userinfo carries credentials.
 */
export function urlForLog(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "a relayed response";
	}
}

/**
 * The `Set-Cookie` headers to hand Chromium on a fulfilled response, in
 * wire order. Partitioned cookies are dropped: Chromium stores a cookie
 * set through `route.fulfill` without its partition key, which would turn
 * it into an ordinary cookie (see `isPartitionedSetCookie`).
 */
function passableSetCookies(
	setCookies: readonly string[],
	from: string,
): string[] {
	const { kept, droppedPartitioned } = fulfillableSetCookies(setCookies);
	if (droppedPartitioned > 0) {
		console.warn(
			`[Browser] Dropped ${droppedPartitioned} Partitioned cookie(s) from ${urlForLog(from)}: Chromium cannot store them partitioned through the relay`,
		);
	}
	return kept;
}

async function toFulfillment(
	response: Response,
	setCookies: readonly string[],
): Promise<{
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		const key = name.toLowerCase();
		if (key !== "set-cookie" && !RESPONSE_HEADERS_NOT_RELAYED.has(key)) {
			headers[key] = value;
		}
	});
	// Playwright's fulfill takes one value per header name; Chromium's
	// interception splits `set-cookie` on newlines and applies each cookie
	// in order, under the request's own credentials mode.
	const cookies = passableSetCookies(setCookies, response.url);
	if (cookies.length > 0) {
		headers["set-cookie"] = cookies.join("\n");
	}
	return {
		status: response.status,
		headers,
		body: Buffer.from(await response.arrayBuffer()),
	};
}

function isDestinationRefusal(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "UNSAFE_OUTBOUND_URL"
	);
}

function isRedirectStatus(status: number): boolean {
	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	);
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function isHttpUrl(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

function withoutFragment(url: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	return parsed.toString();
}

/**
 * A navigation redirect, rewritten as a page that refreshes to the target.
 * The refresh is a new navigation, which reaches `context.route` as its own
 * request and is judged there. The redirect's cookies are kept: this
 * response is fulfilled for the URL that set them.
 */
function toRefreshFulfillment(
	redirect: Response,
	target: string,
): { status: number; headers: Record<string, string>; body: Buffer } {
	const headers: Record<string, string> = {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	};
	const cookies = passableSetCookies(
		redirect.headers.getSetCookie(),
		redirect.url,
	);
	if (cookies.length > 0) {
		headers["set-cookie"] = cookies.join("\n");
	}
	const attribute = escapeHtmlAttribute(target);
	return {
		status: 200,
		headers,
		body: Buffer.from(
			`<!doctype html><meta http-equiv="refresh" content="0;url=${attribute}"><title>Redirecting</title><a href="${attribute}">Redirecting</a>`,
		),
	};
}

/**
 * Refresh navigations each frame is part way through.
 *
 * A refresh page answers one redirect; the navigation it triggers arrives
 * as a fresh request with no memory of the chain. So when the guard serves
 * a refresh it records, per frame, the target and the number of redirects
 * so far. The frame's next navigation continues that count only if it is
 * to exactly that target within the TTL; any other navigation starts a new
 * chain. Keyed weakly on Playwright's frame object, so a closed frame's
 * entry goes with it.
 */
type PendingRefresh = { target: string; hops: number; expiresAt: number };
const pendingRefreshes = new WeakMap<object, PendingRefresh>();

function frameOf(request: GuardableRequest): object | null {
	try {
		return request.frame();
	} catch {
		return null;
	}
}

/** Redirects already taken in the chain this navigation continues, or 0. */
function takeNavigationChain(frame: object | null, url: string): number {
	if (!frame) {
		return 0;
	}
	const pending = pendingRefreshes.get(frame);
	pendingRefreshes.delete(frame);
	if (
		pending &&
		pending.expiresAt > Date.now() &&
		pending.target === withoutFragment(url)
	) {
		return pending.hops;
	}
	return 0;
}

/**
 * One deadline for everything a single intercepted request makes the relay
 * do. Each pinned fetch also has its own per-call deadline; this bounds the
 * chain as a whole, so a subresource's redirects cannot each take a fresh
 * budget. A timer rather than `AbortSignal.timeout` so it can be disposed.
 */
function createRelayDeadline(timeoutMs: number): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException(
					`Relayed request exceeded ${timeoutMs} ms`,
					"TimeoutError",
				),
			),
		timeoutMs,
	);
	return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

type RelayOutcome =
	| {
			kind: "response";
			response: Response;
			url: string;
			/** Every hop's Set-Cookie, in wire order, ready to fulfill. */
			setCookies: string[];
	  }
	| { kind: "abort"; errorCode: "blockedbyclient" | "failed" };

async function relayOnce(
	url: string,
	init: RequestInit,
	fetchPinned: PinnedBrowserFetch,
): Promise<RelayOutcome> {
	try {
		const response = await fetchPinned(url, init);
		return {
			kind: "response",
			response,
			url,
			setCookies: response.headers.getSetCookie(),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isDestinationRefusal(error)) {
			console.warn(
				`[Browser] Blocked request to ${urlForLog(String(url))}: ${message}. If this address is intended, add its host to ${BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV}.`,
			);
			return { kind: "abort", errorCode: "blockedbyclient" };
		}
		console.warn(
			`[Browser] Request to ${urlForLog(String(url))} failed: ${message}`,
		);
		return { kind: "abort", errorCode: "failed" };
	}
}

const failed = { kind: "abort", errorCode: "failed" } as const;
const blocked = { kind: "abort", errorCode: "blockedbyclient" } as const;

/**
 * Follow a subresource redirect inside the relay, under `signal`.
 *
 * Only a redirect to the request's own origin (scheme, host and port) is
 * followed; any other is refused, so the response fulfilled to Chromium is
 * always same-origin with the request it made and its CORS, opaque-response
 * and resource-taint checks still apply. Every hop must be http(s), is
 * judged by `decideBrowserRequest` and is fetched pinned. 303, and 301/302
 * after a POST, continue as GET without a body; 307/308 keep both.
 *
 * Cookies: follow-up hops send NO `Cookie` header. Chromium chose the first
 * hop's cookies by that URL's path, the request's credentials mode and its
 * SameSite context; the relay cannot re-derive that choice for another path
 * from a flat `name=value` header, so forwarding it (or cookies set by an
 * earlier hop) could send a cookie Chromium would withhold. A same-origin
 * redirect that needs its cookies on the next hop therefore arrives without
 * them — fail closed. Every hop's `Set-Cookie` is still collected in wire
 * order for the fulfilled response, with a hop's own default-path written
 * into cookies that name no `Path`, so Chromium stores them as it would
 * have, under the request's own credentials mode.
 */
async function followSubresourceRedirects(
	first: Extract<RelayOutcome, { kind: "response" }>,
	firstInit: RequestInit,
	fetchPinned: PinnedBrowserFetch,
	signal: AbortSignal,
): Promise<RelayOutcome> {
	const requestedUrl = new URL(first.url);
	let { url, response } = first;
	let init = firstInit;
	const setCookies = [...first.setCookies];
	for (let hop = 0; hop < BROWSER_RELAY_MAX_REDIRECTS; hop++) {
		const location = response.headers.get("location");
		if (!location) {
			return { kind: "response", response, url, setCookies };
		}
		const next = new URL(location, url);
		if (!isHttpUrl(next)) {
			console.warn(
				`[Browser] Blocked redirect from ${urlForLog(String(url))} to a non-http(s) URL`,
			);
			return blocked;
		}
		if (next.origin !== requestedUrl.origin) {
			console.warn(
				`[Browser] Blocked cross-origin redirect of a subresource from ${urlForLog(String(url))} to ${next.origin}: the relay cannot preserve the browser's cross-origin checks`,
			);
			return blocked;
		}
		const decision = decideBrowserRequest(next.toString());
		if (decision.action === "abort") {
			console.warn(
				`[Browser] Blocked redirect from ${urlForLog(String(url))} to ${urlForLog(next.toString())}: ${decision.reason}`,
			);
			return blocked;
		}
		if (decision.action === "direct") {
			console.warn(
				`[Browser] Redirect from ${urlForLog(String(url))} to declared host ${urlForLog(next.toString())} is not followed for a subresource`,
			);
			return failed;
		}

		const method = (init.method ?? "GET").toUpperCase();
		const switchesToGet =
			response.status === 303 ||
			((response.status === 301 || response.status === 302) &&
				method === "POST");
		const headers = new Headers(init.headers);
		// See the doc comment: the relay cannot prove which cookies Chromium
		// would send to this hop, so it sends none.
		headers.delete("cookie");
		init = {
			method: switchesToGet ? "GET" : init.method,
			headers,
			body: switchesToGet ? undefined : init.body,
			signal,
		};
		url = next.toString();
		const outcome = await relayOnce(url, init, fetchPinned);
		if (outcome.kind === "abort") {
			return outcome;
		}
		response = outcome.response;
		// This hop's cookies are fulfilled against the URL Chromium asked
		// for; pin those without a Path to the hop's own default-path.
		for (const header of outcome.setCookies) {
			setCookies.push(withHopDefaultPath(header, next));
		}
		if (!isRedirectStatus(response.status)) {
			return { kind: "response", response, url, setCookies };
		}
	}
	console.warn(
		`[Browser] More than ${BROWSER_RELAY_MAX_REDIRECTS} redirects from ${urlForLog(first.url)}`,
	);
	return failed;
}

/**
 * Answer a navigation redirect with a refresh page, or refuse it.
 * Returns the abort code, or `null` once the refresh has been fulfilled.
 */
async function refreshNavigationRedirect(
	route: GuardableRoute,
	request: GuardableRequest,
	outcome: Extract<RelayOutcome, { kind: "response" }>,
	frame: object | null,
	hopsSoFar: number,
): Promise<"blockedbyclient" | "failed" | null> {
	const { response, url } = outcome;
	const location = response.headers.get("location");
	if (!location) {
		return "failed";
	}
	const next = new URL(location, url);
	if (!isHttpUrl(next)) {
		console.warn(
			`[Browser] Blocked navigation redirect from ${urlForLog(String(url))} to a non-http(s) URL`,
		);
		return "blockedbyclient";
	}
	const method = request.method().toUpperCase();
	if (
		(response.status === 307 || response.status === 308) &&
		method !== "GET" &&
		method !== "HEAD"
	) {
		// A refresh is a GET. A 307/308 requires the method and body to be
		// replayed, which cannot be done through a refresh page; refuse
		// rather than silently turn a POST into a GET.
		console.warn(
			`[Browser] Navigation redirect ${response.status} from ${urlForLog(String(url))} would replay a ${method}; refused`,
		);
		return "failed";
	}
	const hops = hopsSoFar + 1;
	if (hops > BROWSER_RELAY_MAX_REDIRECTS) {
		console.warn(
			`[Browser] More than ${BROWSER_RELAY_MAX_REDIRECTS} redirects navigating to ${urlForLog(String(url))}`,
		);
		return "failed";
	}
	if (!frame) {
		// Without a frame the chain cannot be counted, so it is not started.
		return "failed";
	}
	const target = next.toString();
	pendingRefreshes.set(frame, {
		target: withoutFragment(target),
		hops,
		expiresAt: Date.now() + BROWSER_NAVIGATION_CHAIN_TTL_MS,
	});
	await route.fulfill(toRefreshFulfillment(response, target));
	return null;
}

/**
 * Handle one intercepted request: abort if its resource type is one the
 * session blocks or its destination is refused, fall through to whatever
 * route was registered before this one for a declared host
 * (`route.fallback`, not `route.continue`, so a handler registered earlier
 * still gets its turn), and otherwise relay it through the pinned fetch
 * and fulfill the response.
 *
 * A pinned fetch that refuses the destination (a name resolving to a
 * private address) aborts as `blockedbyclient`; any other failure — timeout,
 * body over the cap, connection error — aborts as `failed`. The browser
 * never opens its own connection on this path, and is never handed a 3xx
 * it would follow on its own (see the module comment).
 */
export async function handleGuardedRoute(
	route: GuardableRoute,
	fetchPinned: PinnedBrowserFetch = defaultBrowserPinnedFetch,
	options: OutboundRequestGuardOptions = {},
): Promise<void> {
	const request = route.request();
	const url = request.url();
	// Resource-type blocking runs first: a blocked type is aborted whatever
	// its destination, and never reaches the relay (which would otherwise
	// fulfill it before any earlier handler could refuse it).
	if (options.blockResourceTypes?.includes(request.resourceType())) {
		await route.abort("blockedbyclient");
		return;
	}
	const navigation = request.isNavigationRequest();
	const frame = navigation ? frameOf(request) : null;
	// Read (and clear) the frame's pending chain for every navigation, even
	// one refused below, so a stale entry cannot be continued later.
	const hopsSoFar = navigation ? takeNavigationChain(frame, url) : 0;

	const decision = decideBrowserRequest(url);
	if (decision.action === "abort") {
		console.warn(
			`[Browser] Blocked request to ${urlForLog(String(url))}: ${decision.reason}`,
		);
		await route.abort("blockedbyclient");
		return;
	}
	if (decision.action === "direct") {
		await route.fallback();
		return;
	}

	const deadline = createRelayDeadline(BROWSER_PINNED_FETCH_TIMEOUT_MS);
	try {
		const init = {
			...(await toRelayedRequestInit(request)),
			signal: deadline.signal,
		};
		let outcome = await relayOnce(url, init, fetchPinned);
		if (
			outcome.kind === "response" &&
			isRedirectStatus(outcome.response.status)
		) {
			if (navigation) {
				const refused = await refreshNavigationRedirect(
					route,
					request,
					outcome,
					frame,
					hopsSoFar,
				);
				if (refused) {
					await route.abort(refused);
				}
				return;
			}
			outcome = await followSubresourceRedirects(
				outcome,
				init,
				fetchPinned,
				deadline.signal,
			);
		}
		if (outcome.kind === "abort") {
			await route.abort(outcome.errorCode);
			return;
		}
		if (isRedirectStatus(outcome.response.status)) {
			// A redirect without a Location: nothing to follow, and not safe
			// to hand to Chromium as a 3xx.
			await route.abort("failed");
			return;
		}
		await route.fulfill(
			await toFulfillment(outcome.response, outcome.setCookies),
		);
	} finally {
		deadline.dispose();
	}
}

/**
 * The slice of a Playwright `WebSocketRoute` the guard touches.
 */
type GuardableWebSocketRoute = {
	url(): string;
	connectToServer(): unknown;
	close(options?: { code?: number; reason?: string }): Promise<void>;
};

/**
 * Handle one intercepted WebSocket: a declared host connects as usual;
 * anything else is closed before any connection is made, because a socket
 * cannot be relayed through the pinned fetch and Chromium must not resolve
 * and connect to an undeclared host on its own.
 */
export async function handleGuardedWebSocket(
	socket: GuardableWebSocketRoute,
): Promise<void> {
	const url = socket.url();
	const decision = decideBrowserRequest(url);
	if (decision.action === "direct") {
		socket.connectToServer();
		return;
	}
	const reason =
		decision.action === "abort"
			? decision.reason
			: `WebSocket connections are only made to hosts declared in ${BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV}`;
	console.warn(
		`[Browser] Blocked WebSocket to ${urlForLog(String(url))}: ${reason}`,
	);
	await socket.close({ code: 1008, reason: "Blocked by outbound guard" });
}

/**
 * Install the request guard on a browser context. Register it after any
 * other `context.route` call: Playwright runs handlers in reverse
 * registration order, so the guard registered last is the one that sees
 * every request first. The context must also be created with
 * `serviceWorkers: "block"`, since a service worker's fetches bypass
 * `context.route`.
 */
export async function installOutboundRequestGuard(
	context: Pick<BrowserContext, "route" | "routeWebSocket">,
	fetchPinned: PinnedBrowserFetch = defaultBrowserPinnedFetch,
	options: OutboundRequestGuardOptions = {},
): Promise<void> {
	await context.route("**/*", (route) =>
		handleGuardedRoute(route, fetchPinned, options),
	);
	await context.routeWebSocket(
		() => true,
		(socket) => handleGuardedWebSocket(socket),
	);
}
