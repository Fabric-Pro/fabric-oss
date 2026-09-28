/**
 * Deterministic, SSRF-safe extraction of a logo and brand colours from a
 * recipient's website.
 *
 * Every request goes through `safeFetchOutboundPinned`, which resolves the
 * host, refuses any private answer and pins the socket to the validated
 * address. Redirects are followed HERE, one hop at a time, so each hop
 * re-enters the pinned fetch with its own content-type allowlist and this
 * module always knows the URL a body was really served from. On top of the
 * pinned guard: GET only, ports 80 and 443 only, no credentials in a URL,
 * one deadline for the whole extraction, and at most three logo candidates.
 *
 * Failures are fixed codes and nothing else: no hostname, resolver message
 * or upstream text ever leaves this module, because the result is shown to
 * the editor and recorded in the audit log. `blocked` is only ever decided
 * from the URL itself; a refusal that depends on what a name resolved to
 * reads as `unreachable`, like a name that does not resolve at all, so the
 * code tells no one what the server's resolver knows.
 *
 * The per-user rate limit is applied by the calling procedure
 * (`WEBSITE_BRAND_RATE_LIMIT`), which owns the shared rate-limit store.
 */
import { isIP } from "node:net";
import { normalizeHexColor, relativeLuminance } from "@repo/utils/brand-colors";
import {
	getUnsafeUrlReason,
	isPrivateIp,
	safeFetchOutboundPinned,
} from "@repo/utils/url-security";
import {
	extractHeadCandidates,
	extractManifestCandidates,
	HEAD_SCAN_MAX_CHARS,
	type LogoCandidate,
	orderLogoCandidates,
} from "./extract-candidates";
import { LOGO_MAX_INPUT_BYTES, normalizeLogo } from "./normalize-logo";

export const WEBSITE_BRAND_FAILURE_CODES = [
	"unreachable",
	"blocked",
	"too_large",
	"unsupported",
	"no_logo",
] as const;

export type WebsiteBrandFailureCode =
	(typeof WEBSITE_BRAND_FAILURE_CODES)[number];

export type WebsiteBrandResult =
	| {
			ok: true;
			/** Normalized PNG, at most 512px on its longest edge. */
			logoPng: Buffer;
			/** Up to three `#rrggbb` colours, most authoritative first. */
			colors: string[];
			/** Host of the page after redirects. */
			finalHost: string;
	  }
	| {
			ok: false;
			code: WebsiteBrandFailureCode;
			/** Colours found before the failure (a `no_logo` site may have some). */
			colors: string[];
	  };

/** One deadline for the page, the manifest and every logo candidate. */
const WEBSITE_BRAND_DEADLINE_MS = 15_000;
const WEBSITE_BRAND_MAX_LOGO_CANDIDATES = 3;
const WEBSITE_BRAND_MAX_REDIRECTS = 3;
const MAX_COLORS = 3;

/**
 * Per-user limit the calling procedure applies with the shared rate limiter
 * before starting an extraction.
 */
export const WEBSITE_BRAND_RATE_LIMIT = {
	limit: 10,
	windowMs: 10 * 60_000,
} as const;

export function websiteBrandRateLimitKey(userId: string): string {
	return `website-brand:${userId}`;
}

type HopKind = "page" | "manifest" | "logo";

/**
 * What each kind of hop may receive. The pinned fetch's default allowlist
 * has no HTML or images on purpose, so every hop names its own.
 */
const HOP_POLICY: Record<
	HopKind,
	{ contentTypes: string[]; maxBytes: number; accept: string }
> = {
	page: {
		contentTypes: ["text/html", "application/xhtml+xml"],
		maxBytes: 5 * 1024 * 1024,
		accept: "text/html,application/xhtml+xml;q=0.9",
	},
	manifest: {
		contentTypes: ["application/manifest+json", "application/json"],
		maxBytes: 256 * 1024,
		accept: "application/manifest+json,application/json;q=0.9",
	},
	logo: {
		contentTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
		maxBytes: LOGO_MAX_INPUT_BYTES,
		accept: "image/png,image/webp,image/jpeg,image/gif;q=0.9",
	},
};

const USER_AGENT = "Mozilla/5.0 (compatible; Fabric-BrandFetch/1.0)";

export type PinnedFetch = typeof safeFetchOutboundPinned;

export interface FetchWebsiteBrandOptions {
	/** Caller cancellation; the extraction also stops at its own deadline. */
	signal?: AbortSignal;
	/** Test hook: a shorter deadline. */
	timeoutMs?: number;
	/** Test hook: the pinned fetch. Never pass this from production code. */
	fetch?: PinnedFetch;
}

interface ExtractionContext {
	fetch: PinnedFetch;
	signal: AbortSignal;
	deadlineAt: number;
}

type HopResult =
	| { ok: true; bytes: Uint8Array; finalUrl: URL }
	| { ok: false; code: WebsiteBrandFailureCode };

type ParsedWebsite =
	| { ok: true; url: string }
	| { ok: false; code: WebsiteBrandFailureCode };

function isAllowedPort(url: URL): boolean {
	// The URL parser drops a scheme's default port, so "" is 80 or 443.
	return url.port === "" || url.port === "80" || url.port === "443";
}

function isFetchableUrl(url: URL): boolean {
	return (
		(url.protocol === "https:" || url.protocol === "http:") &&
		isAllowedPort(url) &&
		url.username === "" &&
		url.password === ""
	);
}

function parseWebsite(input: string): ParsedWebsite {
	const trimmed = input.trim();
	if (!trimmed || trimmed.length > 2048) {
		return { ok: false, code: "unreachable" };
	}
	// "example.com" and "example.com/about" get a scheme; "mailto:" or
	// "javascript:" keep theirs and are refused below.
	const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
	const schemeOnly = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(trimmed);
	if (!hasScheme && schemeOnly) {
		return { ok: false, code: "blocked" };
	}
	let url: URL;
	try {
		url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
	} catch {
		return { ok: false, code: "unreachable" };
	}
	if (!isFetchableUrl(url)) {
		return { ok: false, code: "blocked" };
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!hostname) {
		return { ok: false, code: "unreachable" };
	}
	return { ok: true, url: `https://${hostname}` };
}

/**
 * The website as it is fetched, stored and audited: `https://host`, with no
 * path, query, port or credentials. `null` when the input cannot name a
 * public website (another scheme, credentials, a port other than 80/443).
 */
export function normalizeWebsiteUrl(input: string): string | null {
	const parsed = parseWebsite(input);
	return parsed.ok ? parsed.url : null;
}

/** Reject with the signal's reason if it aborts before `promise` settles. */
function settleBefore<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		promise.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * The pinned guard's refusals that need no DNS: the literal URL check
 * (scheme, local and metadata names, unsafe literal addresses) and a literal
 * private IP. A hop refused here is `blocked` without being fetched, so every
 * refusal the guard raises after this depends on DNS.
 */
function isRefusedWithoutDns(url: URL): boolean {
	if (getUnsafeUrlReason(url.toString()) !== null) {
		return true;
	}
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	return isIP(host) !== 0 && isPrivateIp(host);
}

function classifyFetchError(error: unknown): WebsiteBrandFailureCode {
	const { code } = (error ?? {}) as { code?: unknown };
	if (code === "RESPONSE_TOO_LARGE") {
		return "too_large";
	}
	if (code === "CONTENT_TYPE_NOT_ALLOWED") {
		return "unsupported";
	}
	// A guard refusal (UNSAFE_OUTBOUND_URL) past `isRefusedWithoutDns` came
	// from DNS: a private answer or none. Reporting it as `blocked` would tell
	// the editor which names the server's resolver maps to private addresses
	// (a DNS oracle), so it reads as a name that does not resolve. The same
	// goes for timeouts, aborts, refused connections, TLS failures and too
	// many redirects.
	return "unreachable";
}

function isRedirect(status: number): boolean {
	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	);
}

/**
 * GET `startUrl`, following at most `WEBSITE_BRAND_MAX_REDIRECTS` redirects.
 * Each hop is checked for scheme, port, credentials and a refusal decided
 * without DNS, and then fetched through the pinned guard with redirects
 * disabled, so the guard re-resolves and re-validates every host along the way.
 */
async function fetchFollowingRedirects(
	startUrl: string,
	kind: HopKind,
	context: ExtractionContext,
): Promise<HopResult> {
	const policy = HOP_POLICY[kind];
	let current = startUrl;
	for (let hop = 0; hop <= WEBSITE_BRAND_MAX_REDIRECTS; hop++) {
		let url: URL;
		try {
			url = new URL(current);
		} catch {
			return { ok: false, code: "unreachable" };
		}
		if (!isFetchableUrl(url) || isRefusedWithoutDns(url)) {
			return { ok: false, code: "blocked" };
		}
		const remainingMs = context.deadlineAt - Date.now();
		if (remainingMs <= 0 || context.signal.aborted) {
			return { ok: false, code: "unreachable" };
		}

		let response: Response;
		try {
			response = await settleBefore(
				context.fetch(
					url.toString(),
					{
						method: "GET",
						headers: {
							accept: policy.accept,
							"user-agent": USER_AGENT,
						},
						signal: context.signal,
					},
					{
						allowedContentTypes: policy.contentTypes,
						maxBytes: policy.maxBytes,
						timeoutMs: remainingMs,
						followRedirects: false,
						maxRedirects: 0,
					},
				),
				context.signal,
			);
		} catch (error) {
			return { ok: false, code: classifyFetchError(error) };
		}

		if (isRedirect(response.status)) {
			const location = response.headers.get("location");
			if (!location) {
				return { ok: false, code: "unreachable" };
			}
			try {
				current = new URL(location, url).toString();
			} catch {
				return { ok: false, code: "unreachable" };
			}
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			return { ok: false, code: "unreachable" };
		}
		try {
			const bytes = new Uint8Array(
				await settleBefore(response.arrayBuffer(), context.signal),
			);
			return { ok: true, bytes, finalUrl: url };
		} catch {
			return { ok: false, code: "unreachable" };
		}
	}
	return { ok: false, code: "unreachable" };
}

/** Near-white cannot carry a heading or a chart series on a white page. */
function isUsableBrandColor(hex: string): boolean {
	return relativeLuminance(hex) < 0.9;
}

function collectColors(...groups: string[][]): string[] {
	const colors: string[] = [];
	for (const group of groups) {
		for (const value of group) {
			const hex = normalizeHexColor(value);
			if (hex && isUsableBrandColor(hex) && !colors.includes(hex)) {
				colors.push(hex);
			}
		}
	}
	return colors.slice(0, MAX_COLORS);
}

async function readManifest(
	manifestUrl: string,
	context: ExtractionContext,
): Promise<{ icon: LogoCandidate | null; themeColors: string[] }> {
	const none = { icon: null, themeColors: [] };
	const fetched = await fetchFollowingRedirects(
		manifestUrl,
		"manifest",
		context,
	);
	if (!fetched.ok) {
		return none;
	}
	try {
		const parsed: unknown = JSON.parse(
			new TextDecoder().decode(fetched.bytes),
		);
		return extractManifestCandidates(parsed, fetched.finalUrl);
	} catch {
		return none;
	}
}

/**
 * Fetch a website's logo and brand colours.
 *
 * Colours come from `theme-color` and the manifest, and otherwise from the
 * logo's dominant colour. Logo candidates are tried in order — the
 * apple-touch-icon, the largest sized icon, the largest manifest icon, then
 * `og:image`, skipping SVG and ICO — and the first that normalizes wins.
 */
export async function fetchWebsiteBrand(
	website: string,
	options: FetchWebsiteBrandOptions = {},
): Promise<WebsiteBrandResult> {
	const parsed = parseWebsite(website);
	if (!parsed.ok) {
		return { ok: false, code: parsed.code, colors: [] };
	}

	const timeoutMs = options.timeoutMs ?? WEBSITE_BRAND_DEADLINE_MS;
	const signals = [AbortSignal.timeout(timeoutMs)];
	if (options.signal) {
		signals.push(options.signal);
	}
	const context: ExtractionContext = {
		fetch: options.fetch ?? safeFetchOutboundPinned,
		signal: AbortSignal.any(signals),
		deadlineAt: Date.now() + timeoutMs,
	};

	const page = await fetchFollowingRedirects(parsed.url, "page", context);
	if (!page.ok) {
		return { ok: false, code: page.code, colors: [] };
	}
	// Only the head matters, so only the leading bytes are decoded. Icon URLs
	// and hex colours are ASCII, so UTF-8 reads them in any ASCII-compatible
	// charset.
	const html = new TextDecoder().decode(
		page.bytes.subarray(0, HEAD_SCAN_MAX_CHARS),
	);
	const head = extractHeadCandidates(html, page.finalUrl);
	const manifest = head.manifestUrl
		? await readManifest(head.manifestUrl, context)
		: { icon: null, themeColors: [] };
	const colors = collectColors(head.themeColors, manifest.themeColors);

	const candidates = orderLogoCandidates(
		{
			appleTouchIcon: head.appleTouchIcon,
			icon: head.icon,
			manifestIcon: manifest.icon,
			ogImage: head.ogImage,
		},
		WEBSITE_BRAND_MAX_LOGO_CANDIDATES,
	);

	// The best candidate's failure is the one reported if none succeeds.
	let firstFailure: WebsiteBrandFailureCode | null = null;
	for (const candidate of candidates) {
		const fetched = await fetchFollowingRedirects(
			candidate.url,
			"logo",
			context,
		);
		if (!fetched.ok) {
			firstFailure ??= fetched.code;
			continue;
		}
		const logo = await normalizeLogo(fetched.bytes);
		if (!logo.ok) {
			firstFailure ??= logo.code;
			continue;
		}
		return {
			ok: true,
			logoPng: logo.png,
			colors:
				colors.length > 0
					? colors
					: collectColors(
							logo.dominantColor ? [logo.dominantColor] : [],
						),
			finalHost: page.finalUrl.hostname,
		};
	}
	return { ok: false, code: firstFailure ?? "no_logo", colors };
}
